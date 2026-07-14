const fs = require('node:fs')
const childProcess = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const {
  buildCodexExecArgs,
  parseJsonl,
  runCodexExec
} = require('./exec.js')
const { CodexAppServerClient } = require('./appServerClient.js')
const { DiagnosticsStore } = require('./diagnostics.js')
const {
  renderForTool,
  toolResult
} = require('./render.js')
const {
  compactError,
  reconcileThreadRecord
} = require('./reconcile.js')

const DEFAULT_SESSION_SCAN_LIMIT = 100
const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024
const DEFAULT_PREVIEW_CHARS = 240
const MARKER_SCAN_CHUNK_BYTES = 64 * 1024
const SESSION_MARKER_SINCE_GRACE_MS = 2000

const defaultCodexSessionRoot = () => path.join(os.homedir(), '.codex', 'sessions')

const codexHomeForSessionsRoot = root => {
  const resolved = path.resolve(root || defaultCodexSessionRoot())
  return path.basename(resolved) === 'sessions' ? path.dirname(resolved) : path.join(os.homedir(), '.codex')
}

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
          files.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino })
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

const fileFingerprintFromStat = stat => stat
  ? {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino
    }
  : null

const fileFingerprint = item => {
  if (item && Number.isFinite(item.size) && Number.isFinite(item.mtimeMs)) {
    return {
      size: item.size,
      mtimeMs: item.mtimeMs,
      dev: item.dev,
      ino: item.ino
    }
  }
  try {
    return fileFingerprintFromStat(fs.statSync(item.file || item))
  } catch (_) {
    return null
  }
}

const sameFingerprint = (left, right) => Boolean(left && right) &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  (left.dev === undefined || right.dev === undefined || left.dev === right.dev) &&
  (left.ino === undefined || right.ino === undefined || left.ino === right.ino)

const sameFileIdentity = (left, right) => Boolean(left && right) &&
  (left.dev === undefined || right.dev === undefined || left.dev === right.dev) &&
  (left.ino === undefined || right.ino === undefined || left.ino === right.ino)

const markerCacheKey = (root, marker) => `${path.resolve(root || defaultCodexSessionRoot())}\0${marker}`

const markerCacheEntry = (cache, root, marker) => {
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') return null
  const key = markerCacheKey(root, marker)
  let entry = cache.get(key)
  if (!entry) {
    entry = {
      matches: new Map(),
      misses: new Map()
    }
    cache.set(key, entry)
  }
  return entry
}

const primeMarkerLookupCache = ({ markerLookupCache, root, marker, sessionFiles = [] }) => {
  const entry = markerCacheEntry(markerLookupCache, root, marker)
  if (!entry) return markerLookupCache
  for (const item of sessionFiles) {
    if (!item || !item.file || entry.matches.has(item.file) || entry.misses.has(item.file)) continue
    const fingerprint = fileFingerprint(item)
    if (fingerprint) entry.misses.set(item.file, { fingerprint })
  }
  return markerLookupCache
}

