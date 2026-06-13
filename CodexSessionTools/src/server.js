const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_WINDOW_BYTES,
  codexHomeForSessionsRoot,
  defaultCodexSessionRoot,
  readCodexThreadSpawnEdges,
  readFileWindow,
  resolveCodexSessionForMarker,
  walkJsonlFiles
} = require('./index.js')
const { runCodexExec } = require('./exec.js')
const { CodexAppServerClient } = require('./appServerClient.js')
const { DiagnosticsStore } = require('./diagnostics.js')
const { reconcileThreadRecord } = require('./reconcile.js')

const DEFAULT_MARKER_PATTERN = /(?:conversation_history-session-|session-indexer-session-|agentdoc-session-|codex-session-)[0-9a-fA-F-]{36}/g

const parseMarkerPattern = value => {
  if (!value) return DEFAULT_MARKER_PATTERN
  if (value instanceof RegExp) return value
  return new RegExp(String(value), 'g')
}

class CodexSessionServerState {
  constructor(options = {}) {
    this.sessionRoot = options.sessionRoot || defaultCodexSessionRoot()
    this.codexHome = options.codexHome || codexHomeForSessionsRoot(this.sessionRoot)
    this.watch = options.watch !== false
    this.pollMs = options.pollMs || 1000
    this.sessions = []
    this.threadSpawnEdges = []
    this.execCommand = options.execCommand || 'codex'
    this.execEnv = options.execEnv || {}
    this.appServer = options.appServer || null
    this.appServerOptions = options.appServerOptions || {}
    this.diagnostics = options.diagnostics || new DiagnosticsStore({
      dir: options.diagnosticsDir,
      persist: options.persistDiagnostics !== false
    })
    this.events = []
    this.watchers = []
    this.pollTimer = null
    this.startedAt = new Date().toISOString()
    this.updatedAt = null
  }

  start() {
    this.refresh('start')
    if (!this.watch) return this
    try {
      const watcher = fs.watch(this.sessionRoot, { recursive: true }, (_event, file) => {
        if (!file || String(file).endsWith('.jsonl')) this.refresh('sessions:watch')
      })
      if (watcher.unref) watcher.unref()
      this.watchers.push(watcher)
    } catch (_) {
      this.pollTimer = setInterval(() => this.refresh('sessions:poll'), this.pollMs)
      if (this.pollTimer.unref) this.pollTimer.unref()
    }
    return this
  }

  stop() {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch (_) {
        // Already closed.
      }
    }
    this.watchers = []
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.appServer && typeof this.appServer.stop === 'function') {
      this.appServer.stop().catch(() => {})
    }
  }

  pushEvent(reason) {
    this.events.push({
      at: new Date().toISOString(),
      reason
    })
    this.events = this.events.slice(-50)
    if (this.diagnostics) this.diagnostics.append('events', { code: reason, status: 'observed' })
  }

  refresh(reason = 'manual') {
    this.sessions = walkJsonlFiles(this.sessionRoot)
    this.threadSpawnEdges = readCodexThreadSpawnEdges({
      root: this.sessionRoot,
      codexHome: this.codexHome
    })
    this.updatedAt = new Date().toISOString()
    this.pushEvent(reason)
    return this.status()
  }

  status() {
    return {
      schema: 'codex-session-tools.server-state.v1',
      started_at: this.startedAt,
      updated_at: this.updatedAt,
      session_root: this.sessionRoot,
      codex_home: this.codexHome,
      watching: this.watch,
      session_count: this.sessions.length,
      thread_spawn_edge_count: this.threadSpawnEdges.length,
      latest_session: this.sessions[0] || null,
      app_server: {
        available: Boolean(this.appServer),
        initialized: Boolean(this.appServer && this.appServer.initialized)
      },
      recent_events: this.events
    }
  }

  ensureAppServer() {
    if (!this.appServer) {
      this.appServer = new CodexAppServerClient({
        command: this.appServerOptions.command || this.execCommand || 'codex',
        args: this.appServerOptions.args || ['app-server', '--listen', 'stdio://'],
        cwd: this.appServerOptions.cwd || process.cwd(),
        env: {
          ...this.execEnv,
          ...(this.appServerOptions.env || {})
        },
        clientInfo: this.appServerOptions.clientInfo,
        requestTimeoutMs: this.appServerOptions.requestTimeoutMs
      })
    }
    return this.appServer
  }

  async appServerThreadList(args = {}) {
    try {
      const result = await this.ensureAppServer().threadList(args)
      this.pushEvent('app-server:thread-list')
      return {
        ok: true,
        status: 'resolved',
        result
      }
    } catch (err) {
      if (this.diagnostics) this.diagnostics.append('events', {
        code: 'app_server_thread_list_failed',
        status: 'degraded'
      })
      return {
        ok: false,
        status: 'degraded',
        reason: 'app_server_thread_list_failed',
        error: err && err.message ? err.message : String(err)
      }
    }
  }

  async appServerThreadRead(args = {}) {
    if (!args.threadId && !args.thread_id) throw new Error('threadId is required')
    const threadId = args.threadId || args.thread_id
    try {
      const result = await this.ensureAppServer().threadRead(threadId, {
        includeTurns: Boolean(args.includeTurns || args.include_turns)
      })
      this.pushEvent('app-server:thread-read')
      return {
        ok: true,
        status: 'resolved',
        result
      }
    } catch (err) {
      if (this.diagnostics) this.diagnostics.append('events', {
        code: 'app_server_thread_read_failed',
        status: 'degraded',
        thread_id: threadId
      })
      return {
        ok: false,
        status: 'degraded',
        reason: 'app_server_thread_read_failed',
        thread_id: threadId,
        error: err && err.message ? err.message : String(err)
      }
    }
  }

  async reconcileThread(args = {}) {
    return reconcileThreadRecord(args.thread || args, {
      appServer: args.useAppServer === false ? null : this.ensureAppServer(),
      diagnostics: this.diagnostics
    })
  }

  resolveMarker(args = {}) {
    if (!args.marker) throw new Error('marker is required')
    return resolveCodexSessionForMarker(args.root || this.sessionRoot, args.marker, {
      ...args,
      sessionFiles: this.sessions,
      threadSpawnEdges: this.threadSpawnEdges
    })
  }

  latestMarker(args = {}) {
    const pattern = parseMarkerPattern(args.pattern)
    const maxBytes = args.maxBytes || DEFAULT_WINDOW_BYTES
    const limit = args.limit || 100
    const candidates = this.sessions.slice(0, limit)
    const matches = []
    for (const item of candidates) {
      const window = readFileWindow(item.file, maxBytes)
      if (!window || !window.text) continue
      let last = null
      for (const match of window.text.matchAll(pattern)) {
        last = {
          marker: match[0],
          file: item.file,
          mtimeMs: item.mtimeMs,
          size: item.size,
          byteOffset: window.start + match.index
        }
      }
      if (last) matches.push(last)
    }
    matches.sort((a, b) =>
      b.mtimeMs - a.mtimeMs ||
      b.byteOffset - a.byteOffset ||
      b.size - a.size ||
      a.file.localeCompare(b.file)
    )
    return matches[0] || null
  }

  async runExec(args = {}) {
    const result = await runCodexExec(args, {
      command: this.execCommand,
      env: this.execEnv,
      cwd: args.cwd || args.workdir
    })
    this.refresh('codex-exec')
    return {
      ...result,
      server_status: this.status()
    }
  }

  diagnosticsPage(args = {}) {
    return this.diagnostics.page(args.kind || 'events', args)
  }
}

module.exports = {
  CodexSessionServerState,
  DEFAULT_MARKER_PATTERN
}
