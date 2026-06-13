const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const NULL_HEAD = '0'.repeat(40)

const normalizePath = value => String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

const runGit = (args, cwd, options = {}) => {
  try {
    return childProcess.execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: options.encoding || 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : ''
    const error = new Error(stderr || `git ${args.join(' ')} failed`)
    error.code = 'GIT_FAILED'
    error.gitArgs = args
    error.cwd = cwd || process.cwd()
    throw error
  }
}

const absoluteGitPath = (root, value) => path.isAbsolute(value) ? value : path.resolve(root, value)

const gitPath = (root, rel) => {
  const value = runGit(['rev-parse', '--git-path', rel], root).trim()
  return absoluteGitPath(root, value)
}

const currentHead = root => {
  try {
    return runGit(['rev-parse', '--verify', 'HEAD'], root).trim()
  } catch (_) {
    return NULL_HEAD
  }
}

const currentBranch = root => {
  try {
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim()
    return branch === 'HEAD' ? null : branch
  } catch (_) {
    return null
  }
}

const upstreamBranch = root => {
  try {
    return runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root).trim()
  } catch (_) {
    return null
  }
}

const resolveWorktree = cwd => {
  const start = cwd || process.cwd()
  const root = runGit(['rev-parse', '--show-toplevel'], start).trim()
  const gitDir = absoluteGitPath(root, runGit(['rev-parse', '--git-dir'], root).trim())
  const commonGitDir = absoluteGitPath(root, runGit(['rev-parse', '--git-common-dir'], root).trim())
  const superproject = runGit(['rev-parse', '--show-superproject-working-tree'], root).trim()
  return {
    schema: 'worktree-tools.identity.v1',
    root,
    git_dir: gitDir,
    common_git_dir: commonGitDir,
    is_linked_worktree: path.resolve(gitDir) !== path.resolve(commonGitDir),
    superproject: superproject || null,
    private_paths: {
      index: gitPath(root, 'index'),
      head: gitPath(root, 'HEAD')
    }
  }
}

const parseNameStatusZ = text => {
  const parts = String(text || '').split('\0').filter(Boolean)
  const rows = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    if (/^[RC]\d+/.test(status)) {
      rows.push({ status, old_path: normalizePath(parts[i + 1]), path: normalizePath(parts[i + 2]) })
      i += 2
    } else {
      rows.push({ status, path: normalizePath(parts[i + 1]) })
      i += 1
    }
  }
  return rows
}

const stagedNameStatus = root => parseNameStatusZ(runGit(['diff', '--cached', '--name-status', '-z', '--no-ext-diff'], root))

const stagedDiff = root => runGit(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff'], root)

const stagedFingerprint = root => {
  const head = currentHead(root)
  const diff = stagedDiff(root)
  const files = stagedNameStatus(root)
  return {
    schema: 'worktree-tools.staged-fingerprint.v1',
    git_head: head,
    staged_change_fingerprint: `sha256:${sha256(JSON.stringify({
      schema: 'worktree-tools.staged-fingerprint.v1',
      git_head: head,
      diff
    }))}`,
    staged_diff_bytes: Buffer.byteLength(diff),
    staged_file_count: files.length,
    staged_files: files
  }
}

const porcelainV2 = root => runGit(['status', '--porcelain=v2', '-z', '--branch'], root)

const statusCounts = root => {
  const text = porcelainV2(root)
  const entries = text.split('\0').filter(Boolean)
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let branchOid = null
  for (const entry of entries) {
    if (entry.startsWith('# branch.oid ')) {
      branchOid = entry.slice('# branch.oid '.length).trim()
      continue
    }
    if (entry.startsWith('? ')) {
      untracked += 1
      continue
    }
    if (!entry.startsWith('1 ') && !entry.startsWith('2 ') && !entry.startsWith('u ')) continue
    const xy = entry.slice(2, 4)
    if (xy[0] && xy[0] !== '.' && xy[0] !== ' ') staged += 1
    if (xy[1] && xy[1] !== '.' && xy[1] !== ' ') unstaged += 1
  }
  return {
    branch_oid: branchOid,
    staged,
    unstaged,
    untracked,
    dirty: staged + unstaged + untracked
  }
}

const snapshotWorktree = cwd => {
  const identity = resolveWorktree(cwd)
  const staged = stagedFingerprint(identity.root)
  const counts = statusCounts(identity.root)
  return {
    schema: 'worktree-tools.snapshot.v1',
    ...identity,
    head: staged.git_head,
    branch: currentBranch(identity.root),
    upstream: upstreamBranch(identity.root),
    staged_change_fingerprint: staged.staged_change_fingerprint,
    staged_diff_bytes: staged.staged_diff_bytes,
    staged_file_count: staged.staged_file_count,
    staged_files: staged.staged_files,
    status: counts
  }
}

const parseWorktreeList = text => {
  const records = []
  let current = null
  for (const field of String(text || '').split('\0')) {
    if (!field) continue
    const [key, ...rest] = field.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') {
      if (current) records.push(current)
      current = { path: value, bare: false, detached: false, locked: false }
    } else if (current) {
      if (key === 'HEAD') current.head = value
      else if (key === 'branch') current.branch = value
      else if (key === 'bare') current.bare = true
      else if (key === 'detached') current.detached = true
      else if (key === 'locked') current.locked = true
      else if (key === 'prunable') current.prunable = true
    }
  }
  if (current) records.push(current)
  return records
}

const listWorktrees = cwd => parseWorktreeList(runGit(['worktree', 'list', '--porcelain', '-z'], cwd || process.cwd()))

const shorten = (value, max = 72) => {
  const text = String(value || '')
  return text.length <= max ? text : `...${text.slice(-(max - 3))}`
}

const renderWorktreeCompact = snapshot => {
  if (!snapshot || snapshot.error) return `blocked reason=${snapshot && snapshot.reason || 'not_git_repo'}`
  const bits = [
    'ok',
    `repo=${shorten(snapshot.root)}`,
    snapshot.branch ? `branch=${snapshot.branch}` : 'branch=detached',
    `staged=${snapshot.staged_file_count}`,
    `dirty=${snapshot.status ? snapshot.status.dirty : 0}`
  ]
  if (snapshot.is_linked_worktree) bits.push('linked=1')
  return bits.join(' ')
}

const safeSnapshotWorktree = cwd => {
  try {
    const snapshot = snapshotWorktree(cwd)
    return {
      ok: true,
      status: 'resolved',
      compact: renderWorktreeCompact(snapshot),
      snapshot
    }
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      reason: err && err.code === 'GIT_FAILED' ? 'not_git_repo' : 'git_error',
      compact: `blocked reason=${err && err.code === 'GIT_FAILED' ? 'not_git_repo' : 'git_error'}`,
      error: err && err.message ? err.message : String(err)
    }
  }
}

module.exports = {
  NULL_HEAD,
  currentBranch,
  currentHead,
  gitPath,
  listWorktrees,
  normalizePath,
  parseNameStatusZ,
  parseWorktreeList,
  porcelainV2,
  renderWorktreeCompact,
  resolveWorktree,
  runGit,
  safeSnapshotWorktree,
  snapshotWorktree,
  stagedFingerprint,
  stagedNameStatus,
  statusCounts,
  upstreamBranch
}
