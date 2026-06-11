const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { hashString, stableStringify } = require('./util.js')

const PI_SESSION_VERSION = 3

const defaultPiAgentDir = () => path.join(os.homedir(), '.pi', 'agent')

const piSessionDirForCwd = (cwd, agentDir = defaultPiAgentDir()) => {
  const resolvedCwd = path.resolve(cwd || process.cwd())
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return path.join(agentDir, 'sessions', safePath)
}

const piSessionFileFor = ({ cwd, sessionId, startedAt, agentDir }) => {
  const stamp = compactTimestamp(startedAt || new Date().toISOString())
  return path.join(piSessionDirForCwd(cwd, agentDir), `${stamp}_${sessionId}.jsonl`)
}

const compactTimestamp = value => {
  const date = new Date(value || Date.now())
  const safe = Number.isNaN(date.getTime()) ? new Date() : date
  return safe.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

const uuidFrom = value => {
  const hex = hashString(value).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const shortIdFactory = () => {
  const used = new Set()
  return value => {
    for (let nonce = 0; nonce < 1000; nonce++) {
      const id = hashString(`${value}:${nonce}`).slice(0, 8)
      if (!used.has(id)) {
        used.add(id)
        return id
      }
    }
    let id
    do {
      id = crypto.randomUUID().slice(0, 8)
    } while (used.has(id))
    used.add(id)
    return id
  }
}

const eventTimestampIso = (event, fallback) => {
  const date = new Date(event && event.at || fallback || Date.now())
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString()
}

const eventTimestampMs = (event, fallback) => new Date(eventTimestampIso(event, fallback)).getTime()

const textFromContent = content => {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stableStringify(content)
  return content.map(block => {
    if (!block) return ''
    if (typeof block === 'string') return block
    if (block.type === 'text' && block.text !== undefined) return block.text
    return stableStringify(block)
  }).filter(Boolean).join('\n')
}

const piTextBlocks = text => {
  const value = String(text || '')
  return value ? [{ type: 'text', text: value }] : []
}

const compactionPayloadFromEvent = event => {
  const rawContent = event && event.content
  const jsonBlock = Array.isArray(rawContent)
    ? rawContent.find(block => block && block.type === 'json' && block.json && typeof block.json === 'object')
    : null
  const content = jsonBlock ? jsonBlock.json : rawContent
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return {
      message: typeof content.message === 'string' ? content.message : '',
      replacementHistory: Array.isArray(content.replacementHistory)
        ? content.replacementHistory
        : Array.isArray(content.replacement_history) ? content.replacement_history : []
    }
  }
  return {
    message: textFromContent(content),
    replacementHistory: []
  }
}

const compactionSummaryFromPayload = payload => {
  const message = String(payload && payload.message || '').trim()
  if (message) {
    return {
      summary: message,
      summarySource: 'codex.payload.message'
    }
  }
  return {
    summary: [
      'Codex compacted earlier conversation history at this point.',
      'The source Codex JSONL did not contain a plaintext compaction summary; original replacement_history evidence is preserved in this entry details.'
    ].join(' '),
    summarySource: 'fallback:no-plaintext-codex-summary'
  }
}

const estimateCompactionTokensBefore = payload => {
  const replacementHistory = payload && payload.replacementHistory
  const source = Array.isArray(replacementHistory) && replacementHistory.length
    ? stableStringify(replacementHistory)
    : String(payload && payload.message || '')
  return Math.max(1, Math.ceil(source.length / 4))
}

const piUsage = usage => ({
  input: Number(usage && usage.input || 0),
  output: Number(usage && usage.output || 0),
  cacheRead: Number(usage && usage.cache_read || usage && usage.cacheRead || 0),
  cacheWrite: Number(usage && usage.cache_write || usage && usage.cacheWrite || 0),
  totalTokens: Number(usage && usage.total || usage && usage.totalTokens || 0),
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0
  }
})

const providerFrom = (event, ir) => {
  const family = event && event.modelFamily || ir.session.modelFamily
  if (family === 'anthropic') return 'anthropic'
  if (family === 'google') return 'google'
  if (family === 'openai') return 'openai'
  return ir.session.model && /codex/i.test(ir.session.model) ? 'openai-codex' : 'openai'
}

