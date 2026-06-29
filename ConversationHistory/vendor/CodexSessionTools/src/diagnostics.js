const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const defaultDiagnosticsDir = () => path.join(os.homedir(), '.codex', 'agent-tools', 'codex-session-server')

class DiagnosticsStore {
  constructor(options = {}) {
    this.dir = options.dir || defaultDiagnosticsDir()
    this.maxPage = options.maxPage || 20
    this.memory = []
    this.persist = options.persist !== false
  }

  fileFor(kind) {
    return path.join(this.dir, `${kind}.jsonl`)
  }

  append(kind, event = {}) {
    const item = {
      at: new Date().toISOString(),
      kind,
      ...event
    }
    this.memory.push(item)
    this.memory = this.memory.slice(-200)
    if (this.persist) {
      try {
        fs.mkdirSync(this.dir, { recursive: true })
        fs.appendFileSync(this.fileFor(kind), `${JSON.stringify(item)}\n`)
      } catch (_) {
        // Diagnostics must never take down the server.
      }
    }
    return item
  }

  page(kind = 'events', options = {}) {
    const limit = Math.min(Number(options.limit || this.maxPage), this.maxPage)
    const start = Math.max(0, Number(options.cursor || 0))
    const events = []
    const file = this.fileFor(kind)
    if (this.persist && fs.existsSync(file)) {
      try {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
        for (const line of lines.slice(start, start + limit)) {
          try {
            const parsed = JSON.parse(line)
            events.push({
              at: parsed.at,
              code: parsed.code || parsed.reason || parsed.kind,
              status: parsed.status,
              session_id: parsed.session_id,
              thread_id: parsed.thread_id
            })
          } catch (_) {
            events.push({ code: 'malformed_diagnostic_line' })
          }
        }
        return {
          schema: 'codex-session-tools.diagnostics-page.v1',
          events,
          next_cursor: start + limit < lines.length ? String(start + limit) : null
        }
      } catch (_) {
        // Fall through to memory.
      }
    }
    const filtered = this.memory.filter(item => item.kind === kind)
    return {
      schema: 'codex-session-tools.diagnostics-page.v1',
      events: filtered.slice(start, start + limit).map(item => ({
        at: item.at,
        code: item.code || item.reason || item.kind,
        status: item.status,
        session_id: item.session_id,
        thread_id: item.thread_id
      })),
      next_cursor: start + limit < filtered.length ? String(start + limit) : null
    }
  }
}

module.exports = {
  DiagnosticsStore,
  defaultDiagnosticsDir
}
