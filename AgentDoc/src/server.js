const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  analyzeCodexSessionFile: analyzeCodexSessionLog,
  defaultCodexSessionRoot,
  latestCodexSessionFile,
  resolveCodexSessionForMarker
} = require('codex-session-tools')
const { connectOrStartCodexSessionServer } = require('codex-session-tools/src/client.js')

const {
  discoverDocs,
  docFingerprint,
  getStatus,
  gitPrivatePath,
  installHook,
  prepareReview,
  recordCheck,
  repo,
  stagedFingerprint,
  stagedNameStatus,
  stampPath,
  verifyGate
} = require('./agentdoc.js')

const MAX_EVENTS = 50

const normalizePath = value => String(value || '').replace(/\\/g, '/')

const makeAgentDocSessionId = () => `agentdoc-session-${crypto.randomUUID()}`

const preview = value => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > 240 ? `${text.slice(0, 240)}...` : text
}

const repoRootFor = candidate => {
  try {
    if (!candidate || !fs.existsSync(candidate)) return null
    return repo(candidate).root
  } catch (_) {
    return null
  }
}

const uniqueLatestRepos = candidates => {
  const seen = new Set()
  const repos = []
  for (let i = candidates.length - 1; i >= 0; i--) {
    const root = repoRootFor(candidates[i].path)
    if (!root || seen.has(root)) continue
    seen.add(root)
    repos.push({
      root,
      source: candidates[i].source,
      line: candidates[i].line
    })
  }
  return repos
}

const classifyAgentDocMatches = rawMatches => rawMatches.map(match => {
  const raw = match.preview
  let kind = 'mention'
  const tool = raw.match(/agentdoc_[a-z_]+/)?.[0] || null
  if (/agentdoc_record_check|agentdoc\s+check/.test(raw)) kind = 'record-check'
  else if (/agentdoc_prepare_review/.test(raw)) kind = 'prepare-review'
  else if (/agentdoc_start_session/.test(raw)) kind = 'start-session'
  else if (/agentdoc_gate_status/.test(raw)) kind = 'gate-status'
  else if (/AgentDoc stamped/.test(raw)) kind = 'stamp-output'
  else if (/AgentDoc (required|stale|blocked|invalid)/.test(raw)) kind = 'gate-output'
  return {
    kind,
    tool,
    byte_offset_floor: match.byte_offset_floor,
    tail_line: match.line,
    preview: preview(raw)
  }
})

const agentDocSessionFromCodexLog = session => {
  if (!session) return null
  const repositories = uniqueLatestRepos(session.path_events || [])
  return {
    file: session.file,
    codex_session_id: session.codex_session_id,
    size: session.size,
    mtime_ms: session.mtime_ms,
    scanned_tail_bytes: session.scanned_bytes,
    marker_found: session.marker_found,
    repositories,
    current_repository: repositories[0] || null,
    agentdoc_events: classifyAgentDocMatches(session.raw_matches || []).slice(-MAX_EVENTS)
  }
}

const scanCodexSessionTail = file => agentDocSessionFromCodexLog(analyzeCodexSessionLog(file, {
  matchTerm: ['agentdoc_', 'AgentDoc']
}))

const findCodexSessionForMarker = async (root, marker, codexSessions = null) => {
  const resolved = codexSessions
    ? await codexSessions.resolveMarker({ marker, matchTerm: ['agentdoc_', 'AgentDoc'] })
    : resolveCodexSessionForMarker(root, marker, {
        matchTerm: ['agentdoc_', 'AgentDoc']
      })
  return resolved ? [agentDocSessionFromCodexLog(resolved)] : []
}

class AgentDocServerState {
  constructor(options = {}) {
    this.codexSessionRoot = options.codexSessionRoot || defaultCodexSessionRoot()
    this.watch = options.watch !== false
    this.codexSessions = options.codexSessions || null
    this.codexSessionsStarted = false
    this.watchers = []
    this.repoWatchers = new Map()
    this.sessions = new Map()
    this.events = []
    this.startedAt = new Date().toISOString()
    this.snapshot = null
    this.started = false
    this.startPromise = null
  }