const readRangeContainsLiteral = ({ file, literal, start, end }) => {
  const needle = Buffer.from(String(literal || ''))
  if (!needle.length) return null
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const safeStart = Math.max(0, Math.min(Number(start) || 0, stat.size))
    const safeEnd = Math.max(safeStart, Math.min(Number(end) || 0, stat.size))
    const length = safeEnd - safeStart
    if (!length) return null
    const buffer = Buffer.allocUnsafe(length)
    fs.readSync(fd, buffer, 0, length, safeStart)
    const index = buffer.indexOf(needle)
    if (index < 0) return null
    return {
      byteOffset: safeStart + index,
      lineStart: safeStart,
      lineEnd: safeEnd,
      scan: 'cache_verified',
      fingerprint: fileFingerprintFromStat(stat)
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

const fileContainsLiteral = ({ file, literal, startOffset = 0, chunkBytes = MARKER_SCAN_CHUNK_BYTES }) => {
  const needle = Buffer.from(String(literal || ''))
  if (!needle.length) return null
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const floor = Math.max(0, Math.min(Number(startOffset) || 0, stat.size))
    let position = stat.size
    let tail = Buffer.alloc(0)
    while (position > floor) {
      const readStart = Math.max(floor, position - chunkBytes)
      const length = position - readStart
      const chunk = Buffer.allocUnsafe(length)
      fs.readSync(fd, chunk, 0, length, readStart)
      const combined = tail.length ? Buffer.concat([chunk, tail]) : chunk
      let lineEnd = combined.length
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] !== 0x0a) continue
        const lineStart = i + 1
        const line = combined.subarray(lineStart, lineEnd)
        const index = line.indexOf(needle)
        if (index >= 0) {
          return {
            byteOffset: readStart + lineStart + index,
            lineStart: readStart + lineStart,
            lineEnd: readStart + lineEnd,
            scan: 'backward_line',
            fingerprint: fileFingerprintFromStat(stat)
          }
        }
        lineEnd = i
      }
      tail = combined.subarray(0, lineEnd)
      position = readStart
    }
    if (tail.length) {
      const index = tail.indexOf(needle)
      if (index >= 0) {
        return {
          byteOffset: floor + index,
          lineStart: floor,
          lineEnd: floor + tail.length,
          scan: 'backward_line',
          fingerprint: fileFingerprintFromStat(stat)
        }
      }
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

const globalPatternForLine = pattern => {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern || '')
  const inputFlags = pattern instanceof RegExp ? pattern.flags : ''
  const flags = new Set(inputFlags.replace(/y/g, '').split('').filter(Boolean))
  flags.add('g')
  return new RegExp(source, Array.from(flags).join(''))
}

const latestRegexMatch = (pattern, text) => {
  const regex = globalPatternForLine(pattern)
  let latest = null
  for (const match of text.matchAll(regex)) latest = match
  return latest
}

const fileLatestPatternMatch = ({ file, pattern, startOffset = 0, chunkBytes = MARKER_SCAN_CHUNK_BYTES }) => {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const floor = Math.max(0, Math.min(Number(startOffset) || 0, stat.size))
    let position = stat.size
    let tail = Buffer.alloc(0)
    const inspectLine = (line, lineStart, lineEnd) => {
      const text = line.toString('utf8')
      const match = latestRegexMatch(pattern, text)
      if (!match) return null
      return {
        marker: match[0],
        byteOffset: lineStart + Buffer.byteLength(text.slice(0, match.index)),
        lineStart,
        lineEnd,
        scan: 'backward_line',
        fingerprint: fileFingerprintFromStat(stat)
      }
    }
    while (position > floor) {
      const readStart = Math.max(floor, position - chunkBytes)
      const length = position - readStart
      const chunk = Buffer.allocUnsafe(length)
      fs.readSync(fd, chunk, 0, length, readStart)
      const combined = tail.length ? Buffer.concat([chunk, tail]) : chunk
      let lineEnd = combined.length
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] !== 0x0a) continue
        const lineStart = i + 1
        const found = inspectLine(
          combined.subarray(lineStart, lineEnd),
          readStart + lineStart,
          readStart + lineEnd
        )
        if (found) return found
        lineEnd = i
      }
      tail = combined.subarray(0, lineEnd)
      position = readStart
    }
    if (tail.length) return inspectLine(tail, floor, floor + tail.length)
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

const fallbackSessionIdFromFile = file => {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/)
  return match ? match[1] : file
}

const codexSessionIdFromFile = file => {
  const window = readFileWindow(file, DEFAULT_WINDOW_BYTES)
  if (!window) return fallbackSessionIdFromFile(file)
  for (const line of window.text.split(/\r?\n/)) {
    if (!line || !line.includes('"session_meta"')) continue
    const parsed = parseJsonLine(line)
    if (parsed && parsed.type === 'session_meta' && parsed.payload && parsed.payload.id) return parsed.payload.id
  }
  return fallbackSessionIdFromFile(file)
}

