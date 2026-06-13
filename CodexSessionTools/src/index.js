const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_SESSION_SCAN_LIMIT = 100
const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024
const DEFAULT_PREVIEW_CHARS = 240

const defaultCodexSessionRoot = () => path.join(os.homedir(), '.codex', 'sessions')

const walkJsonlFiles = root => {
  const files = []
  const visit = dir => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(full)
          files.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size })
        } catch (_) {
          // Ignore files that disappear while Codex is writing session logs.
        }
      }
    }
  }
  visit(root)
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size || a.file.localeCompare(b.file))
}

const latestCodexSessionFile = root => {
  const latest = walkJsonlFiles(root).slice(0, 1)[0]
  return latest ? latest.file : null
}

const readFileWindow = (file, maxBytes = DEFAULT_WINDOW_BYTES) => {
  let fd
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    fd = fs.openSync(file, 'r')
    fs.readSync(fd, buffer, 0, length, start)
    return {
      text: buffer.toString('utf8'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      start
    }
  } catch (_) {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch (_) {
        // Nothing useful to report.
      }
    }
  }
}

const fileContainsLiteral = ({ file, literal, tailBytes = DEFAULT_WINDOW_BYTES }) => {
  const needle = Buffer.from(String(literal || ''))
  if (!needle.length) return null
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const readRegion = ({ start, end, scan }) => {
      const length = Math.max(0, end - start)
      if (!length) return null
      const buffer = Buffer.allocUnsafe(length)
      fs.readSync(fd, buffer, 0, length, start)
      const index = buffer.indexOf(needle)
      return index >= 0
        ? {
            byteOffset: start + index,
            scan
          }
        : null
    }

    const tailStart = Math.max(0, stat.size - tailBytes - Math.max(0, needle.length - 1))
    const tailMatch = readRegion({ start: tailStart, end: stat.size, scan: 'tail' })
    if (tailMatch) return tailMatch
    if (tailStart <= 0) return null

    const chunkSize = 1024 * 1024
    let position = 0
    let carry = Buffer.alloc(0)
    while (position < tailStart) {
      const readSize = Math.min(chunkSize, tailStart - position)
      const chunk = Buffer.allocUnsafe(readSize)
      fs.readSync(fd, chunk, 0, readSize, position)
      const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const index = combined.indexOf(needle)
      if (index >= 0) {
        return {
          byteOffset: position - carry.length + index,
          scan: 'full'
        }
      }
      carry = combined.slice(-Math.max(0, needle.length - 1))
      position += readSize
    }
    return null
  } catch (_) {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch (_) {
        // Nothing useful to report.
      }
    }
  }
}

const preview = (value, maxChars = DEFAULT_PREVIEW_CHARS) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
}

const parseJsonLine = line => {
  try {
    return JSON.parse(line)
  } catch (_) {
    return null
  }
}

const parseToolArguments = payload => {
  if (!payload || payload.type !== 'function_call' || !payload.arguments) return null
  const args = parseJsonLine(payload.arguments)
  return args && typeof args === 'object' ? args : null
}

const addPathEvent = (events, value, source, line) => {
  if (!value || typeof value !== 'string') return
  events.push({
    path: path.resolve(value),
    source,
    line
  })
}

const termMatches = (raw, term) => {
  if (!term) return false
  if (term instanceof RegExp) return term.test(raw)
  if (Array.isArray(term)) return term.some(item => termMatches(raw, item))
  return raw.includes(String(term))
}

const analyzeCodexSessionFile = (file, options = {}) => {
  const maxBytes = options.maxBytes || DEFAULT_WINDOW_BYTES
  const marker = options.marker || null
  const matchTerm = options.matchTerm || null
  const window = readFileWindow(file, maxBytes)
  if (!window) return null
  const pathEvents = []
  const rawMatches = []
  const toolCalls = []
  let sessionId = null
  let markerFound = !marker
  const lines = window.text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (marker && line.includes(marker)) markerFound = true
    const parsed = parseJsonLine(line)
    const raw = parsed ? JSON.stringify(parsed) : line
    if (termMatches(raw, matchTerm)) {
      rawMatches.push({
        line: i,
        byte_offset_floor: window.start,
        preview: preview(raw, options.previewChars)
      })
    }
    if (!parsed || typeof parsed !== 'object') continue
    const payload = parsed.payload || {}
    if (parsed.type === 'session_meta') {
      if (payload.id) sessionId = payload.id
      addPathEvent(pathEvents, payload.cwd, 'session_meta.cwd', i)
    }
    if (parsed.type === 'turn_context') {
      addPathEvent(pathEvents, payload.cwd, 'turn_context.cwd', i)
      for (const workspaceRoot of payload.workspace_roots || []) {
        addPathEvent(pathEvents, workspaceRoot, 'turn_context.workspace_roots', i)
      }
    }
    if (parsed.type === 'response_item') {
      const args = parseToolArguments(payload)
      if (args) {
        toolCalls.push({
          name: payload.name || '',
          line: i,
          workdir: typeof args.workdir === 'string' ? path.resolve(args.workdir) : null,
          cwd: typeof args.cwd === 'string' ? path.resolve(args.cwd) : null
        })
        addPathEvent(pathEvents, args.workdir, `${payload.name || 'tool'}.workdir`, i)
        addPathEvent(pathEvents, args.cwd, `${payload.name || 'tool'}.cwd`, i)
      }
    }
  }
  if (marker && !markerFound) return null
  return {
    file,
    codex_session_id: sessionId,
    size: window.size,
    mtime_ms: window.mtimeMs,
    scanned_bytes: Math.min(window.size, maxBytes),
    marker_found: markerFound,
    path_events: pathEvents,
    current_path: pathEvents.length ? pathEvents[pathEvents.length - 1] : null,
    tool_calls: toolCalls,
    raw_matches: rawMatches
  }
}

const findCodexSessionsContainingMarker = (root, marker, options = {}) => {
  const limit = options.limit || DEFAULT_SESSION_SCAN_LIMIT
  const matches = []
  for (const item of walkJsonlFiles(root).slice(0, limit)) {
    const session = analyzeCodexSessionFile(item.file, {
      ...options,
      marker,
      maxBytes: options.maxBytes || DEFAULT_WINDOW_BYTES
    })
    if (session) matches.push(session)
  }
  return matches.sort((a, b) => b.mtime_ms - a.mtime_ms || b.size - a.size || a.file.localeCompare(b.file))
}

module.exports = {
  DEFAULT_SESSION_SCAN_LIMIT,
  DEFAULT_WINDOW_BYTES,
  analyzeCodexSessionFile,
  defaultCodexSessionRoot,
  findCodexSessionsContainingMarker,
  fileContainsLiteral,
  latestCodexSessionFile,
  parseToolArguments,
  readFileWindow,
  walkJsonlFiles
}
