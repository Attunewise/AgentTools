const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { installHook, prepareReview, recordCheck, verifyGate } = require('../src/agentdoc.js')
const { AgentDocServerState, scanCodexSessionTail } = require('../src/server.js')

const git = (cwd, args) => childProcess.execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
})

const write = (root, rel, text) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const makeRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdoc-test-'))
  git(root, ['init'])
  git(root, ['config', 'user.email', 'agentdoc@example.test'])
  git(root, ['config', 'user.name', 'AgentDoc Test'])
  write(root, 'README.md', '# Test\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-m', 'initial'])
  return root
}

const cleanup = root => fs.rmSync(root, { recursive: true, force: true })

test('gate rejects missing checks with tiny output message', () => {
  const root = makeRepo()
  try {
    write(root, 'src/parser.js', 'module.exports = 1\n')
    git(root, ['add', 'src/parser.js'])
    assert.throws(() => verifyGate({ workdir: root }), /AgentDoc required/)
  } finally {
    cleanup(root)
  }
})

test('check stamps the exact staged fingerprint and gate rejects later staged changes', () => {
  const root = makeRepo()
  try {
    write(root, 'src/parser.js', 'module.exports = 1\n')
    git(root, ['add', 'src/parser.js'])
    const stamped = recordCheck({
      workdir: root,
      result: 'docs-current',
      noDocsNeeded: true
    })
    assert.equal(stamped, 'AgentDoc stamped: docs-current')
    assert.equal(verifyGate({ workdir: root }), null)

    write(root, 'src/parser.js', 'module.exports = 2\n')
    git(root, ['add', 'src/parser.js'])
    assert.throws(() => verifyGate({ workdir: root }), /AgentDoc stale: staged fingerprint changed/)
  } finally {
    cleanup(root)
  }
})

test('allowing a commit requires an explicit review assertion', () => {
  const root = makeRepo()
  try {
    write(root, 'src/parser.js', 'module.exports = 1\n')
    git(root, ['add', 'src/parser.js'])
    assert.throws(() => recordCheck({
      workdir: root,
      result: 'docs-current'
    }), /requires reviewed, updated, or noDocsNeeded/)
  } finally {
    cleanup(root)
  }
})

test('prepare maps staged files to scoped doc sections without printing the report', () => {
  const root = makeRepo()
  try {
    write(root, 'Compiler.md', '# Compiler\n\n- [Frontend](Compiler.doc/compiler-frontend-design.md)\n')
    write(root, 'Compiler.doc/compiler-frontend-design.md', `---
id: compiler.frontend.design
title: Compiler frontend design
scope:
  paths:
    - src/compiler/frontend/**
---

# Compiler Frontend Design

The frontend parses source files.
`)
    write(root, 'src/compiler/frontend/parser.js', 'module.exports = 1\n')
    git(root, ['add', 'Compiler.md', 'Compiler.doc/compiler-frontend-design.md', 'src/compiler/frontend/parser.js'])

    const output = prepareReview({ workdir: root })
    assert.match(output, /^AgentDoc review: /)
    assert.doesNotMatch(output, /Compiler Frontend Design/)

    const reportPath = git(root, ['rev-parse', '--git-path', 'agentdoc/review.json']).trim()
    const absReport = path.isAbsolute(reportPath) ? reportPath : path.join(root, reportPath)
    const report = JSON.parse(fs.readFileSync(absReport, 'utf8'))
    const affected = report.affected.find(item => item.path === 'src/compiler/frontend/parser.js')
    assert.equal(affected.docs.length, 1)
    assert.equal(affected.docs[0].path, 'Compiler.doc/compiler-frontend-design.md')
    assert.deepEqual(report.uncovered_source_files, [])
  } finally {
    cleanup(root)
  }
})

test('install-hook writes a pre-commit gate script', async () => {
  const root = makeRepo()
  try {
    const output = installHook({ workdir: root, hook: 'pre-commit' })
    assert.equal(output, 'AgentDoc hook installed: pre-commit')
    const hookPath = git(root, ['rev-parse', '--git-path', 'hooks/pre-commit']).trim()
    const absHook = path.isAbsolute(hookPath) ? hookPath : path.join(root, hookPath)
    assert.match(fs.readFileSync(absHook, 'utf8'), /agentdoc-hook\.js"/)
  } finally {
    cleanup(root)
  }
})

test('server binds AgentDoc session marker to Codex session and resolved repo', () => {
  const root = makeRepo()
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdoc-codex-sessions-'))
  const realRoot = fs.realpathSync(root)
  try {
    write(root, 'AgentDoc.md', '# AgentDoc\n\n- [Workflow](AgentDoc.doc/workflow.md)\n')
    write(root, 'AgentDoc.doc/workflow.md', `---
id: agentdoc.workflow
title: AgentDoc workflow
scope:
  paths:
    - src/**
---

# AgentDoc Workflow
`)
    write(root, 'src/index.js', 'module.exports = 1\n')
    git(root, ['add', 'AgentDoc.md', 'AgentDoc.doc/workflow.md', 'src/index.js'])

    const state = new AgentDocServerState({
      watch: false,
      codexSessionRoot: codexRoot
    })
    const started = state.startAgentDocSession()
    const sessionFile = path.join(codexRoot, '2026', '06', '13', 'rollout-agentdoc.jsonl')
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session-1', cwd: root } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: root, workspace_roots: [root] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: `started ${started.marker}` } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'agentdoc_prepare_review', arguments: '{}' } }),
      ''
    ].join('\n'))

    const scanned = scanCodexSessionTail(sessionFile)
    assert.equal(scanned.codex_session_id, 'codex-session-1')
    assert.equal(fs.realpathSync(scanned.current_repository.root), realRoot)
    assert.equal(scanned.agentdoc_events.length, 1)
    assert.equal(scanned.agentdoc_events[0].kind, 'prepare-review')

    const review = state.prepareReview({ agentdoc_session_id: started.agentdoc_session_id })
    assert.equal(fs.realpathSync(review.repository.root), realRoot)
    const checked = state.recordCheck({
      agentdoc_session_id: started.agentdoc_session_id,
      result: 'docs-current',
      reviewed: ['AgentDoc.doc/workflow.md']
    })
    assert.equal(checked.repository.stamp.status.matches_staged, true)

    const snapshot = state.refresh('test')
    assert.equal(snapshot.sessions.length, 1)
    assert.equal(snapshot.sessions[0].codex_session.codex_session_id, 'codex-session-1')
    assert.equal(fs.realpathSync(snapshot.sessions[0].codex_session.current_repository.root), realRoot)
  } finally {
    cleanup(root)
    fs.rmSync(codexRoot, { recursive: true, force: true })
  }
})
