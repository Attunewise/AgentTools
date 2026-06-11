const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  createSessionIR,
  normalizeModelFamily,
  normalizeUsage,
  USAGE_FIELDS
} = require('../ir.js')
const {
  hashString,
  preview,
  readJsonlRows,
  readLines,
  stableStringify,
  walkFiles,
  newestFile
} = require('../util.js')

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions')
const DEFAULT_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl')
const SESSION_MARKER_PREFIX = 'conversation_history-session-'
const LEGACY_SESSION_MARKER_PREFIX = 'session-indexer-session-'
const DEFAULT_SESSION_MARKER_SCAN_BYTES = 8 * 1024 * 1024
const DEFAULT_SESSION_MARKER_SCAN_LIMIT = 100

const contentText = content => {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stableStringify(content)
  return content.map(part => {
    if (!part) return ''
    if (typeof part === 'string') return part
    return part.text || part.input_text || part.output_text || stableStringify(part)
  }).filter(Boolean).join('\n')
}

const readSessionNames = file => {
  const names = new Map()
  try {
    for (const row of readJsonlRows(file)) {
      if (row.parseError) continue
      if (row.json && row.json.id) names.set(row.json.id, row.json.thread_name || row.json.name || row.json.id)
    }
  } catch (_err) {
    // session_index.jsonl is helpful metadata, not required.
  }
  return names
}

const codexSessionFiles = (root = DEFAULT_SESSIONS_ROOT) => walkFiles(root, file => file.endsWith('.jsonl'))

const fallbackSessionIdFromFile = file => {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/)
  return match ? match[1] : hashString(file).slice(0, 24)
}

const fingerprintFromCompactions = ({ sessionId, compactions }) => {
  const last = compactions[compactions.length - 1] || null
  return {
    schema: 'session-indexer.codex-source-fingerprint.v1',
    sessionId,
    compactionCount: compactions.length,
    lastCompactionLineNumber: last ? last.lineNumber : 0,
    lastCompactionTimestamp: last ? last.timestamp : '',
    compactionHash: hashString(compactions.map(item => `${item.lineNumber}:${item.timestamp}:${item.hash}`).join('\n')).slice(0, 24)
  }
}

const codexSessionFingerprint = file => {
  let sessionId = fallbackSessionIdFromFile(file)
  const compactions = []
  for (const { lineNumber, line } of readLines(file)) {
    if (!line || (!line.includes('"session_meta"') && !line.includes('"compacted"'))) continue
    try {
      const json = JSON.parse(line)
      if (json.type === 'session_meta' && json.payload && json.payload.id) {
        sessionId = json.payload.id
      } else if (json.type === 'compacted') {
        compactions.push({
          lineNumber,
          timestamp: json.timestamp || '',
          hash: hashString(line || stableStringify(json)).slice(0, 16)
        })
      }
    } catch (err) {
      if (line.includes('"compacted"')) {
        compactions.push({
          lineNumber,
          timestamp: '',
          hash: hashString(line).slice(0, 16)
        })
      }
    }
  }
  return fingerprintFromCompactions({ sessionId, compactions })
}

const latestCodexSessionFile = (root = DEFAULT_SESSIONS_ROOT) => {
  const latest = newestFile(codexSessionFiles(root))
  return latest && latest.file
}