const apiFromProvider = provider => {
  if (provider === 'anthropic') return 'anthropic-messages'
  if (provider === 'google') return 'google-generative-ai'
  if (provider === 'openai-codex') return 'openai-codex-responses'
  return 'openai-responses'
}

const modelFrom = (event, ir) => event && event.model || ir.session.model || 'imported-codex-session'

const assistantMessage = ({ content, event, ir, stopReason = 'stop' }) => {
  const provider = providerFrom(event, ir)
  return {
    role: 'assistant',
    content,
    api: apiFromProvider(provider),
    provider,
    model: modelFrom(event, ir),
    usage: piUsage(event && event.usage),
    stopReason,
    timestamp: eventTimestampMs(event, ir.session.startedAt)
  }
}

const piToolCallMessageForEvent = ({ event, ir, callId }) => assistantMessage({
  content: [{
    type: 'toolCall',
    id: String(callId || event.call.id || event.toolCallId || event.id),
    name: String(event.call.name || event.toolName || 'unknown'),
    arguments: event.call.arguments && typeof event.call.arguments === 'object'
      ? event.call.arguments
      : { input: event.call.arguments }
  }],
  event,
  ir,
  stopReason: 'toolUse'
})

const piToolResultMessageForEvent = ({ event, toolCallId }) => {
  const text = typeof event.output === 'string' ? event.output : stableStringify(event.output)
  return {
    role: 'toolResult',
    toolCallId: String(toolCallId || event.toolCallId || event.callId || event.id),
    toolName: String(event.toolName || 'unknown'),
    content: piTextBlocks(text),
    isError: Boolean(event.meta && event.meta.isError),
    timestamp: eventTimestampMs(event)
  }
}

const piMessageForEvent = (event, ir) => {
  if (event.type === 'message' && event.role === 'user') {
    const text = textFromContent(event.content)
    if (!text) return null
    return {
      role: 'user',
      content: text,
      timestamp: eventTimestampMs(event, ir.session.startedAt)
    }
  }

  if (event.type === 'message' && event.role === 'assistant') {
    const content = piTextBlocks(textFromContent(event.content))
    if (!content.length) return null
    return assistantMessage({ content, event, ir })
  }

  if (event.type === 'reasoning') {
    const text = (event.reasoning || [])
      .map(item => item && item.summary)
      .filter(Boolean)
      .join('\n')
    if (!text) return null
    return assistantMessage({
      content: [{ type: 'thinking', thinking: text }],
      event,
      ir
    })
  }

  if (event.type === 'tool_call' && event.call) {
    return piToolCallMessageForEvent({ event, ir })
  }

  if (event.type === 'tool_result') {
    return piToolResultMessageForEvent({ event })
  }

  return null
}

const isWebSearchCallEvent = event =>
  event && event.type === 'tool_call' && event.call && event.call.name === 'web_search'

const isWebSearchResultEvent = event =>
  event && event.type === 'tool_result' && event.toolName === 'web_search'

const retainedCustomData = event => ({
  type: event.type,
  role: event.role,
  title: event.title,
  content: event.content,
  source: event.source,
  meta: event.meta
})

