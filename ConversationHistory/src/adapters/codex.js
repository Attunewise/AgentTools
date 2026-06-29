const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  createSessionIR,
  normalizeModelFamily,
  normalizeUsage,
  USAGE_FIELDS
} = require('../ir.js')
const { loadCodexSessionTools } = require('../codexSessionTools.js')

const {
  latestCodexSessionFile: latestCodexSessionFileFromTools,
  resolveCodexSessionForMarker,
  walkJsonlFiles: walkCodexJsonlFiles
} = loadCodexSessionTools()
const {
  hashString,
  preview,
  readJsonlRows,
  readLines,
  stableStringify
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

const codexSessionFiles = (root = DEFAULT_SESSIONS_ROOT) => walkCodexJsonlFiles(root).map(item => item.file)

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

const latestCodexSessionFile = (root = DEFAULT_SESSIONS_ROOT) => latestCodexSessionFileFromTools(root)

const normalizeSessionMarker = value => {
  const marker = String(value || '').trim()
  if (!marker) return ''
  return marker.startsWith(SESSION_MARKER_PREFIX) || marker.startsWith(LEGACY_SESSION_MARKER_PREFIX) ? marker : ''
}

const rowPayload = row => row && !row.parseError && row.json && row.json.payload ? row.json.payload : {}

const resolveCurrentCodexSessionFile = (opts = {}) => {
  const sessionMarker = normalizeSessionMarker(opts.sessionMarker)
  if (!sessionMarker) return null
  const selected = resolveCodexSessionForMarker(opts.root || DEFAULT_SESSIONS_ROOT, sessionMarker, {
    ...opts,
    sessionMarkerScanBytes: opts.sessionMarkerScanBytes || DEFAULT_SESSION_MARKER_SCAN_BYTES,
    sessionMarkerScanLimit: opts.sessionMarkerScanLimit === undefined
      ? process.env.SESSION_INDEXER_SESSION_MARKER_SCAN_LIMIT || DEFAULT_SESSION_MARKER_SCAN_LIMIT
      : opts.sessionMarkerScanLimit
  })
  if (!selected) return null
  return {
    ...selected,
    mtimeMs: selected.mtimeMs || selected.mtime_ms,
    candidates: selected.candidates || []
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
      title: 'reasoning record',
      reasoning: [{
        modelFamily: 'openai',
        hasSummary: Boolean(summary),
        hasEncrypted: Boolean(payload.encrypted_content)
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

const duplicateResponseMessageKey = event => {
  if (!event || event.type !== 'message') return ''
  const text = String(event.content || '').replace(/\s+/g, ' ').trim()
  return text ? `${event.role || ''}\n${text}` : ''
}

const duplicateResponseMessagePreference = event => {
  const source = event && event.source || {}
  if (source.outerType === 'event_msg' && source.payloadType === 'user_message') return 4
  if (source.outerType === 'response_item' && source.payloadType === 'message' && event.role === 'assistant') return 4
  if (source.outerType === 'response_item' && source.payloadType === 'message') return 3
  if (source.outerType === 'event_msg' && source.payloadType === 'agent_message') return 3
  return 1
}

const removeDuplicateResponseMessages = events => {
  const best = new Map()
  for (const [index, event] of events.entries()) {
    const key = duplicateResponseMessageKey(event)
    if (!key) continue
    const preference = duplicateResponseMessagePreference(event)
    const previous = best.get(key)
    if (!previous || preference > previous.preference) {
      best.set(key, { index, preference })
    }
  }
  return events.filter((event, index) => {
    const key = duplicateResponseMessageKey(event)
    return !key || best.get(key).index === index
  })
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
      includeResponseMessages: opts.includeResponseMessages !== false,
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
    events: removeDuplicateResponseMessages(events)
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