const codexSessionFileItems = (root = DEFAULT_SESSIONS_ROOT) => codexSessionFiles(root)
  .map(file => {
    try {
      const stat = fs.statSync(file)
      return { file, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch (_err) {
      return null
    }
  })
  .filter(Boolean)

const sessionMarkerScanLimit = opts => {
  const value = opts.sessionMarkerScanLimit === undefined
    ? process.env.SESSION_INDEXER_SESSION_MARKER_SCAN_LIMIT || DEFAULT_SESSION_MARKER_SCAN_LIMIT
    : opts.sessionMarkerScanLimit
  const text = String(value || '').trim().toLowerCase()
  if (!text || text === 'all' || text === 'off' || text === 'none') return Infinity
  const number = Number(text)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_SESSION_MARKER_SCAN_LIMIT
}

const recentSessionFileItems = (items, opts = {}) => {
  const sorted = [...(items || [])].sort((a, b) =>
    b.mtimeMs - a.mtimeMs ||
    b.size - a.size ||
    a.file.localeCompare(b.file)
  )
  const limit = sessionMarkerScanLimit(opts)
  return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted
}

const normalizeSessionMarker = value => {
  const marker = String(value || '').trim()
  if (!marker) return ''
  return marker.startsWith(SESSION_MARKER_PREFIX) || marker.startsWith(LEGACY_SESSION_MARKER_PREFIX) ? marker : ''
}

const fileContainsLiteral = ({ file, literal, tailBytes = DEFAULT_SESSION_MARKER_SCAN_BYTES }) => {
  const needle = Buffer.from(String(literal || ''))
  if (!needle.length) return null
  const fd = fs.openSync(file, 'r')
  try {
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
  } finally {
    fs.closeSync(fd)
  }
}

const scoreSessionMarkerFile = (item, marker, opts = {}) => {
  const match = fileContainsLiteral({
    file: item.file,
    literal: marker,
    tailBytes: opts.sessionMarkerScanBytes || DEFAULT_SESSION_MARKER_SCAN_BYTES
  })
  if (!match) return null
  return {
    file: item.file,
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

const rowPayload = row => row && !row.parseError && row.json && row.json.payload ? row.json.payload : {}

const resolveCurrentCodexSessionFile = (opts = {}) => {
  const sessionMarker = normalizeSessionMarker(opts.sessionMarker)
  if (!sessionMarker) return null
  const markerCandidates = recentSessionFileItems(codexSessionFileItems(opts.root || DEFAULT_SESSIONS_ROOT), opts)
    .map(item => scoreSessionMarkerFile(item, sessionMarker, opts))
    .filter(Boolean)
  if (!markerCandidates.length) return null
  markerCandidates.sort((a, b) => a.file.localeCompare(b.file))
  if (markerCandidates.length > 1) {
    const err = new Error(`session marker matched multiple Codex session files: ${markerCandidates.map(item => item.file).join(', ')}`)
    err.code = 'AMBIGUOUS_SESSION_MARKER'
    err.candidates = markerCandidates
    throw err
  }
  const selected = markerCandidates[0]
  return {
    ...selected,
    reason: 'session_marker_match',
    candidates: markerCandidates.slice(0, opts.includeCandidates ? opts.limit || 10 : 0)
  }
}

const sourceFor = ({ file, row, payload }) => ({
  sourceKind: 'codex-jsonl',
  path: file,
  lineNumber: row.lineNumber,
  outerType: row.json.type,
  payloadType: payload && payload.type,
  callId: payload && (payload.call_id || payload.callId),
  toolName: payload && payload.name
})

const toolCall = payload => ({
  id: payload.call_id || payload.callId,
  name: payload.name || 'unknown',
  arguments: payload.arguments !== undefined ? payload.arguments : payload.input,
  raw: payload
})

const toolResultOutput = payload => {
  if (payload.output !== undefined) return payload.output
  return stableStringify(payload)
}

const shallowPayload = payload => {
  const out = {}
  for (const [key, value] of Object.entries(payload || {})) {
    if (key === 'base_instructions') continue
    if (key === 'dynamic_tools') {
      out.dynamic_tools = (value || []).map(tool => tool && (tool.name || tool.function && tool.function.name)).filter(Boolean)
    } else if (typeof value === 'string') {
      out[key] = preview(value, 600)
    } else if (Array.isArray(value)) {
      out[key] = `[${value.length} items]`
    } else if (value && typeof value === 'object') {
      out[key] = Object.keys(value)
    } else {
      out[key] = value
    }
  }
  return out
}

const usageDelta = (currentRaw, previousRaw, fallbackRaw) => {
  if (!currentRaw || !Object.keys(currentRaw).length) return normalizeUsage(fallbackRaw)
  const current = normalizeUsage(currentRaw)
  const previous = previousRaw ? normalizeUsage(previousRaw) : normalizeUsage()
  const sawReset = USAGE_FIELDS.some(field => current[field] < previous[field])
  if (sawReset) return current
  return Object.fromEntries(USAGE_FIELDS.map(field => [
    field,
    Math.max(0, current[field] - previous[field])
  ]))
}

const reasoningSummary = payload => {
  const summary = payload && payload.summary
  if (Array.isArray(summary)) {
    return summary.map(part => {
      if (!part) return ''
      if (typeof part === 'string') return part
      return part.text || part.summary_text || stableStringify(part)
    }).filter(Boolean).join('\n')
  }
  return contentText(summary)
}

const rowToEvent = ({ row, file, sessionId, includeResponseMessages, seenResponseMessages, tokenUsageDelta }) => {
  if (row.parseError) {
    return {
      type: 'agent_event',
      role: 'observer',
      at: undefined,
      title: 'jsonl parse error',
      content: row.parseError,
      source: { sourceKind: 'codex-jsonl', path: file, lineNumber: row.lineNumber }
    }
  }
  const outer = row.json.type
  const payload = row.json.payload || {}
  const source = sourceFor({ file, row, payload })
  const at = row.json.timestamp

  if (outer === 'session_meta') {
    return {
      type: 'metadata',
      role: 'system',
      at,
      title: 'session metadata',
      content: shallowPayload(payload),
      source,
      meta: {
        sessionId,
        cwd: payload.cwd,
        modelProvider: payload.model_provider,
        cliVersion: payload.cli_version
      }
    }
  }

  if (outer === 'turn_context') {
    return {
      type: 'context',
      role: 'system',
      at,
      title: 'turn context',
      content: {
        turnId: payload.turn_id,
        cwd: payload.cwd,
        workspaceRoots: payload.workspace_roots,
        currentDate: payload.current_date,
        model: payload.model,
        summary: payload.summary
      },
      source,
      model: payload.model,
      modelFamily: normalizeModelFamily(payload.model)
    }
  }

  if (outer === 'compacted') {
    return {
      type: 'compaction',
      role: 'system',
      at,
      title: 'context compacted',
      content: {
        message: payload.message,
        replacementHistory: payload.replacement_history
      },
      source
    }
  }

  if (outer === 'event_msg' && payload.type === 'user_message') {
    const attachments = [
      ...(payload.images || []),
      ...(payload.local_images || []),
      ...(payload.text_elements || [])
    ].filter(Boolean)
    return {
      type: 'message',
      role: 'user',
      messageId: payload.client_id,
      at,
      title: 'user message',
      content: [
        payload.message || '',
        attachments.length ? `attachments/text elements:\n${stableStringify(attachments)}` : ''
      ].filter(Boolean).join('\n'),
      source,
      meta: {
        clientId: payload.client_id
      }
    }
  }

  if (outer === 'event_msg' && payload.type === 'agent_message') {
    return {
      type: 'message',
      role: 'assistant',
      at,
      title: payload.phase ? `assistant message (${payload.phase})` : 'assistant message',
      content: payload.message || '',
      source,
      meta: {
        phase: payload.phase,
        memoryCitation: payload.memory_citation
      }
    }
  }

  if (outer === 'event_msg' && payload.type === 'token_count') {
    const info = payload.info || {}
    const lastUsage = info.last_token_usage || payload.last_token_usage || {}
    const totalUsage = info.total_token_usage || payload.total_token_usage || {}
    const deltaUsage = tokenUsageDelta || usageDelta(totalUsage, undefined, lastUsage)
    return {
      type: 'usage',
      role: 'observer',
      at,
      title: 'token usage',
      content: {
        usage: deltaUsage,
        cumulativeUsage: normalizeUsage(totalUsage),
        modelContextWindow: info.model_context_window
      },
      usage: deltaUsage,
      source,
      meta: {
        cumulativeUsage: normalizeUsage(totalUsage),
        rawLastUsage: lastUsage,
        rawTotalUsage: totalUsage,
        modelContextWindow: info.model_context_window,
        rateLimits: payload.rate_limits
      }
    }
  }

  if (outer === 'event_msg' && payload.type === 'patch_apply_end') {
    return {
      type: 'tool_result',
      role: 'tool',
      at,
      title: 'apply_patch result',
      callId: payload.call_id,
      toolName: 'apply_patch',
      output: stableStringify({
        stdout: payload.stdout,
        stderr: payload.stderr,
        success: payload.success,
        changes: payload.changes,
        status: payload.status
      }),
      source
    }
  }

  if (outer === 'event_msg' && payload.type === 'web_search_end') {
    return {
      type: 'tool_result',
      role: 'tool',
      at,
      title: 'web search result',
      callId: payload.call_id || `web_search_${row.lineNumber}`,
      toolName: 'web_search',
      output: stableStringify({
        query: payload.query,
        action: payload.action
      }),
      source
    }
  }

  if (outer !== 'response_item') {
    return null
  }

  if (payload.type === 'message') {
    if (!includeResponseMessages) return null
    const text = contentText(payload.content)
    if (!text) return null
    const key = hashString(`${payload.role || 'message'}\n${text}`)
    if (seenResponseMessages.has(key)) return null
    seenResponseMessages.add(key)
    return {
      type: 'message',
      role: payload.role || 'observer',
      at,
      title: `${payload.role || 'message'} response item`,
      content: text,
      source
    }
  }

  if (payload.type === 'reasoning') {
    const summary = reasoningSummary(payload)
    if (!summary && !payload.encrypted_content) return null
    return {
      type: 'reasoning',
      role: 'assistant',
      at,
      title: 'reasoning summary',
      reasoning: [{
        modelFamily: 'openai',
        summary,
        encrypted: payload.encrypted_content,
        raw: payload
      }],
      source
    }
  }

  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    return {
      type: 'tool_call',
      role: 'assistant',
      at,
      title: `tool call ${payload.name || 'unknown'}`,
      call: toolCall(payload),
      source
    }
  }

  if (payload.type === 'web_search_call') {
    return {
      type: 'tool_call',
      role: 'assistant',
      at,
      title: 'web search call',
      call: {
        id: payload.call_id || `web_search_${row.lineNumber}`,
        name: 'web_search',
        arguments: payload.action || payload,
        raw: payload
      },
      source
    }
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    return {
      type: 'tool_result',
      role: 'tool',
      at,
      title: 'tool result',
      callId: payload.call_id,
      output: toolResultOutput(payload),
      source
    }
  }

  return null
}

const importCodexJsonl = (file, opts = {}) => {
  let sessionId = fallbackSessionIdFromFile(file)
  const compactions = []
  const names = opts.sessionNames || readSessionNames(opts.sessionIndex || DEFAULT_SESSION_INDEX)
  const stat = fs.statSync(file)
  let firstAt
  let meta
  let previousTokenUsage
  const seenResponseMessages = new Set()
  const events = []

  for (const row of readJsonlRows(file)) {
    if (!row.parseError && row.json.type === 'session_meta' && row.json.payload && row.json.payload.id) {
      sessionId = row.json.payload.id
    }
    if (!row.parseError && row.json.type === 'compacted') {
      compactions.push({
        lineNumber: row.lineNumber,
        timestamp: row.json.timestamp || '',
        hash: hashString(row.raw || stableStringify(row.json)).slice(0, 16)
      })
    }
    const payload = row.parseError ? {} : row.json.payload || {}
    const totalUsage = !row.parseError && row.json.type === 'event_msg' && payload.type === 'token_count'
      ? payload.info && payload.info.total_token_usage || payload.total_token_usage
      : undefined
    const lastUsage = !row.parseError && row.json.type === 'event_msg' && payload.type === 'token_count'
      ? payload.info && payload.info.last_token_usage || payload.last_token_usage
      : undefined
    const tokenUsageDelta = totalUsage ? usageDelta(totalUsage, previousTokenUsage, lastUsage) : undefined
    const event = rowToEvent({
      row,
      file,
      sessionId,
      includeResponseMessages: Boolean(opts.includeResponseMessages),
      seenResponseMessages,
      tokenUsageDelta
    })
    if (totalUsage) previousTokenUsage = totalUsage
    if (event && event.at && !firstAt) firstAt = event.at
    if (event) {
      events.push(event)
      if (!meta && event.type === 'metadata') meta = event
    }
  }

  const fingerprint = fingerprintFromCompactions({ sessionId, compactions })
  const title = names.get(sessionId) || `Codex session ${sessionId}`
  return createSessionIR({
    source: {
      kind: 'codex-jsonl',
      path: file,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      fingerprint
    },
    session: {
      id: sessionId,
      title,
      startedAt: firstAt,
      updatedAt: stat.mtime.toISOString(),
      cwd: meta && meta.meta && meta.meta.cwd,
      agent: 'codex',
      model: meta && meta.meta && meta.meta.modelProvider,
      modelFamily: normalizeModelFamily(meta && meta.meta && meta.meta.modelProvider)
    },
    events
  })
}

module.exports = {
  DEFAULT_SESSION_INDEX,
  DEFAULT_SESSIONS_ROOT,
  codexSessionFiles,
  codexSessionFingerprint,
  importCodexJsonl,
  latestCodexSessionFile,
  readSessionNames,
  resolveCurrentCodexSessionFile
}