  async ensureCodexSessions() {
    if (!this.codexSessions) {
      this.codexSessions = await connectOrStartCodexSessionServer({
        sessionRoot: this.codexSessionRoot,
        watch: this.watch
      })
      this.codexSessionsStarted = true
      return this.codexSessions
    }
    if (!this.codexSessionsStarted && typeof this.codexSessions.start === 'function') {
      await this.codexSessions.start()
    }
    this.codexSessionsStarted = true
    return this.codexSessions
  }

  async start() {
    if (this.started) return this
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      await this.ensureCodexSessions()
      await this.refresh('start')
      this.started = true
      return this
    })()
    try {
      return await this.startPromise
    } catch (err) {
      this.startPromise = null
      throw err
    }
  }

  async stop() {
    if (this.codexSessions && typeof this.codexSessions.stop === 'function') this.codexSessions.stop()
    const closing = [
      ...this.watchers.map(watcher => watcher.close()),
      ...Array.from(this.repoWatchers.values()).map(watcher => watcher.close())
    ]
    this.watchers = []
    this.repoWatchers.clear()
    await Promise.all(closing)
    this.started = false
    this.startPromise = null
  }

  pushEvent(reason) {
    this.events.push({
      at: new Date().toISOString(),
      reason
    })
    this.events = this.events.slice(-MAX_EVENTS)
  }

  async startAgentDocSession() {
    const agentdocSessionId = makeAgentDocSessionId()
    const session = {
      schema: 'agentdoc.session.v1',
      agentdoc_session_id: agentdocSessionId,
      marker: agentdocSessionId,
      created_at: new Date().toISOString(),
      codex_session: null,
      repositories: []
    }
    this.sessions.set(agentdocSessionId, session)
    this.pushEvent(`agentdoc-session:start:${agentdocSessionId}`)
    await this.refreshSession(agentdocSessionId)
    return {
      schema: 'agentdoc.start-session.v1',
      agentdoc_session_id: agentdocSessionId,
      marker: agentdocSessionId,
      message: 'Use this agentdoc_session_id in later AgentDoc tool calls.'
    }
  }

  async refreshSession(agentdocSessionId) {
    const session = this.sessions.get(agentdocSessionId)
    if (!session) throw new Error(`unknown AgentDoc session: ${agentdocSessionId}`)
    await this.ensureCodexSessions()
    const matches = await findCodexSessionForMarker(this.codexSessionRoot, session.marker, this.codexSessions)
    if (matches.length) {
      session.codex_session = matches[0]
      session.repositories = matches[0].repositories
      for (const item of session.repositories) this.watchRepo(item.root)
    }
    return session
  }

  async resolveSession(agentdocSessionId) {
    if (!agentdocSessionId) {
      const latest = Array.from(this.sessions.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
      if (!latest) throw new Error('AgentDoc session required: call agentdoc_start_session first')
      agentdocSessionId = latest.agentdoc_session_id
    }
    return this.refreshSession(agentdocSessionId)
  }

  async resolveWorkdir(args = {}) {
    if (args.workdir) return repo(args.workdir).root
    const session = await this.resolveSession(args.agentdoc_session_id)
    const current = session.codex_session && session.codex_session.current_repository
    if (!current || !current.root) {
      throw new Error(`AgentDoc session is not associated with a repository yet: ${session.agentdoc_session_id}`)
    }
    return current.root
  }

  watchRepo(root) {
    if (!this.watch || this.repoWatchers.has(root)) return
    const chokidar = require('chokidar')
    let gitIndex
    let gitHead
    try {
      gitIndex = gitPrivatePath(root, 'index')
      gitHead = gitPrivatePath(root, 'HEAD')
    } catch (_) {
      return
    }
    const docWatcher = chokidar.watch(root, {
      ignored: file => {
        const rel = normalizePath(path.relative(root, file))
        if (!rel) return false
        if (rel.split('/').some(part => ['.git', 'node_modules', 'coverage', 'tmp'].includes(part))) return true
        const ext = path.extname(file)
        return Boolean(ext) && ext !== '.md'
      },
      ignoreInitial: true
    })
    docWatcher.on('all', (event, file) => {
      if (path.extname(file) === '.md') this.refresh(`repo-docs:${event}:${root}:${normalizePath(path.relative(root, file))}`)
    })
    const gitWatcher = chokidar.watch([gitIndex, gitHead], { ignoreInitial: true })
    gitWatcher.on('all', event => this.refresh(`repo-git:${event}:${root}`))
    this.repoWatchers.set(root, {
      close: async () => {
        await Promise.all([docWatcher.close(), gitWatcher.close()])
      }
    })
  }

  repoSnapshot(root) {
    const repoInfo = repo(root)
    const docs = discoverDocs(root)
    const staged = stagedFingerprint(root)
    const stampFile = stampPath(root)
    const currentStatus = getStatus({ workdir: root })
    return {
      root,
      git: {
        git_dir: repoInfo.gitDir,
        common_git_dir: repoInfo.commonGitDir,
        is_linked_worktree: repoInfo.isLinkedWorktree,
        head: staged.git_head,
        staged_change_fingerprint: staged.staged_change_fingerprint,
        staged_file_count: staged.staged_file_count,
        staged_files: stagedNameStatus(root).slice(0, 100)
      },
      docs: {
        indexes: docs.indexes,
        section_count: docs.sections.length,
        doc_fingerprint: docFingerprint(root, docs)
      },
      stamp: {
        path: path.relative(root, stampFile) || stampFile,
        exists: fs.existsSync(stampFile),
        status: currentStatus.stamp
      }
    }
  }

  async prepareReview(args = {}) {
    const workdir = await this.resolveWorkdir(args)
    return {
      message: prepareReview({ workdir }),
      repository: this.repoSnapshot(workdir)
    }
  }

  async recordCheck(args = {}) {
    const workdir = await this.resolveWorkdir(args)
    return {
      message: recordCheck({ ...args, workdir }),
      repository: this.repoSnapshot(workdir)
    }
  }

  async gateStatus(args = {}) {
    const workdir = await this.resolveWorkdir(args)
    try {
      verifyGate({ workdir })
      return {
        schema: 'agentdoc.gate-status.v1',
        allowed: true,
        repository: this.repoSnapshot(workdir)
      }
    } catch (err) {
      return {
        schema: 'agentdoc.gate-status.v1',
        allowed: false,
        reason: err && err.shortMessage ? err.shortMessage : String(err && err.message || err),
        repository: this.repoSnapshot(workdir)
      }
    }
  }

  async installHook(args = {}) {
    const workdir = await this.resolveWorkdir(args)
    return {
      message: installHook({ workdir }),
      repository: this.repoSnapshot(workdir)
    }
  }

  async refresh(reason = 'manual') {
    await this.ensureCodexSessions()
    for (const id of this.sessions.keys()) {
      try {
        await this.refreshSession(id)
      } catch (_) {
        // Keep server status available even when one session cannot resolve.
      }
    }
    let codexStatus = null
    try {
      codexStatus = await this.codexSessions.status()
    } catch (err) {
      codexStatus = {
        error: err && err.message ? err.message : String(err)
      }
    }
    const latestFile = codexStatus && codexStatus.latest_session && codexStatus.latest_session.file
    this.pushEvent(reason)
    this.snapshot = {
      schema: 'agentdoc.server-state.v1',
      started_at: this.startedAt,
      updated_at: new Date().toISOString(),
      codex_session_root: this.codexSessionRoot,
      sessions: Array.from(this.sessions.values()).map(session => ({
        agentdoc_session_id: session.agentdoc_session_id,
        created_at: session.created_at,
        marker: session.marker,
        codex_session: session.codex_session ? {
          file: session.codex_session.file,
          codex_session_id: session.codex_session.codex_session_id,
          current_repository: session.codex_session.current_repository,
          repositories: session.codex_session.repositories,
          agentdoc_events: session.codex_session.agentdoc_events
        } : null
      })),
      watched_repositories: Array.from(this.repoWatchers.keys()),
      latest_codex_session: latestFile ? scanCodexSessionTail(latestFile) : null,
      codex_session_server: codexStatus,
      recent_events: this.events
    }
    return this.snapshot
  }

  async getSnapshot() {
    return this.snapshot || this.refresh('snapshot')
  }
}

module.exports = {
  AgentDocServerState,
  agentDocSessionFromCodexLog,
  findCodexSessionForMarker,
  latestCodexSessionFile,
  makeAgentDocSessionId,
  scanCodexSessionTail
}
