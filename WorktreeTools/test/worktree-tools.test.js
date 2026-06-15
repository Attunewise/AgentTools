const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const {
  gitPath,
  renderWorktreeCompact,
  safeSnapshotWorktree,
  snapshotWorktree,
  worktreeGuard
} = require('../src/index.js')
const { WorktreeServerState } = require('../src/server.js')

const git = (cwd, args) => childProcess.execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
})

const makeRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-tools-'))
  git(root, ['init'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test User'])
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-m', 'initial'])
  return root
}

test('snapshots staged state and renders compact model output', () => {
  const root = makeRepo()
  try {
    fs.writeFileSync(path.join(root, 'src.js'), 'module.exports = 1\n')
    git(root, ['add', 'src.js'])
    const snapshot = snapshotWorktree(root)
    assert.equal(fs.realpathSync(snapshot.root), fs.realpathSync(root))
    assert.match(snapshot.worktree_id, /^sha256:/)
    assert.equal(snapshot.is_linked_worktree, false)
    assert.equal(snapshot.staged_file_count, 1)
    assert.match(snapshot.staged_change_fingerprint, /^sha256:/)
    assert.match(renderWorktreeCompact(snapshot), /^ok repo=.* branch=(master|main) staged=1 dirty=1/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolves linked worktree private git paths', () => {
  const root = makeRepo()
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-tools-linked-'))
  fs.rmSync(worktree, { recursive: true, force: true })
  try {
    git(root, ['worktree', 'add', '-b', `wt-${process.pid}`, worktree])
    fs.writeFileSync(path.join(worktree, 'linked.js'), 'module.exports = 2\n')
    git(worktree, ['add', 'linked.js'])
    const snapshot = snapshotWorktree(worktree)
    assert.equal(snapshot.is_linked_worktree, true)
    assert.notEqual(snapshot.worktree_id, snapshotWorktree(root).worktree_id)
    assert.notEqual(snapshot.git_dir, snapshot.common_git_dir)
    assert.match(gitPath(worktree, 'agentdoc/last-check.json'), /[\\/]worktrees[\\/]/)
    assert.equal(snapshot.staged_file_count, 1)
  } finally {
    try {
      git(root, ['worktree', 'remove', worktree, '--force'])
    } catch (_) {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree guard checks identity without duplicating dirty state', () => {
  const root = makeRepo()
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-tools-guard-linked-'))
  fs.rmSync(worktree, { recursive: true, force: true })
  try {
    git(root, ['worktree', 'add', '-b', `guard-${process.pid}`, worktree])
    fs.writeFileSync(path.join(root, 'dirty.js'), 'module.exports = 1\n')

    const rootSnapshot = snapshotWorktree(root)
    const match = worktreeGuard({
      workdir: root,
      expected_worktree_id: rootSnapshot.worktree_id,
      intent: 'write'
    })
    assert.equal(match.ok, true)
    assert.equal(match.status, 'matched')
    assert.deepEqual(Object.keys(match.actual).sort(), ['repo', 'source', 'worktree_id'])
    assert.equal(Object.hasOwn(match.actual, 'dirty'), false)
    assert.equal(Object.hasOwn(match.actual, 'staged_file_count'), false)

    const mismatch = worktreeGuard({
      workdir: worktree,
      expected_worktree_id: rootSnapshot.worktree_id,
      intent: 'write'
    })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.reason, 'worktree_mismatch')
    assert.notEqual(mismatch.actual.worktree_id, mismatch.expected.worktree_id)
  } finally {
    try {
      git(root, ['worktree', 'remove', worktree, '--force'])
    } catch (_) {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('safe snapshot and server state do not throw for non-repositories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-tools-not-git-'))
  try {
    const result = safeSnapshotWorktree(dir)
    assert.equal(result.ok, false)
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'not_git_repo')

    const state = new WorktreeServerState({ watch: false })
    const snapshot = state.snapshot(dir)
    assert.equal(snapshot.ok, false)
    assert.equal(state.status().cached_worktree_count, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP worktree_status returns only compact entry-point data', async () => {
  const root = makeRepo()
  try {
    fs.writeFileSync(path.join(root, 'README.md'), '# Changed\n')
    git(root, ['add', 'README.md'])

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '..', 'bin', 'worktree-mcp.js')],
      cwd: root,
      stderr: 'pipe'
    })
    const client = new Client({ name: 'worktree-tools-test', version: '0.1.0' })
    await client.connect(transport)
    try {
      const listed = await client.listTools()
      assert.ok(listed.tools.some(tool => tool.name === 'worktree_status'))
      assert.ok(listed.tools.some(tool => tool.name === 'worktree_guard'))
      const result = await client.callTool({
        name: 'worktree_status',
        arguments: { workdir: root }
      })
      assert.match(result.content[0].text, /^ok repo=/)
      const entry = result.structuredContent.result
      assert.equal(fs.realpathSync(entry.repo), fs.realpathSync(root))
      assert.match(entry.worktree_id, /^sha256:/)
      assert.equal(entry.staged_file_count, 1)
      assert.match(entry.staged_change_fingerprint, /^sha256:/)
      assert.equal(Object.hasOwn(entry, 'diff'), false)
      assert.equal(Object.hasOwn(entry, 'git_dir'), false)
      assert.equal(Object.hasOwn(entry, 'private_paths'), false)

      const guard = await client.callTool({
        name: 'worktree_guard',
        arguments: {
          workdir: root,
          expected_worktree_id: entry.worktree_id,
          intent: 'test-write'
        }
      })
      assert.match(guard.content[0].text, /^matched id=/)
      assert.equal(guard.structuredContent.result.ok, true)
      assert.equal(Object.hasOwn(guard.structuredContent.result.actual, 'dirty'), false)
    } finally {
      await client.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
