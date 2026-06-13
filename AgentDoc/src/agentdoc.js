const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  currentHead,
  gitPath: worktreeGitPath,
  resolveWorktree,
  stagedFingerprint: worktreeStagedFingerprint,
  stagedNameStatus: worktreeStagedNameStatus
} = require('worktree-tools')

const TOOL_VERSION = '0.1.0'
const ALLOW_RESULTS = new Set(['docs-current', 'docs-updated'])
const FINAL_RESULTS = new Set([...ALLOW_RESULTS, 'needs-doc-update', 'blocked'])

const repo = cwd => {
  const resolved = resolveWorktree(cwd || process.cwd())
  return {
    root: resolved.root,
    gitDir: resolved.git_dir,
    commonGitDir: resolved.common_git_dir,
    isLinkedWorktree: resolved.is_linked_worktree
  }
}

const gitPrivatePath = (root, rel) => worktreeGitPath(root, rel)

const stagedNameStatus = root => {
  return worktreeStagedNameStatus(root).map(row => ({
    status: row.status,
    path: row.path,
    oldPath: row.old_path
  }))
}

const stagedFingerprint = root => {
  const staged = worktreeStagedFingerprint(root)
  return {
    schema: 'agentdoc.staged-fingerprint.v1',
    git_head: staged.git_head,
    staged_change_fingerprint: staged.staged_change_fingerprint,
    staged_diff_bytes: staged.staged_diff_bytes,
    staged_file_count: staged.staged_file_count
  }
}

const normalizePath = value => String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')

const walk = (dir, visitor) => {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'coverage', 'tmp'].includes(entry.name)) continue
      walk(abs, visitor)
    } else {
      visitor(abs)
    }
  }
}

const isDocSectionPath = rel => normalizePath(rel).split('/').some(part => part.endsWith('.doc'))

const isMarkdown = rel => rel.toLowerCase().endsWith('.md')

const frontmatter = text => {
  if (!text.startsWith('---\n')) return ''
  const end = text.indexOf('\n---', 4)
  if (end === -1) return ''
  return text.slice(4, end)
}

