#!/usr/bin/env node

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  analyzeCodexSessionFile,
  walkJsonlFiles
} = require('codex-session-tools')
const { ExpectTool } = require('../../Expect/src/expectTool.js')
const { installHook } = require('../src/agentdoc.js')

const REPO_ROOT = path.resolve(__dirname, '..')
const AGENTDOC_MCP = path.join(REPO_ROOT, 'bin', 'agentdoc-mcp.js')
const CODEX_TIMEOUT_MS = Number(process.env.AGENTDOC_CODEX_TIMEOUT_MS || 10 * 60 * 1000)
const CODEX_SESSION_ROOT = path.join(os.homedir(), '.codex', 'sessions')
const CODEX_LOG_DIR = process.env.AGENTDOC_CODEX_LOG_DIR || path.join(os.tmpdir(), 'agentdoc-codex-cli-logs')

const run = (cmd, args, cwd, options = {}) => childProcess.execFileSync(cmd, args, {
  cwd,
  encoding: options.encoding || 'utf8',
  stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ...(options.env || {})
  }
})

const write = (root, rel, text) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const makeFixtureRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdoc-codex-cli-'))
  run('git', ['init'], root)
  run('git', ['config', 'user.email', 'agentdoc-codex@example.test'], root)
  run('git', ['config', 'user.name', 'AgentDoc Codex Test'], root)

  write(root, 'src/calc.js', `function multiply(a, b) {
  return a * b
}

module.exports = { multiply }
`)
  write(root, 'Math.md', `# Math

- [Calculator behavior](Math.doc/calculator-behavior.md)
`)
  write(root, 'Math.doc/calculator-behavior.md', `---
id: math.calculator.behavior
title: Calculator behavior
scope:
  paths:
    - src/calc.js
---

# Calculator Behavior

\`multiply(a, b)\` returns the product of \`a\` and \`b\`.
`)
  write(root, 'AGENTS.md', `# Test Instructions

This repository uses AgentDoc.

For this test, after changing code, first attempt the git commit before using AgentDoc. If the commit is rejected by AgentDoc, inspect the relevant documentation, update it if needed, call the AgentDoc MCP tools to record the check, and retry the commit.
`)

  run('git', ['add', '.'], root)
  run('git', ['commit', '-m', 'initial fixture'], root)

  installHook({ workdir: root })
  const hook = path.join(root, '.git', 'hooks', 'pre-commit')
  const hookTarget = path.join(REPO_ROOT, 'bin', 'agentdoc-hook.js')
  fs.writeFileSync(hook, `#!/bin/sh
set +e
node ${JSON.stringify(hookTarget)}
status=$?
if [ "$status" -ne 0 ]; then
  mkdir -p .git/agentdoc
  printf '%s\\n' "failed:$status" >> .git/agentdoc/hook-failures.log
  exit "$status"
fi
exit 0
`)
  fs.chmodSync(hook, 0o755)
  return root
}

const codexCommand = root => {
  const prompt = `
You are running an AgentDoc integration test in this temporary git repository.

Task:
1. Call the AgentDoc MCP tool agentdoc_start_session and remember the returned agentdoc_session_id.
2. Change src/calc.js so multiply(a, b) returns double the product.
3. Stage the code change and attempt to git commit with message "double multiply result" before calling agentdoc_prepare_review or agentdoc_record_check.
4. When the AgentDoc pre-commit hook rejects that first commit, call agentdoc_prepare_review with only the agentdoc_session_id. Do not pass a workdir to AgentDoc MCP tools; AgentDoc must resolve this repository from the Codex session marker. Inspect the affected documentation, update it if needed, call agentdoc_record_check with only the same agentdoc_session_id plus the review result for the exact staged state, and retry the commit.
5. Do not skip the commit. Finish only after git log shows the new commit.
`.trim()

  return [
    'env',
    'TERM=xterm-256color',
    'codex',
    '--no-alt-screen',
    '--cd', root,
    '--sandbox', 'danger-full-access',
    '--ask-for-approval', 'never',
    '-c', `projects.${JSON.stringify(root)}.trust_level="trusted"`,
    '-c', `mcp_servers.agentdoc.command="node"`,
    '-c', `mcp_servers.agentdoc.args=[${JSON.stringify(AGENTDOC_MCP)}]`,
    prompt
  ]
}

