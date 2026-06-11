const {
  browseIndexWithBackend,
  indexStatus,
  openLinkWithBackend,
  searchIndexWithBackend
} = require('./store.js')
const { SESSION_INDEXER_SYSTEM_PROMPT } = require('./mcpServer.js')
const { providerObserver } = require('./providers/ChatObserver.js')
const { compactText } = require('./util.js')

const retrievalToolDefinitions = () => [
  {
    type: 'function',
    function: {
      name: 'conversation_search',
      description: 'Search existing conversation_history transcript indexes. This never indexes on demand.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topic: { type: 'string', description: 'Generated topic phrase only; do not use the session title as a topic.' },
          session_id: { type: 'string' },
          agent: { type: 'string', description: 'Indexed coding agent such as codex or claude, not the speaker role.' },
          within: { type: 'string', description: 'Exact parent handle returned by a previous search result.' },
          filter: {
            description: 'Exact filters. Avoid for broad semantic search until after a result identifies a specific role/id/level.',
            type: 'object',
            properties: {
              agent: { type: 'string', description: 'Indexed coding agent such as codex or claude, not the speaker role.' },
              messageId: { type: 'string' },
              inReplyToMessageId: { type: 'string' },
              toolCallId: { type: 'string' },
              role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool', 'observer'] },
              mip: { type: 'integer', minimum: 0 },
              mipLevel: { type: 'string' }
            }
          },
          start_at: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'conversation_browse',
      description: 'Browse an existing transcript summary hierarchy. Start with session_id, optionally topic_id:"root", then navigate with topic_id values returned by previous browse results.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          agent: { type: 'string', description: 'Indexed coding agent such as codex or claude, not the speaker role.' },
          topic_id: { type: 'string' },
          zoom: { type: 'string', enum: ['children', 'in', 'out', 'siblings'] },
          start: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 }
        },
        required: ['session_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'conversation_openLink',
      description: 'Open a conversation_history link returned by search or browse. Exact text is indicated by isVerbatim and omittedTokenCount.',
      parameters: {
        type: 'object',
        properties: {
          link: { type: 'string' },
          agent: { type: 'string', description: 'Indexed coding agent such as codex or claude, not the speaker role.' },
          budget_tokens: { type: 'integer', minimum: 1, maximum: 200000 }
        },
        required: ['link']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'conversation_index_status',
      description: 'Read compact conversation_history index statuses without indexing.',
      parameters: {
        type: 'object',
        properties: {
          start_at: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          session_id: { type: 'string' }
        },
        required: ['start_at', 'limit']
      }
    }
  }
]

const retrievalSystemPrompt = ({ sessionId, expectedNeedle } = {}) => [
  SESSION_INDEXER_SYSTEM_PROMPT,
  '',
  'You are answering a simulated Codex user after compaction.',
  'Use only the provided conversation_* tools for prior transcript facts.',
  'Do not use start, stop, reset, filesystem, or shell commands.',
  'For broad retrieval, start with conversation_search using query, session_id, and agent only.',
  'Use conversation_browse when a prior browse response gives you a topic_id to navigate. Do not invent browse topic strings.',
  'Do not set filter, within, or search topic until a tool result gives you an exact value to use.',
  'agent means the indexed coding agent such as codex, not the speaker role; filter.role is for user/assistant/tool message roles.',
  'within must be an exact search handle from a prior search result, never words like transcript or session.',
  'search topic is a generated routing topic, not the session title.',
  'When you find a search hit, open the link before relying on exact text.',
  'If the opened render is not verbatim or omittedTokenCount is positive, reopen with a larger budget before answering.',
  sessionId ? `The relevant indexed session id is ${sessionId}.` : '',
  expectedNeedle ? `The evaluation expects one exact fact matching: ${expectedNeedle}.` : ''
].filter(Boolean).join('\n')

const parseArguments = value => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch (_err) {
    return {}
  }
}

const observeAssistantMessage = async ({ response, observerName, model }) => new Promise((resolve, reject) => {
  let final
  providerObserver(observerName, response, model, () => false).subscribe({
    next: value => {
      if (value && value.message) final = value
    },
    error: reject,
    complete: () => resolve(final && final.message ? final : {
      message: { role: 'assistant', content: '' },
      usage: final && final.usage
    })
  })
})

const toolOutput = value => JSON.stringify(value, null, 2)

const cleanFilter = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '') continue
    out[key] = item
  }
  return out
}

const cleanWithin = value => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.startsWith('session/') ? text : undefined
}