const codexStateDbFiles = codexHome => {
  try {
    return fs.readdirSync(codexHome)
      .filter(name => /^state_.*\.sqlite$/.test(name))
      .map(name => {
        const file = path.join(codexHome, name)
        try {
          const stat = fs.statSync(file)
          return { file, mtimeMs: stat.mtimeMs }
        } catch (_) {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
      .map(item => item.file)
  } catch (_) {
    return []
  }
}

const readCodexThreadSpawnEdges = (options = {}) => {
  if (Array.isArray(options.threadSpawnEdges)) return options.threadSpawnEdges
  const codexHome = options.codexHome || codexHomeForSessionsRoot(options.root || defaultCodexSessionRoot())
  const files = options.stateDb ? [options.stateDb] : codexStateDbFiles(codexHome)
  for (const file of files) {
    try {
      const text = childProcess.execFileSync('sqlite3', [
        '-separator', '\t',
        file,
        'SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges'
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return text.split(/\r?\n/)
        .map(line => line.split('\t'))
        .filter(parts => parts.length >= 2 && parts[0] && parts[1])
        .map(parts => ({
          parentThreadId: parts[0],
          childThreadId: parts[1]
        }))
    } catch (_) {
      // CLI-only installs and older Codex state databases may not expose fork edges.
    }
  }
  return []
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

const sessionMarkerScanLimit = options => {
  const value = options.sessionMarkerScanLimit === undefined
    ? options.limit || DEFAULT_SESSION_SCAN_LIMIT
    : options.sessionMarkerScanLimit
  const text = String(value || '').trim().toLowerCase()
  if (!text || text === 'all' || text === 'off' || text === 'none') return Infinity
  const number = Number(text)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_SESSION_SCAN_LIMIT
}

const recentSessionFileItems = (items, options = {}) => {
  const sorted = [...(items || [])].sort((a, b) =>
    b.mtimeMs - a.mtimeMs ||
    b.size - a.size ||
    a.file.localeCompare(b.file)
  )
  const limit = sessionMarkerScanLimit(options)
  return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted
}

const scoreCodexSessionMarkerFile = (item, marker, options = {}) => {
  const fingerprint = fileFingerprint(item)
  const cacheEntry = markerCacheEntry(options.markerLookupCache, options.root, marker)
  const cachedMatch = cacheEntry && cacheEntry.matches.get(item.file)
  if (cachedMatch) {
    const verified = readRangeContainsLiteral({
      file: item.file,
      literal: marker,
      start: cachedMatch.lineStart,
      end: cachedMatch.lineEnd
    })
    if (verified) {
      cacheEntry.matches.set(item.file, { ...cachedMatch, ...verified, fingerprint: verified.fingerprint || fingerprint })
      return {
        file: item.file,
        sessionId: codexSessionIdFromFile(item.file),
        mtimeMs: item.mtimeMs,
        size: item.size,
        signals: {
          sessionMarkerMatch: {
            marker,
            byteOffset: verified.byteOffset,
            scan: verified.scan
          }
        }
      }
    }
    cacheEntry.matches.delete(item.file)
  }

  let startOffset = 0
  const cachedMiss = cacheEntry && cacheEntry.misses.get(item.file)
  if (cachedMiss && sameFingerprint(cachedMiss.fingerprint, fingerprint)) return null
  if (cachedMiss && cachedMiss.fingerprint && fingerprint &&
      sameFileIdentity(cachedMiss.fingerprint, fingerprint) &&
      fingerprint.size > cachedMiss.fingerprint.size) {
    startOffset = Math.max(0, cachedMiss.fingerprint.size - Buffer.byteLength(String(marker)) + 1)
  } else if (Number(options.sessionMarkerSinceMs) > 0 && fingerprint) {
    const scanBytes = Number(options.sessionMarkerScanBytes || options.maxBytes || DEFAULT_WINDOW_BYTES)
    if (Number.isFinite(scanBytes) && scanBytes > 0) {
      startOffset = Math.max(0, fingerprint.size - scanBytes - Buffer.byteLength(String(marker)) + 1)
    }
  }

  const match = fileContainsLiteral({
    file: item.file,
    literal: marker,
    startOffset,
    chunkBytes: options.sessionMarkerChunkBytes || MARKER_SCAN_CHUNK_BYTES
  })
  if (!match) {
    if (cacheEntry) {
      cacheEntry.misses.set(item.file, { fingerprint })
      cacheEntry.matches.delete(item.file)
    }
    return null
  }
  if (cacheEntry) {
    cacheEntry.matches.set(item.file, {
      byteOffset: match.byteOffset,
      lineStart: match.lineStart,
      lineEnd: match.lineEnd,
      fingerprint: match.fingerprint || fingerprint
    })
    cacheEntry.misses.delete(item.file)
  }
  return {
    file: item.file,
    sessionId: codexSessionIdFromFile(item.file),
    mtimeMs: item.mtimeMs,
    size: item.size,
    signals: {
      sessionMarkerMatch: {
        marker,
        byteOffset: match.byteOffset,
        scan: match.scan
      }
    }
  }
}

const resolveForkedMarkerCandidate = (candidates, options = {}) => {
  const candidateIds = new Set(candidates.map(item => item.sessionId || item.codex_session_id).filter(Boolean))
  if (candidateIds.size < 2) return null
  const edges = readCodexThreadSpawnEdges(options)
    .filter(edge => candidateIds.has(edge.parentThreadId) && candidateIds.has(edge.childThreadId))
  if (!edges.length) return null

  const parentIds = new Set(edges.map(edge => edge.parentThreadId))
  const leaves = candidates.filter(item => {
    const id = item.sessionId || item.codex_session_id
    return id && !parentIds.has(id)
  })
  if (leaves.length !== 1) return null

  const selected = leaves[0]
  return {
    ...selected,
    signals: {
      ...(selected.signals || {}),
      forkResolution: {
        selectedThreadId: selected.sessionId || selected.codex_session_id,
        candidateThreadIds: Array.from(candidateIds).sort(),
        edgesConsidered: edges.length
      }
    }
  }
}

const resolveCodexSessionForMarker = (root, marker, options = {}) => {
  const sessionRoot = root || defaultCodexSessionRoot()
  const sessionFiles = Array.isArray(options.sessionFiles) ? options.sessionFiles : walkJsonlFiles(sessionRoot)
  const markerSinceMs = Number(options.sessionMarkerSinceMs)
  const eligibleSessionFiles = Number.isFinite(markerSinceMs) && markerSinceMs > 0
    ? sessionFiles.filter(item => Number(item.mtimeMs) >= markerSinceMs - SESSION_MARKER_SINCE_GRACE_MS)
    : sessionFiles
  const candidates = recentSessionFileItems(eligibleSessionFiles, options)
    .map(item => scoreCodexSessionMarkerFile(item, marker, {
      ...options,
      root: sessionRoot
    }))
    .filter(Boolean)
  if (!candidates.length) return null
  candidates.sort((a, b) => a.file.localeCompare(b.file))
  let selected = null
  let reason = 'session_marker_match'
  if (candidates.length === 1) {
    selected = candidates[0]
  } else {
    const fork = resolveForkedMarkerCandidate(candidates, {
      ...options,
      root: sessionRoot
    })
    if (!fork) {
      const err = new Error(`session marker matched multiple Codex session files: ${candidates.map(item => item.file).join(', ')}`)
      err.code = 'AMBIGUOUS_SESSION_MARKER'
      err.candidates = candidates
      throw err
    }
    selected = fork
    reason = 'session_marker_match_fork_descendant'
  }

  const analyzed = analyzeCodexSessionFile(selected.file, {
    ...options,
    marker: null,
    maxBytes: options.maxBytes || DEFAULT_WINDOW_BYTES
  }) || {}
  return {
    ...analyzed,
    ...selected,
    codex_session_id: analyzed.codex_session_id || selected.sessionId,
    reason,
    candidates: options.includeCandidates ? candidates : []
  }
}

module.exports = {
  DEFAULT_SESSION_SCAN_LIMIT,
  DEFAULT_WINDOW_BYTES,
  analyzeCodexSessionFile,
  CodexAppServerClient,
  codexHomeForSessionsRoot,
  codexSessionIdFromFile,
  codexStateDbFiles,
  compactError,
  defaultCodexSessionRoot,
  DiagnosticsStore,
  findCodexSessionsContainingMarker,
  fileContainsLiteral,
  fileLatestPatternMatch,
  latestCodexSessionFile,
  buildCodexExecArgs,
  parseToolArguments,
  parseJsonl,
  primeMarkerLookupCache,
  readCodexThreadSpawnEdges,
  readFileWindow,
  recentSessionFileItems,
  reconcileThreadRecord,
  renderForTool,
  resolveCodexSessionForMarker,
  resolveForkedMarkerCandidate,
  runCodexExec,
  scoreCodexSessionMarkerFile,
  sessionMarkerScanLimit,
  toolResult,
  walkJsonlFiles
}