const runCodexWithExpect = async root => {
  const [command, ...args] = codexCommand(root)
  const shellCmd = [command, ...args.map(arg => JSON.stringify(arg))].join(' ')
  const logPath = path.join(CODEX_LOG_DIR, `${path.basename(root)}.pty.log`)
  const tool = new ExpectTool()
  const spawned = await tool.spawn({
    cmd: shellCmd,
    workdir: root,
    cols: 120,
    rows: 40,
    log_path: logPath
  })
  const deadline = Date.now() + CODEX_TIMEOUT_MS
  let lastResult = null
  try {
    while (Date.now() < deadline) {
      lastResult = await tool.eval({
        session_id: spawned.session_id,
        max_output_chars: 120000,
        script: `
set timeout 5
expect {
  -re {Do[\\s\\S]*trust[\\s\\S]*directory} {
    js {
      if (!context.acceptedTrust) {
        context.acceptedTrust = true
        send("\\r")
      }
    }
    exp_continue
  }
  -re {Continue anyway\\? \\[y/N\\]:} {
    js {
      send("y\\r")
    }
    exp_continue
  }
  eof {
    js {
      return { ok: false, eof: true }
    }
  }
  timeout {
    js {
      return { ok: false, timeout: true }
    }
  }
}
`
      })
      if (repoStateOk(root)) return {
        result: {
          ok: true,
          sawRepoSuccess: true
        },
        log_path: logPath,
        transcript: lastResult.transcript,
        remainingBuffer: lastResult.remainingBuffer
      }
      if (lastResult.result && lastResult.result.eof) break
    }
    throw new Error(`Timed out waiting for Codex AgentDoc test completion. Last buffer:\n${lastResult ? lastResult.remainingBuffer : ''}`)
  } finally {
    await tool.close({ session_id: spawned.session_id })
  }
}

const repoStateOk = root => {
  try {
    assertFinalRepoState(root)
    return true
  } catch (_) {
    return false
  }
}

const assertFinalRepoState = root => {
  const log = run('git', ['log', '--oneline', '-2'], root)
  assert.match(log, /double multiply result/)
  assert.match(read(root, 'src/calc.js'), /return a \* b \* 2|return 2 \* a \* b|return \(a \* b\) \* 2/)
  assert.match(read(root, 'Math.doc/calculator-behavior.md'), /double|twice|2x|two times/i)

  const failures = read(root, '.git/agentdoc/hook-failures.log')
  assert.match(failures, /failed:/)
  const stamp = JSON.parse(read(root, '.git/agentdoc/last-check.json'))
  assert.equal(stamp.result, 'docs-updated')
  assert.deepEqual(stamp.updated_docs, ['Math.doc/calculator-behavior.md'])
}

const assertAgentDocCallsUsedSessionResolution = root => {
  const realRoot = fs.realpathSync(root)
  const sessions = walkJsonlFiles(CODEX_SESSION_ROOT)
    .slice(0, 100)
    .map(item => analyzeCodexSessionFile(item.file, {
      matchTerm: ['agentdoc_']
    }))
    .filter(Boolean)
  const session = sessions.find(item => {
    const usedRoot = (item.path_events || []).some(event => {
      try {
        return fs.existsSync(event.path) && fs.realpathSync(event.path) === realRoot
      } catch (_) {
        return false
      }
    })
    const usedAgentDoc = (item.tool_calls || []).some(call => call.name.startsWith('agentdoc_'))
    return usedRoot && usedAgentDoc
  })
  assert.ok(session, 'expected to find the Codex session that used AgentDoc in the fixture repository')

  const agentdocCalls = session.tool_calls.filter(call => call.name.startsWith('agentdoc_'))
  assert.ok(agentdocCalls.some(call => call.name === 'agentdoc_start_session'))
  const scopedCalls = agentdocCalls.filter(call => ['agentdoc_prepare_review', 'agentdoc_record_check'].includes(call.name))
  assert.ok(scopedCalls.length >= 2, 'expected AgentDoc prepare/review calls in the Codex session log')
  assert.deepEqual(scopedCalls.filter(call => call.workdir || call.cwd), [])
}

const main = async () => {
  if (!fs.existsSync(AGENTDOC_MCP)) throw new Error(`missing AgentDoc MCP entrypoint: ${AGENTDOC_MCP}`)
  run('codex', ['--version'], process.cwd())

  const root = makeFixtureRepo()
  console.log(`AgentDoc Codex CLI fixture: ${root}`)
  try {
    const result = await runCodexWithExpect(root)
    assert.equal(result.result && result.result.ok, true)
    assert.equal(Boolean(result.result && result.result.sawRepoSuccess), true)
    assert.ok(fs.existsSync(result.log_path))
    assertFinalRepoState(root)
    assertAgentDocCallsUsedSessionResolution(root)
    console.log(`AgentDoc Codex CLI transcript: ${result.log_path}`)
    console.log('AgentDoc Codex CLI integration passed')
  } catch (err) {
    console.error(`Fixture retained for debugging: ${root}`)
    throw err
  }
  if (!process.env.AGENTDOC_KEEP_CODEX_FIXTURE) fs.rmSync(root, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