const executeRetrievalTool = async ({ name, args, context }) => {
  const root = context.indexDir || context.root
  const backendOpts = {
    searchBackend: context.searchBackend || 'typesense',
    root,
    indexDir: root,
    typesenseApiKey: context.typesenseApiKey,
    typesenseCollection: context.typesenseCollection,
    typesenseVersion: context.typesenseVersion,
    typesenseImportChunkSize: context.typesenseImportChunkSize
  }
  if (name === 'conversation_search') {
    const filter = cleanFilter(args.filter)
    const agent = args.agent || context.agent || filter.agent || undefined
    const result = await searchIndexWithBackend({
      query: args.query || '',
      topic: args.topic || undefined,
      sessionId: args.session_id || context.sessionId || undefined,
      agent,
      within: cleanWithin(args.within),
      filter: {
        ...filter,
        ...(agent ? { agent } : {})
      },
      startAt: args.start_at || 0,
      limit: args.limit || 10,
      ...backendOpts
    })
    return {
      schema: 'session-indexer.search.v1',
      ...(args.query ? { query: args.query } : {}),
      ...(args.topic ? { topic: args.topic } : {}),
      ...(agent ? { agent } : {}),
      hits: result.hits
    }
  }
  if (name === 'conversation_browse') {
    const browsed = await browseIndexWithBackend({
      sessionId: args.session_id || context.sessionId,
      agent: args.agent || context.agent || undefined,
      topicId: args.topic_id || undefined,
      zoom: args.zoom || undefined,
      start: args.start || 0,
      limit: args.limit || 20,
      ...backendOpts
    })
    return {
      schema: 'session-indexer.browse.v1',
      ...browsed.result
    }
  }
  if (name === 'conversation_openLink') {
    const opened = await openLinkWithBackend({
      link: args.link,
      sessionId: context.sessionId,
      agent: args.agent || context.agent || undefined,
      budgetTokens: args.budget_tokens || 1200,
      ...backendOpts
    })
    return {
      schema: 'session-indexer.openLink.v1',
      ...opened.result
    }
  }
  if (name === 'conversation_index_status') {
    return {
      schema: 'session-indexer.index_status.v1',
      indexDir: root,
      ...indexStatus({
        root,
        sessionId: args.session_id || context.sessionId || undefined,
        startAt: args.start_at || 0,
        limit: args.limit || 10
      })
    }
  }
  throw new Error(`unsupported retrieval evaluation tool: ${name}`)
}

const runRetrievalEvaluation = async ({
  provider,
  observerName = 'openai-responses',
  model,
  callOptions = {},
  question,
  expectedAnswer,
  context,
  maxTurns = 8
}) => {
  if (!provider || typeof provider.chat !== 'function') throw new Error('runRetrievalEvaluation requires a provider with chat(messages, options)')
  if (!question) throw new Error('runRetrievalEvaluation requires a question')
  const trace = []
  const openedRecords = []
  const messages = [
    { role: 'system', content: retrievalSystemPrompt({ sessionId: context && context.sessionId, expectedNeedle: expectedAnswer }) },
    { role: 'user', content: question }
  ]
  const options = {
    ...callOptions,
    model: callOptions.model || model,
    tools: retrievalToolDefinitions(),
    tool_choice: callOptions.tool_choice || 'auto'
  }
  let finalMessage = null

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await provider.chat(messages, options)
    const observed = await observeAssistantMessage({
      response,
      observerName,
      model: options.model || model
    })
    const message = observed.message || { role: 'assistant', content: '' }
    const toolCalls = message.tool_calls || []
    trace.push({
      type: 'assistant',
      content: compactText(message.content || ''),
      toolCalls: toolCalls.map(call => ({
        id: call.id,
        name: call.function && call.function.name,
        arguments: parseArguments(call.function && call.function.arguments)
      }))
    })
    messages.push(message)
    if (!toolCalls.length) {
      finalMessage = message
      break
    }
    for (const call of toolCalls) {
      const name = call.function && call.function.name
      const args = parseArguments(call.function && call.function.arguments)
      let result
      try {
        result = await executeRetrievalTool({
          name,
          args,
          context: context || {}
        })
      } catch (err) {
        result = {
          schema: 'session-indexer.tool-error.v1',
          tool: name,
          error: err && err.message ? err.message : String(err)
        }
      }
      trace.push({
        type: 'tool',
        toolCallId: call.id,
        name,
        arguments: args,
        result
      })
      if (name === 'conversation_openLink' && result.schema !== 'session-indexer.tool-error.v1') openedRecords.push(result)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolOutput(result)
      })
    }
  }

  const finalAnswer = compactText(finalMessage && finalMessage.content || '')
  const expectedFound = expectedAnswer
    ? finalAnswer.includes(expectedAnswer)
    : Boolean(finalAnswer)
  const searchCalled = trace.some(item => item.type === 'tool' && item.name === 'conversation_search')
  const openLinkCalled = trace.some(item => item.type === 'tool' && item.name === 'conversation_openLink')
  const groundedOpen = openedRecords.find(item =>
    item &&
    item.isVerbatim === true &&
    Number(item.omittedTokenCount || 0) === 0 &&
    (!expectedAnswer || String(item.content || '').includes(expectedAnswer))
  )
  return {
    schema: 'session-indexer.retrieval-evaluation.v1',
    passed: Boolean(finalMessage && expectedFound && searchCalled && openLinkCalled && groundedOpen),
    finalAnswer,
    expectedAnswer,
    ...(!finalMessage ? { error: `retrieval evaluation did not finish within ${maxTurns} turns` } : {}),
    checks: {
      expectedAnswerInFinal: expectedFound,
      searchCalled,
      openLinkCalled,
      openedVerbatimEvidence: Boolean(groundedOpen),
      toolErrorCount: trace.filter(item => item.type === 'tool' && item.result && item.result.schema === 'session-indexer.tool-error.v1').length
    },
    evidence: groundedOpen
      ? {
          link: groundedOpen.link,
          handle: groundedOpen.handle,
          isVerbatim: groundedOpen.isVerbatim,
          omittedTokenCount: groundedOpen.omittedTokenCount || 0
        }
      : null,
    trace
  }
}

module.exports = {
  executeRetrievalTool,
  retrievalSystemPrompt,
  retrievalToolDefinitions,
  runRetrievalEvaluation
}