const unquote = value => String(value || '').trim().replace(/^["']|["']$/g, '')

const parseSectionMeta = (rel, text) => {
  const fm = frontmatter(text)
  const meta = {
    path: rel,
    id: null,
    title: path.basename(rel, '.md').replace(/[-_]+/g, ' '),
    scopePaths: []
  }
  if (!fm) return meta
  const lines = fm.split(/\r?\n/)
  let inScope = false
  let inPaths = false
  for (const line of lines) {
    const id = line.match(/^id:\s*(.+)$/)
    if (id) meta.id = unquote(id[1])
    const title = line.match(/^title:\s*(.+)$/)
    if (title) meta.title = unquote(title[1])
    if (/^scope:\s*$/.test(line)) {
      inScope = true
      inPaths = false
      continue
    }
    if (inScope && /^\s+paths:\s*$/.test(line)) {
      inPaths = true
      continue
    }
    if (inPaths) {
      const item = line.match(/^\s*-\s*(.+)$/)
      if (item) {
        meta.scopePaths.push(normalizePath(unquote(item[1])))
        continue
      }
      if (line.trim() && !/^\s/.test(line)) {
        inScope = false
        inPaths = false
      }
    }
  }
  return meta
}

const discoverDocs = root => {
  const indexes = []
  const sections = []
  walk(root, abs => {
    const rel = normalizePath(path.relative(root, abs))
    if (!isMarkdown(rel)) return
    if (isDocSectionPath(rel)) {
      sections.push(parseSectionMeta(rel, fs.readFileSync(abs, 'utf8')))
      return
    }
    const parsed = path.parse(abs)
    const siblingDoc = path.join(parsed.dir, `${parsed.name}.doc`)
    if (fs.existsSync(siblingDoc) && fs.statSync(siblingDoc).isDirectory()) indexes.push(rel)
  })
  indexes.sort()
  sections.sort((a, b) => a.path.localeCompare(b.path))
  return { indexes, sections }
}

const escapeRegExp = text => text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')

const globToRegExp = pattern => {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else {
      out += escapeRegExp(char)
    }
  }
  out += '$'
  return new RegExp(out)
}

const matchesScope = (file, pattern) => {
  const rel = normalizePath(file)
  const scope = normalizePath(pattern)
  if (!scope) return false
  if (!/[*?[\]]/.test(scope)) return rel === scope || rel.startsWith(`${scope.replace(/\/$/, '')}/`)
  return globToRegExp(scope).test(rel)
}

const affectedDocs = (changedFiles, docs) => {
  return changedFiles.map(file => {
    const directDoc = isMarkdown(file.path) && (isDocSectionPath(file.path) || docs.indexes.includes(file.path))
    const matches = isMarkdown(file.path) && isDocSectionPath(file.path)
      ? docs.sections.filter(section => section.path === file.path)
      : docs.sections.filter(section => section.scopePaths.some(scope => matchesScope(file.path, scope)))
    return {
      path: file.path,
      status: file.status,
      kind: directDoc ? 'doc' : 'source',
      docs: matches.map(section => ({
        path: section.path,
        id: section.id,
        title: section.title,
        matched_scopes: section.scopePaths.filter(scope => matchesScope(file.path, scope))
      }))
    }
  })
}

const docFingerprint = (root, docs) => {
  const hash = crypto.createHash('sha256')
  hash.update('agentdoc.docs.v1\0')
  for (const rel of [...docs.indexes, ...docs.sections.map(section => section.path)].sort()) {
    hash.update(`${rel}\0`)
    const abs = path.join(root, rel)
    if (fs.existsSync(abs)) hash.update(fs.readFileSync(abs))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const stampPath = root => gitPrivatePath(root, 'agentdoc/last-check.json')

const reviewPath = root => gitPrivatePath(root, 'agentdoc/review.json')

const prepareReview = (opts = {}) => {
  const { root } = repo(opts.workdir)
  const docs = discoverDocs(root)
  const changed = stagedNameStatus(root)
  const affected = affectedDocs(changed, docs)
  const report = {
    schema: 'agentdoc.review.v1',
    created_at: new Date().toISOString(),
    git_head: currentHead(root),
    staged: stagedFingerprint(root),
    docs: {
      indexes: docs.indexes,
      section_count: docs.sections.length,
      sections: docs.sections.map(section => ({
        path: section.path,
        id: section.id,
        title: section.title,
        scope_paths: section.scopePaths
      }))
    },
    changed_files: changed,
    affected,
    uncovered_source_files: affected
      .filter(item => item.kind === 'source' && item.docs.length === 0)
      .map(item => item.path),
    next: [
      'Inspect the changed source and each affected doc section.',
      'Update self-contained section files when claims changed.',
      'Use the AgentDoc MCP check tool with the final result after the review.'
    ]
  }
  const file = reviewPath(root)
  writeJson(file, report)
  return `AgentDoc review: ${path.relative(root, file) || file}`
}

const recordCheck = (opts = {}) => {
  if (!FINAL_RESULTS.has(opts.result)) {
    throw new Error('result must be docs-current, docs-updated, needs-doc-update, or blocked')
  }
  const reviewed = opts.reviewed || []
  const updated = opts.updated || []
  if (ALLOW_RESULTS.has(opts.result) && !reviewed.length && !updated.length && !opts.noDocsNeeded) {
    throw new Error('AgentDoc check requires reviewed, updated, or noDocsNeeded')
  }
  const { root } = repo(opts.workdir)
  const docs = discoverDocs(root)
  const staged = stagedFingerprint(root)
  const stamp = {
    schema: 'agentdoc.check.v1',
    checked_at: new Date().toISOString(),
    agent: process.env.AGENTDOC_AGENT || 'codex',
    tool: 'agentdoc',
    tool_version: TOOL_VERSION,
    git_head: staged.git_head,
    staged_change_fingerprint: staged.staged_change_fingerprint,
    staged_file_count: staged.staged_file_count,
    staged_diff_bytes: staged.staged_diff_bytes,
    doc_fingerprint: docFingerprint(root, docs),
    result: opts.result,
    reviewed_docs: reviewed.map(normalizePath),
    updated_docs: updated.map(normalizePath),
    no_docs_needed: Boolean(opts.noDocsNeeded),
    note: opts.note || ''
  }
  writeJson(stampPath(root), stamp)
  return `AgentDoc stamped: ${opts.result}`
}

const gateError = message => {
  const err = new Error(message)
  err.shortMessage = message
  err.exitCode = 1
  return err
}

const verifyGate = (opts = {}) => {
  const { root } = repo(opts.workdir)
  const file = stampPath(root)
  if (!fs.existsSync(file)) throw gateError('AgentDoc required')
  let stamp
  try {
    stamp = readJson(file)
  } catch (_) {
    throw gateError('AgentDoc invalid')
  }
  const staged = stagedFingerprint(root)
  if (stamp.schema !== 'agentdoc.check.v1') throw gateError('AgentDoc invalid')
  if (stamp.staged_change_fingerprint !== staged.staged_change_fingerprint) throw gateError('AgentDoc stale: staged fingerprint changed')
  if (!ALLOW_RESULTS.has(stamp.result)) throw gateError('AgentDoc blocked: docs need update')
  return null
}

const installHook = (opts = {}) => {
  const { root } = repo(opts.workdir)
  const hook = opts.hook || 'pre-commit'
  if (hook !== 'pre-commit') throw new Error('hook currently supports pre-commit')
  const hookPath = gitPrivatePath(root, 'hooks/pre-commit')
  const binPath = path.resolve(__dirname, '..', 'bin', 'agentdoc-hook.js')
  const script = `#!/bin/sh\nnode ${JSON.stringify(binPath)}\n`
  fs.mkdirSync(path.dirname(hookPath), { recursive: true })
  fs.writeFileSync(hookPath, script, { mode: 0o755 })
  fs.chmodSync(hookPath, 0o755)
  return `AgentDoc hook installed: ${hook}`
}

const getStatus = (opts = {}) => {
  const { root } = repo(opts.workdir)
  const file = stampPath(root)
  const staged = stagedFingerprint(root)
  const stamp = fs.existsSync(file) ? readJson(file) : null
  return {
    schema: 'agentdoc.status.v1',
    git_head: staged.git_head,
    staged_change_fingerprint: staged.staged_change_fingerprint,
    stamp: stamp ? {
      checked_at: stamp.checked_at,
      result: stamp.result,
      matches_staged: stamp.staged_change_fingerprint === staged.staged_change_fingerprint
    } : null
  }
}

module.exports = {
  ALLOW_RESULTS,
  affectedDocs,
  docFingerprint,
  discoverDocs,
  getStatus,
  gitPrivatePath,
  installHook,
  prepareReview,
  recordCheck,
  repo,
  reviewPath,
  stagedFingerprint,
  stagedNameStatus,
  stampPath,
  verifyGate
}
