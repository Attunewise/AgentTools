const { hashString, stableStringify } = require('./util.js')

const IR_SCHEMA = 'session-indexer.coding-session-ir.v1'

const MODEL_FAMILIES = new Set([
  'openai',
  'anthropic',
  'google',
  'unknown'
])

const EVENT_TYPES = new Set([
  'metadata',
  'context',
  'message',
  'reasoning',
  'tool_call',
  'tool_result',
  'compaction',
  'usage',
  'agent_event'
])

const USAGE_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'reasoning',
  'total'
]

const ROLES = new Set([
  'system',
  'developer',
  'user',
  'assistant',
  'tool',
  'observer'
])

const compactObject = value => Object.fromEntries(
  Object.entries(value).filter(([, child]) => child !== undefined && child !== null && child !== '')
)

const array = value => Array.isArray(value) ? value : value == null ? [] : [value]

const textBlock = text => ({
  type: 'text',
  text: String(text || '')
})

const jsonBlock = value => ({
  type: 'json',
  json: value
})

const emptyUsage = () => Object.fromEntries(USAGE_FIELDS.map(field => [field, 0]))

const tokenNumber = value => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

const firstTokenNumber = values => {
  for (const value of values) {
    const number = tokenNumber(value)
    if (number) return number
  }
  return 0
}

const normalizeUsage = usage => {
  const value = usage || {}
  const inputDetails = value.input_tokens_details || value.prompt_tokens_details || {}
  const outputDetails = value.output_tokens_details || value.completion_tokens_details || {}
  const out = {
    input: firstTokenNumber([
      value.input,
      value.input_tokens,
      value.inputTokens,
      value.prompt_tokens,
      value.promptTokens
    ]),
    output: firstTokenNumber([
      value.output,
      value.output_tokens,
      value.outputTokens,
      value.completion_tokens,
      value.completionTokens
    ]),
    cache_read: firstTokenNumber([
      value.cache_read,
      value.cacheRead,
      value.cached_input_tokens,
      value.cachedInputTokens,
      value.cache_read_input_tokens,
      value.cacheReadInputTokens,
      value.cache_read_tokens,
      value.prefill_read_tokens,
      value.prefillReadTokens,
      inputDetails.cached_tokens,
      inputDetails.cache_read_tokens
    ]),
    cache_write: firstTokenNumber([
      value.cache_write,
      value.cacheWrite,
      value.cache_creation_input_tokens,
      value.cacheCreationInputTokens,
      value.cache_write_input_tokens,
      value.cacheWriteInputTokens,
      value.cache_write_tokens,
      value.prefill_write_tokens,
      value.prefillWriteTokens
    ]),
    reasoning: firstTokenNumber([
      value.reasoning,
      value.reasoning_output_tokens,
      value.reasoningOutputTokens,
      value.reasoning_tokens,
      value.reasoningTokens,
      outputDetails.reasoning_tokens,
      outputDetails.reasoningTokens
    ]),
    total: firstTokenNumber([
      value.total,
      value.total_tokens,
      value.totalTokens
    ])
  }
  if (!out.total) out.total = out.input + out.output
  return out
}

const addUsage = (...usages) => {
  const out = emptyUsage()
  for (const usage of usages) {
    const normalized = normalizeUsage(usage)
    for (const field of USAGE_FIELDS) out[field] += normalized[field]
  }
  return out
}

const normalizeContent = content => {
  if (content == null) return []
  if (typeof content === 'string') return content ? [textBlock(content)] : []
  if (!Array.isArray(content)) return [jsonBlock(content)]
  return content.flatMap(part => {
    if (part == null) return []
    if (typeof part === 'string') return [textBlock(part)]
    if (part.type === 'text' && part.text !== undefined) return [textBlock(part.text)]
    if (part.type === 'input_text' && part.text !== undefined) return [textBlock(part.text)]
    if (part.type === 'output_text' && part.text !== undefined) return [textBlock(part.text)]
    if (part.type) return [part]
    return [jsonBlock(part)]
  })
}

const normalizeModelFamily = value => {
  const text = String(value || '').toLowerCase()
  if (text.includes('claude') || text.includes('anthropic')) return 'anthropic'
  if (text.includes('gemini') || text.includes('google')) return 'google'
  if (text.includes('gpt') || text.includes('openai') || text.includes('o3') || text.includes('o4')) return 'openai'
  return MODEL_FAMILIES.has(text) ? text : 'unknown'
}

const normalizeRole = value => {
  const role = String(value || 'observer').toLowerCase()
  return ROLES.has(role) ? role : 'observer'
}

const stableEventId = event => {
  const source = event.source || {}
  return [
    source.sourceKind,
    source.path,
    source.lineNumber,
    event.type,
    event.role,
    event.call && event.call.id,
    event.at
  ].filter(Boolean).join(':') || hashString(stableStringify(event)).slice(0, 24)
}

const fallbackConversationId = (prefix, value) => {
  const text = String(value || '')
  if (!text) return ''
  if (new RegExp(`^${prefix}_[0-9a-f]{20}$`).test(text)) return text
  return `${prefix}_${hashString(text).slice(0, 20)}`
}

const normalizeReasoning = reasoning => array(reasoning).flatMap(item => {
  if (!item) return []
  if (typeof item === 'string') {
    return [{
      modelFamily: 'unknown',
      hasSummary: Boolean(item)
    }]
  }
  return [compactObject({
    modelFamily: normalizeModelFamily(item.modelFamily || item.provider || item.model),
    hasSummary: Boolean(item.hasSummary || item.summary),
    hasEncrypted: Boolean(item.hasEncrypted || item.encrypted || item.encryptedContent || item.encrypted_content),
    hasSignature: Boolean(item.hasSignature || item.signature || item.thoughtSignature || item.openaiSignature)
  })]
})

