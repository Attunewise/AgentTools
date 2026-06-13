const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  gitPath,
  renderWorktreeCompact,
  safeSnapshotWorktree,
  snapshotWorktree
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