const piEntriesFromIr = ir => {
  const nextId = shortIdFactory()
  const cwd = ir.session.cwd || process.cwd()
  const sessionId = uuidFrom(`${ir.session.id}:${ir.source && ir.source.path || ''}`)
  const startedAt = ir.session.startedAt || ir.source && ir.source.mtime || new Date().toISOString()
  const entries = [{
    type: 'session',
    version: PI_SESSION_VERSION,
    id: sessionId,
    timestamp: eventTimestampIso(null, startedAt),
    cwd
  }]

  let parentId = null
  const append = entry => {
    const id = nextId(stableStringify(entry))
    entries.push({
      ...entry,
      id,
      parentId
    })
    parentId = id
    return id
  }

  if (ir.session.title) {
    append({
      type: 'session_info',
      timestamp: eventTimestampIso(null, startedAt),
      name: `Imported Codex: ${ir.session.title}`
    })
  }

  append({
    type: 'custom',
    timestamp: eventTimestampIso(null, startedAt),
    customType: 'session-indexer.import.codex',
    data: {
      sourceSessionId: ir.session.id,
      sourcePath: ir.source && ir.source.path,
      sourceFingerprint: ir.source && ir.source.fingerprint,
      importedAt: new Date().toISOString()
    }
  })

  let pendingWebSearchCall = null
  let pendingWebSearchResult = null

  const appendMessage = (message, atEvent) => append({
    type: 'message',
    timestamp: eventTimestampIso(atEvent, startedAt),
    message
  })

  const appendUnpairedWebSearch = (event, reason) => append({
    type: 'custom',
    timestamp: eventTimestampIso(event, startedAt),
    customType: `session-indexer.import.codex.unpaired-web-search-${event.type === 'tool_call' ? 'call' : 'result'}`,
    data: {
      reason,
      event: retainedCustomData(event)
    }
  })

  const flushPendingWebSearch = reason => {
    if (pendingWebSearchCall) appendUnpairedWebSearch(pendingWebSearchCall, reason)
    if (pendingWebSearchResult) appendUnpairedWebSearch(pendingWebSearchResult, reason)
    pendingWebSearchCall = null
    pendingWebSearchResult = null
  }

  const appendWebSearchPair = (callEvent, resultEvent) => {
    const callId = resultEvent.toolCallId || resultEvent.callId || callEvent.call.id
    appendMessage(piToolCallMessageForEvent({ event: callEvent, ir, callId }), callEvent)
    appendMessage(piToolResultMessageForEvent({ event: resultEvent, toolCallId: callId }), resultEvent)
    pendingWebSearchCall = null
    pendingWebSearchResult = null
  }

  for (const event of ir.events || []) {
    const timestamp = eventTimestampIso(event, startedAt)
    if (isWebSearchCallEvent(event)) {
      if (pendingWebSearchResult) {
        appendWebSearchPair(event, pendingWebSearchResult)
      } else {
        pendingWebSearchCall = event
      }
      continue
    }

    if (isWebSearchResultEvent(event)) {
      if (pendingWebSearchCall) {
        appendWebSearchPair(pendingWebSearchCall, event)
      } else {
        pendingWebSearchResult = event
      }
      continue
    }

    flushPendingWebSearch('intervening non-web-search event')

    if (event.type === 'compaction') {
      const payload = compactionPayloadFromEvent(event)
      const { summary, summarySource } = compactionSummaryFromPayload(payload)
      const firstKeptEntryId = parentId
      append({
        type: 'compaction',
        timestamp,
        summary,
        firstKeptEntryId,
        tokensBefore: estimateCompactionTokensBefore(payload),
        details: {
          importer: 'session-indexer',
          sourceAgent: 'codex',
          summarySource,
          codexMessage: payload.message,
          replacementHistory: payload.replacementHistory,
          source: event.source,
          meta: event.meta
        },
        fromHook: true
      })
      continue
    }

    const message = piMessageForEvent(event, ir)
    if (message) {
      appendMessage(message, event)
    } else if (['metadata', 'context', 'usage', 'agent_event'].includes(event.type)) {
      append({
        type: 'custom',
        timestamp,
        customType: `session-indexer.import.codex.${event.type}`,
        data: retainedCustomData(event)
      })
    }
  }

  flushPendingWebSearch('end of session')

  return {
    sessionId,
    cwd,
    startedAt,
    entries
  }
}

const writePiSession = ({ ir, outputPath, agentDir, force = false }) => {
  const converted = piEntriesFromIr(ir)
  const file = outputPath || piSessionFileFor({
    cwd: converted.cwd,
    sessionId: converted.sessionId,
    startedAt: converted.startedAt,
    agentDir
  })
  if (fs.existsSync(file) && !force) throw new Error(`${file} already exists; pass --force to replace it`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${converted.entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
  return {
    schema: 'session-indexer.pi-session-import.v1',
    sessionId: converted.sessionId,
    sourceSessionId: ir.session.id,
    cwd: converted.cwd,
    path: file,
    entryCount: converted.entries.length,
    messageCount: converted.entries.filter(entry => entry.type === 'message').length,
    compactionCount: converted.entries.filter(entry => entry.type === 'compaction').length
  }
}

module.exports = {
  PI_SESSION_VERSION,
  defaultPiAgentDir,
  piSessionDirForCwd,
  piEntriesFromIr,
  writePiSession
}