const normalizeCall = call => {
  if (!call) return undefined
  return compactObject({
    id: call.id || call.callId || call.call_id,
    name: call.name || call.toolName || call.tool_name,
    arguments: call.arguments !== undefined ? call.arguments : call.input,
    raw: call.raw
  })
}

const normalizeEvent = (event, ordinal) => {
  if (!event || typeof event !== 'object') throw new Error('IR event must be an object')
  const type = event.type || 'agent_event'
  if (!EVENT_TYPES.has(type)) throw new Error(`unknown IR event type: ${type}`)
  const normalized = compactObject({
    id: event.id,
    ordinal,
    type,
    at: event.at,
    role: event.role ? normalizeRole(event.role) : undefined,
    title: event.title,
    content: normalizeContent(event.content),
    reasoning: normalizeReasoning(event.reasoning),
    call: normalizeCall(event.call),
    callId: event.callId || event.call_id,
    toolCallId: event.toolCallId || event.tool_call_id || event.callId || event.call_id || event.call && (event.call.id || event.call.callId || event.call.call_id),
    messageId: event.messageId || event.message_id,
    inReplyToMessageId: event.inReplyToMessageId || event.in_reply_to_message_id || event.replyToMessageId || event.reply_to_message_id,
    toolName: event.toolName || event.tool_name,
    output: event.output,
    usage: event.usage ? normalizeUsage(event.usage) : undefined,
    source: event.source,
    model: event.model,
    modelFamily: event.modelFamily ? normalizeModelFamily(event.modelFamily) : undefined,
    meta: event.meta
  })
  normalized.id = normalized.id || stableEventId(normalized)
  return normalized
}

const contextTurnId = event => {
  if (!event || event.type !== 'context') return ''
  for (const block of array(event.content)) {
    if (block && block.json && block.json.turnId) return String(block.json.turnId)
  }
  return ''
}

const withMeta = (event, values) => {
  event.meta = compactObject({
    ...(event.meta || {}),
    ...values
  })
}

const annotateConversationLinks = events => {
  let currentUserMessageId = ''
  let turnRootMessageId = ''
  let awaitingTurnRootUser = false
  let sawTurnContext = false
  for (const event of events) {
    if (event.type === 'message') event.messageId = event.messageId ? String(event.messageId) : fallbackConversationId('msg', event.id)
    if (!event.toolCallId) {
      if (event.type === 'tool_call' && event.call && event.call.id) event.toolCallId = event.call.id
      if (event.type === 'tool_result' && event.callId) event.toolCallId = event.callId
    }
    const turnId = contextTurnId(event)
    if (turnId) {
      sawTurnContext = true
      awaitingTurnRootUser = true
      turnRootMessageId = ''
      withMeta(event, { turnId })
    }
    if (event.type === 'message' && event.role === 'user') {
      if (sawTurnContext) {
        if (awaitingTurnRootUser || !turnRootMessageId) {
          turnRootMessageId = event.messageId || event.id
          currentUserMessageId = turnRootMessageId
          awaitingTurnRootUser = false
          withMeta(event, { turnRoot: true })
        } else {
          withMeta(event, { turnRootMessageId })
        }
      } else {
        currentUserMessageId = event.messageId || event.id
        turnRootMessageId = currentUserMessageId
      }
      continue
    }
    const replyMessageId = sawTurnContext ? (turnRootMessageId || currentUserMessageId) : currentUserMessageId
    if (
      replyMessageId &&
      ['message', 'reasoning', 'tool_call', 'tool_result', 'usage', 'agent_event'].includes(event.type) &&
      event.role !== 'user'
    ) {
      event.inReplyToMessageId = event.inReplyToMessageId || replyMessageId
    }
  }
  return events
}

const createSessionIR = ({ source, session, events }) => {
  const normalizedEvents = annotateConversationLinks((events || []).map(normalizeEvent))
  const id = session && session.id ? String(session.id) : hashString(stableStringify(source)).slice(0, 24)
  const usage = session && session.usage
    ? normalizeUsage(session.usage)
    : addUsage(...normalizedEvents.map(event => event.usage).filter(Boolean))
  return {
    schema: IR_SCHEMA,
    source: compactObject(source || {}),
    session: compactObject({
      id,
      title: session && session.title,
      startedAt: session && session.startedAt,
      updatedAt: session && session.updatedAt,
      cwd: session && session.cwd,
      agent: session && session.agent,
      model: session && session.model,
      modelFamily: session && session.modelFamily ? normalizeModelFamily(session.modelFamily) : normalizeModelFamily(session && session.model),
      usage
    }),
    events: normalizedEvents
  }
}

const blockText = block => {
  if (!block) return ''
  if (typeof block === 'string') return block
  if (block.text !== undefined) return String(block.text)
  if (block.summary !== undefined) return String(block.summary)
  if (block.json !== undefined) return stableStringify(block.json)
  return stableStringify(block)
}

const eventText = event => [
  event.title,
  event.role,
  ...(event.content || []).map(blockText),
  ...(event.reasoning || []).map(item => item.summary || ''),
  event.call && event.call.name,
  event.call && stableStringify(event.call.arguments),
  event.output,
  event.usage && stableStringify(event.usage),
  stableStringify(event.meta)
].filter(Boolean).join('\n')

module.exports = {
  addUsage,
  emptyUsage,
  IR_SCHEMA,
  USAGE_FIELDS,
  blockText,
  createSessionIR,
  eventText,
  normalizeContent,
  normalizeEvent,
  normalizeModelFamily,
  normalizeUsage,
  textBlock
}
