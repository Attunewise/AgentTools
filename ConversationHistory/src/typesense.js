const { compactText, estimateTokens, preview, stableStringify } = require('./util.js')
const { normalizeTopics, parseTopicId, topicIdForHandle, topicsText } = require('./topics.js')
const {
  DEFAULT_MANAGED_TYPESENSE_API_KEY,
  managedRuntimeInfo,
  startManagedTypesense
} = require('./typesenseManaged.js')

const DEFAULT_TYPESENSE_API_KEY = DEFAULT_MANAGED_TYPESENSE_API_KEY
const DEFAULT_TYPESENSE_COLLECTION = process.env.TYPESENSE_COLLECTION || 'session_indexer_docs'

const sessionLink = ({ sessionId, handle }) => {
  const params = new URLSearchParams()
  params.set('sessionId', sessionId)
  params.set('handle', handle)
  return `tool:conversation_history://open?${params.toString()}`
}

const parseSessionLink = link => {
  const text = String(link || '')
  if (text.startsWith('session/')) return { handle: text }
  const match = text.match(/^tool:(?:conversation_history|ConversationHistory):\/\/open\?(.+)$/)
  if (!match) return null
  const params = new URLSearchParams(match[1])
  return {
    sessionId: params.get('sessionId') || undefined,
    handle: params.get('handle') || undefined
  }
}

const compactJson = value => value === undefined ? '' : JSON.stringify(value)

const compactSummaryMeta = meta => {
  if (!meta) return {}
  const keys = [
    'strategy',
    'mode',
    'provider',
    'model',
    'reasoningEffort',
    'status',
    'reused',
    'summaryLevel',
    'inputTokenBudget',
    'inputTokenCount',
    'generatedAt'
  ]
  const compact = {}
  for (const key of keys) {
    if (meta[key] !== undefined && meta[key] !== null && meta[key] !== '') compact[key] = meta[key]
  }
  return compact
}

const requireStringField = (value, field, context) => {
  const text = String(value || '')
  if (!text) throw new Error(`${context} requires ${field}`)
  return text
}

const requireSessionId = (sessionId, context) => requireStringField(sessionId, 'sessionId', context)
const requireAgent = (agent, context) => requireStringField(agent, 'agent', context)

const parseJsonField = (value, fallback, label, id) => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch (err) {
    throw new Error(`Typesense hit ${label} is invalid JSON for document ${id || '<unknown>'}: ${err.message}`)
  }
}

const typesenseConfig = (opts = {}) => ({
  apiKey: opts.typesenseApiKey || opts.apiKey || DEFAULT_TYPESENSE_API_KEY,
  collection: opts.typesenseCollection || opts.collection || DEFAULT_TYPESENSE_COLLECTION
})

const resolveTypesenseConfig = async (opts = {}) => {
  const config = typesenseConfig(opts)
  const runtime = await managedRuntimeInfo({
    root: opts.indexDir || opts.root,
    version: opts.typesenseVersion
  })
  return {
    ...config,
    url: runtime.url,
    managed: runtime
  }
}

const ensureManagedTypesense = async (config, opts = {}) => {
  const result = await startManagedTypesense({
    root: opts.indexDir || opts.root,
    version: opts.typesenseVersion,
    apiKey: config.apiKey,
    install: opts.typesenseInstall !== false,
    timeoutMs: Number(opts.typesenseStartTimeoutMs || opts.startTimeoutMs || 30000)
  })
  config.url = result.url
  config.managed = result
  return result
}

const request = async (config, method, pathname, opts = {}) => {
  if (typeof fetch !== 'function') throw new Error('global fetch is not available in this Node.js runtime')
  const response = await fetch(`${config.url}${pathname}`, {
    method,
    headers: {
      'X-TYPESENSE-API-KEY': config.apiKey,
      ...(opts.body ? { 'Content-Type': opts.contentType || 'application/json' } : {})
    },
    body: opts.body
  })
  const text = await response.text()
  if (!response.ok) {
    const message = text ? preview(text, 500) : `HTTP ${response.status}`
    const err = new Error(`Typesense ${method} ${pathname} failed: ${message}`)
    err.status = response.status
    throw err
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (_err) {
    return text
  }
}

const isCollectionNotFoundError = err => {
  if (!err || err.status !== 404) return false
  return /collection not found/i.test(String(err.message || ''))
}

const collectionSchema = collection => ({
  name: collection,
  fields: [
    { name: 'sessionId', type: 'string', facet: true },
    { name: 'agent', type: 'string', facet: true },
    { name: 'sourceKind', type: 'string', facet: true, optional: true },
    { name: 'handle', type: 'string' },
    { name: 'parentHandle', type: 'string', facet: true, optional: true },
    { name: 'link', type: 'string', optional: true, index: false },
    { name: 'messageId', type: 'string', facet: true, optional: true },
    { name: 'inReplyToMessageId', type: 'string', facet: true, optional: true },
    { name: 'toolCallId', type: 'string', facet: true, optional: true },
    { name: 'role', type: 'string', facet: true, optional: true },
    { name: 'depth', type: 'int32', facet: true },
    { name: 'kind', type: 'string', facet: true },
    { name: 'mipLevel', type: 'string', facet: true },
    { name: 'isVerbatim', type: 'bool', facet: true },
    { name: 'at', type: 'string', optional: true, index: false },
    { name: 'timeRangeStart', type: 'string', optional: true, index: false },
    { name: 'timeRangeEnd', type: 'string', optional: true, index: false },
    { name: 'nodeIndex', type: 'string', optional: true, index: false },
    { name: 'zoom', type: 'string', optional: true, index: false },
    { name: 'siblingIndex', type: 'int32', sort: true },
    { name: 'navigationJson', type: 'string', optional: true, index: false },
    { name: 'title', type: 'string' },
    { name: 'breadcrumb', type: 'string', optional: true },
    { name: 'summary', type: 'string' },
    { name: 'summaryModel', type: 'string', optional: true, facet: true },
    { name: 'summaryMetaJson', type: 'string', optional: true, index: false },
    { name: 'topicsText', type: 'string', optional: true },
    { name: 'topicsJson', type: 'string', optional: true, index: false },
    { name: 'searchText', type: 'string' },
    { name: 'excerpt', type: 'string', optional: true },
    { name: 'content', type: 'string', optional: true, index: false },
    { name: 'resourceLinksJson', type: 'string', optional: true, index: false },
    { name: 'usageJson', type: 'string', optional: true, index: false },
    { name: 'metricsJson', type: 'string', optional: true, index: false },
    { name: 'ts', type: 'int64', sort: true }
  ],
  default_sorting_field: 'ts'
})

const fieldSignature = (field, expected = field) => JSON.stringify({
  name: field.name,
  type: field.type,
  optional: Boolean(field.optional),
  facet: Boolean(field.facet),
  index: field.index === false ? false : true,
  ...(expected.sort !== undefined ? { sort: Boolean(field.sort) } : {})
})

const collectionNeedsRecreate = (existing, schema) => {
  const existingByName = new Map((existing.fields || []).map(field => [field.name, field]))
  const expectedNames = new Set(schema.fields.map(field => field.name))
  if ((existing.fields || []).some(field => !expectedNames.has(field.name))) return true
  for (const field of schema.fields) {
    const actual = existingByName.get(field.name)
    if (!actual) continue
    if (fieldSignature(actual, field) !== fieldSignature(field, field)) return true
  }
  return false
}

const ensureCollection = async (config, opts = {}) => {
  await ensureManagedTypesense(config, opts)
  const schema = collectionSchema(config.collection)
  try {
    const existing = await request(config, 'GET', `/collections/${encodeURIComponent(config.collection)}`)
    if (collectionNeedsRecreate(existing, schema)) {
      await request(config, 'DELETE', `/collections/${encodeURIComponent(config.collection)}`)
      return request(config, 'POST', '/collections', {
        body: JSON.stringify(schema)
      })
    }
    const existingNames = new Set((existing.fields || []).map(field => field.name))
    const missingFields = schema.fields.filter(field => !existingNames.has(field.name))
    if (missingFields.length) {
      return request(config, 'PATCH', `/collections/${encodeURIComponent(config.collection)}`, {
        body: JSON.stringify({ fields: missingFields })
      })
    }
    return existing
  } catch (err) {
    if (err.status !== 404) throw err
  }
  return request(config, 'POST', '/collections', {
    body: JSON.stringify(schema)
  })
}

const docForTypesense = doc => {
  const sessionId = requireSessionId(doc.sessionId, 'Typesense document')
  const agent = requireAgent(doc.agent, 'Typesense document')
  const navigation = doc.navigation || {}
  const timeRange = doc.timeRange || {}
  const topics = normalizeTopics(doc.topics || [], { max: 0 })
  const resourceLinks = doc.resourceLinks || []
  return {
    id: String(doc.id),
    sessionId,
    agent,
    sourceKind: doc.sourceKind || '',
    handle: String(doc.handle || ''),
    parentHandle: doc.parentHandle || '',
    link: doc.link || (doc.sessionId && doc.handle ? sessionLink({ sessionId: doc.sessionId, handle: doc.handle }) : ''),
    messageId: doc.messageId || '',
    inReplyToMessageId: doc.inReplyToMessageId || '',
    toolCallId: doc.toolCallId || '',
    role: doc.role || '',
    depth: Number(doc.depth || 0),
    kind: String(doc.kind || ''),
    mipLevel: String(doc.mipLevel || ''),
    isVerbatim: Boolean(doc.isVerbatim),
    at: doc.at || '',
    timeRangeStart: timeRange.start || '',
    timeRangeEnd: timeRange.end || '',
    nodeIndex: doc.index || '',
    zoom: doc.zoom || '',
    siblingIndex: Number(navigation.siblingIndex || 0),
    navigationJson: compactJson({
      siblingIndex: Number(navigation.siblingIndex || 0),
      siblingCount: Number(navigation.siblingCount || 0),
      mip: Number(navigation.mip || 0),
      mips: Number(navigation.mips || 0),
      parentHandle: navigation.parentHandle || doc.parentHandle || ''
    }),
    title: doc.title || '',
    breadcrumb: doc.breadcrumb || '',
    summary: doc.summary || '',
    summaryModel: doc.summaryModel || '',
    summaryMetaJson: compactJson(compactSummaryMeta(doc.summaryMeta || {})),
    topicsText: topicsText(topics),
    topicsJson: compactJson(topics),
    searchText: doc.searchText || '',
    excerpt: doc.excerpt || '',
    content: doc.content || '',
    resourceLinksJson: compactJson(resourceLinks),
    usageJson: compactJson(doc.usage || {}),
    metricsJson: compactJson({
      fullTokenCount: Number(doc.fullTokenCount || 0),
      childCount: Number(doc.childCount || 0),
      renderedTokenCount: Number(doc.renderedTokenCount || 0),
      nextLevelTokenCount: Number(doc.nextLevelTokenCount || 0)
    }),
    ts: Number(doc.ts || 0)
  }
}

const filterValue = value => `\`${String(value).replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``

const importChunkSize = opts => Math.max(1, Number(opts.typesenseImportChunkSize || opts.importChunkSize || 500))

const importRows = result => {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object') return [result]
  return String(result || '').split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line)
    } catch (_err) {
      return { success: false, error: line }
    }
  })
}

const deleteSessionDocumentsWithConfig = async (config, sessionId, agent) => {
  if (!sessionId) {
    return {
      backend: 'typesense',
      collection: config.collection,
      deleted: false
    }
  }
  const filters = [`sessionId:=${filterValue(sessionId)}`]
  if (agent) filters.push(`agent:=${filterValue(agent)}`)
  const filter = filters.join(' && ')
  const result = await request(config, 'DELETE', `/collections/${encodeURIComponent(config.collection)}/documents?filter_by=${encodeURIComponent(filter)}`)
  return {
    backend: 'typesense',
    collection: config.collection,
    sessionId,
    agent: agent || undefined,
    deleted: true,
    result
  }
}

const deleteSessionDocuments = async ({ sessionId, agent, ...opts }) => {
  const config = typesenseConfig(opts)
  await ensureCollection(config, opts)
  return deleteSessionDocumentsWithConfig(config, sessionId, agent)
}

const importDocuments = async ({ docs, sessionId, agent, onProgress, ...opts }) => {
  const config = typesenseConfig(opts)
  const expectedSessionId = sessionId ? requireSessionId(sessionId, 'Typesense import session') : null
  const expectedAgent = expectedSessionId
    ? requireAgent(agent, 'Typesense import session')
    : agent ? requireAgent(agent, 'Typesense import agent') : null
  for (let index = 0; index < docs.length; index++) {
    const docSessionId = requireSessionId(docs[index] && docs[index].sessionId, `Typesense import doc ${index}`)
    const docAgent = requireAgent(docs[index] && docs[index].agent, `Typesense import doc ${index}`)
    if (expectedSessionId && docSessionId !== expectedSessionId) {
      throw new Error(`Typesense import doc ${index} sessionId ${JSON.stringify(docSessionId)} does not match import sessionId ${JSON.stringify(expectedSessionId)}`)
    }
    if (expectedAgent && docAgent !== expectedAgent) {
      throw new Error(`Typesense import doc ${index} agent ${JSON.stringify(docAgent)} does not match import agent ${JSON.stringify(expectedAgent)}`)
    }
  }
  await ensureCollection(config, opts)
  const emit = typeof onProgress === 'function' ? onProgress : null
  if (sessionId && !docs.length) {
    if (emit) emit({ phase: 'index:documents:delete:start', sessionId, agent: expectedAgent || undefined })
    await deleteSessionDocumentsWithConfig(config, sessionId, expectedAgent)
    if (emit) emit({ phase: 'index:documents:delete:done', sessionId, agent: expectedAgent || undefined })
  }
  if (!docs.length) {
    return {
      backend: 'typesense',
      collection: config.collection,
      imported: 0
    }
  }
  if (sessionId && emit) {
    emit({
      phase: 'index:documents:upsert:preserve-existing',
      sessionId,
      agent: expectedAgent || undefined,
      docCount: docs.length
    })
  }
  let imported = 0
  const chunkSize = importChunkSize(opts)
  const chunkCount = Math.ceil(docs.length / chunkSize)
  if (emit) {
    emit({
      phase: 'index:documents:import:start',
      sessionId,
      agent: expectedAgent || undefined,
      docCount: docs.length,
      chunkSize,
      chunkCount
    })
  }
  for (let start = 0; start < docs.length; start += chunkSize) {
    const chunk = docs.slice(start, start + chunkSize)
    const body = chunk.map(doc => JSON.stringify(docForTypesense(doc))).join('\n')
    const result = await request(config, 'POST', `/collections/${encodeURIComponent(config.collection)}/documents/import?action=upsert`, {
      contentType: 'text/plain',
      body
    })
    const rows = importRows(result)
    const failed = rows
      .map((row, index) => ({ row, index, doc: chunk[index] }))
      .filter(item => item.row && item.row.success === false)
    if (failed.length) {
      const first = failed[0]
      throw new Error(`Typesense import failed for ${failed.length} docs at offset ${start}: ${preview(JSON.stringify({
        row: first.row,
        doc: first.doc && {
          handle: first.doc.handle,
          kind: first.doc.kind,
          mipLevel: first.doc.mipLevel,
          title: first.doc.title
        }
      }), 1000)}`)
    }
    imported += rows.length || chunk.length
    if (emit) {
      emit({
        phase: 'index:documents:import:chunk',
        sessionId,
        agent: expectedAgent || undefined,
        docCount: docs.length,
        imported,
        chunkIndex: Math.floor(start / chunkSize) + 1,
        chunkCount,
        chunkSize: chunk.length
      })
    }
  }
  if (emit) {
    emit({
      phase: 'index:documents:import:done',
      sessionId,
      agent: expectedAgent || undefined,
      docCount: docs.length,
      imported,
      chunkCount
    })
  }
  return {
    backend: 'typesense',
    collection: config.collection,
    imported
  }
}

const buildFilter = opts => {
  const filters = []
  const filter = opts.filter || {}
  if (opts.sessionId) filters.push(`sessionId:=${filterValue(opts.sessionId)}`)
  if (opts.agent || filter.agent) filters.push(`agent:=${filterValue(opts.agent || filter.agent)}`)
  if (opts.within) filters.push(`parentHandle:=${filterValue(opts.within)}`)
  const messageId = opts.messageId || filter.messageId
  const inReplyToMessageId = opts.inReplyToMessageId || filter.inReplyToMessageId || filter.in_reply_to_message_id
  const toolCallId = opts.toolCallId || filter.toolCallId || filter.tool_call_id
  const role = opts.role || filter.role
  const mip = opts.mip !== undefined ? opts.mip : filter.mip
  const mipLevel = opts.mipLevel || filter.mipLevel || filter.mip_level
  if (messageId) filters.push(`messageId:=${filterValue(messageId)}`)
  if (inReplyToMessageId) filters.push(`inReplyToMessageId:=${filterValue(inReplyToMessageId)}`)
  if (toolCallId) filters.push(`toolCallId:=${filterValue(toolCallId)}`)
  if (role) filters.push(`role:=${filterValue(role)}`)
  if (mip !== undefined && Number(mip) === 0) filters.push('isVerbatim:=true')
  else if (mip !== undefined) filters.push(`depth:=${Number(mip)}`)
  if (mipLevel) filters.push(`mipLevel:=${filterValue(mipLevel)}`)
  return filters.join(' && ')
}

const mapHit = hit => {
  const doc = hit.document || {}
  return searchRef(docRef({ doc, score: hit.text_match || 1 }))
}

const docRef = ({ doc, score } = {}) => {
  doc = doc || {}
  const navigation = parseJsonField(doc.navigationJson, {}, 'navigationJson', doc.id)
  const hasNavigation = navigation.siblingIndex || navigation.siblingCount || navigation.mip || navigation.mips || navigation.parentHandle
  const timeRange = doc.timeRangeStart || doc.timeRangeEnd
    ? { start: doc.timeRangeStart || doc.timeRangeEnd, end: doc.timeRangeEnd || doc.timeRangeStart }
    : undefined
  const topics = parseJsonField(doc.topicsJson, [], 'topicsJson', doc.id)
  const resourceLinks = parseJsonField(doc.resourceLinksJson, [], 'resourceLinksJson', doc.id)
  const usage = parseJsonField(doc.usageJson, {}, 'usageJson', doc.id)
  const metrics = parseJsonField(doc.metricsJson, {}, 'metricsJson', doc.id)
  const summaryMeta = compactSummaryMeta(parseJsonField(doc.summaryMetaJson, {}, 'summaryMetaJson', doc.id))
  return {
    ...(score === undefined ? {} : { score }),
    handle: doc.handle,
    agent: doc.agent,
    sourceKind: doc.sourceKind,
    link: doc.link || (doc.sessionId && doc.handle ? sessionLink({ sessionId: doc.sessionId, handle: doc.handle }) : undefined),
    parentHandle: doc.parentHandle,
    at: doc.at,
    timeRange,
    role: doc.role,
    messageId: doc.messageId,
    inReplyToMessageId: doc.inReplyToMessageId,
    inReplyTo: doc.inReplyToMessageId ? { messageId: doc.inReplyToMessageId } : undefined,
    toolCallId: doc.toolCallId,
    index: doc.nodeIndex,
    zoom: doc.zoom,
    navigation: hasNavigation ? navigation : undefined,
    kind: doc.kind,
    mipLevel: doc.mipLevel,
    isVerbatim: doc.isVerbatim,
    title: doc.title,
    breadcrumb: doc.breadcrumb || '',
    summary: doc.summary,
    head: doc.summary,
    topics,
    summaryModel: doc.summaryModel,
    summaryMeta,
    excerpt: doc.excerpt,
    fullTokenCount: metrics.fullTokenCount,
    renderedTokenCount: metrics.renderedTokenCount,
    nextLevelTokenCount: metrics.nextLevelTokenCount,
    usage,
    childCount: metrics.childCount,
    resourceLinks
  }
}

const includeFields = fields => fields.join(',')

const commonFields = [
  'id',
  'sessionId',
  'agent',
  'sourceKind',
  'handle',
  'parentHandle',
  'link',
  'at',
  'timeRangeStart',
  'timeRangeEnd',
  'role',
  'messageId',
  'inReplyToMessageId',
  'toolCallId',
  'nodeIndex',
  'zoom',
  'siblingIndex',
  'navigationJson',
  'kind',
  'mipLevel',
  'isVerbatim',
  'title',
  'breadcrumb',
  'summary',
  'summaryMetaJson',
  'topicsJson',
  'summaryModel',
  'excerpt',
  'usageJson',
  'metricsJson'
]

const readFields = includeFields([
  ...commonFields,
  'content',
  'resourceLinksJson'
])

const searchFields = includeFields(commonFields)

const pageWindow = ({ startAt = 0, limit = 20 }) => {
  const requestedLimit = Math.max(1, Number(limit || 20))
  const start = Math.max(0, Number(startAt || 0))
  const offsetSeed = requestedLimit > 0 ? start % requestedLimit : 0
  const perPage = Math.min(250, Math.max(1, requestedLimit + offsetSeed))
  const page = Math.floor(start / perPage) + 1
  const offset = start - ((page - 1) * perPage)
  return { start, requestedLimit, perPage, page, offset }
}

const exactDocument = async ({ sessionId, agent, handle, ...opts }) => {
  const config = typesenseConfig(opts)
  await ensureManagedTypesense(config, opts)
  const filters = [
    sessionId ? `sessionId:=${filterValue(sessionId)}` : '',
    agent ? `agent:=${filterValue(agent)}` : '',
    `handle:=${filterValue(handle)}`
  ].filter(Boolean).join(' && ')
  const params = new URLSearchParams()
  params.set('q', '*')
  params.set('query_by', 'handle')
  params.set('filter_by', filters)
  params.set('include_fields', readFields)
  params.set('per_page', '1')
  const result = await request(config, 'GET', `/collections/${encodeURIComponent(config.collection)}/documents/search?${params.toString()}`)
  return result.hits && result.hits[0] && result.hits[0].document || null
}

const childDocuments = async ({ sessionId, agent, parentHandle, startAt = 0, limit = 20, topic, ...opts }) => {
  const config = typesenseConfig(opts)
  await ensureManagedTypesense(config, opts)
  const window = pageWindow({ startAt, limit })
  const filters = [`parentHandle:=${filterValue(parentHandle)}`]
  if (sessionId) filters.push(`sessionId:=${filterValue(sessionId)}`)
  if (agent) filters.push(`agent:=${filterValue(agent)}`)
  const query = topic ? compactText(topic) : '*'
  const params = new URLSearchParams()
  params.set('q', query || '*')
  params.set('query_by', topic ? 'topicsText,summary,title' : 'handle')
  params.set('filter_by', filters.join(' && '))
  params.set('include_fields', readFields)
  params.set('per_page', String(window.perPage))
  params.set('page', String(window.page))
  params.set('sort_by', topic ? '_text_match:desc,siblingIndex:asc' : 'siblingIndex:asc')
  const result = await request(config, 'GET', `/collections/${encodeURIComponent(config.collection)}/documents/search?${params.toString()}`)
  const hits = result.hits || []
  return {
    found: Number(result.found || 0),
    docs: hits.slice(window.offset, window.offset + window.requestedLimit).map(hit => hit.document)
  }
}

const renderTypesenseNode = async ({ doc, sourceLink, budgetTokens = 1200, ...opts }) => {
  const ref = docRef({ doc })
  const budget = Math.max(1, Number(budgetTokens || 1200))
  const metrics = parseJsonField(doc.metricsJson, {}, 'metricsJson', doc.id)
  const content = doc.content || ''
  const contentTokens = estimateTokens(content)
  if (doc.isVerbatim && content && budget >= Number(metrics.fullTokenCount || contentTokens)) {
    return {
      sourceLink,
      ...ref,
      mipLevel: 'raw',
      content,
      isVerbatim: true,
      renderedTokenCount: contentTokens,
      omittedTokenCount: 0
    }
  }
  if (doc.isVerbatim || !Number(metrics.childCount || 0)) {
    const maxChars = Math.max(160, budget * 4)
    const excerpt = content ? content.slice(0, maxChars) : doc.excerpt || ''
    return {
      sourceLink,
      ...ref,
      mipLevel: content && excerpt === content ? 'raw' : 'leaf_excerpt',
      content: excerpt,
      isVerbatim: Boolean(content && excerpt === content),
      renderedTokenCount: estimateTokens(excerpt),
      omittedTokenCount: Math.max(0, Number(metrics.fullTokenCount || contentTokens) - estimateTokens(excerpt))
    }
  }

  const lines = [
    doc.summary || doc.title,
    '',
    `Rendered under ${budget} token budget. Full expansion is ~${Number(metrics.fullTokenCount || 0)} tokens; one level deeper is ~${Number(metrics.nextLevelTokenCount || 0)} tokens.`,
    ref.usage && ref.usage.total ? `Provider usage under this node: ${stableStringify(ref.usage)}.` : '',
    'Open child links for detail.',
    ''
  ].filter(line => line !== '')
  const children = []
  let spent = estimateTokens(lines.join('\n'))
  const childLimit = Math.min(100, Math.max(20, Math.ceil(budget / 20)), Math.max(1, Number(metrics.childCount || 0)))
  const childResult = await childDocuments({
    sessionId: doc.sessionId,
    agent: doc.agent,
    parentHandle: doc.handle,
    startAt: 0,
    limit: childLimit,
    ...opts
  })
  for (const child of childResult.docs) {
    const childMetrics = parseJsonField(child.metricsJson, {}, 'metricsJson', child.id)
    const label = child.breadcrumb || child.title
    const line = `- ${label}: ${child.summary || child.title} (${Number(childMetrics.fullTokenCount || 0)} full tokens) [${child.handle}]`
    const cost = estimateTokens(line)
    if (spent + cost > budget && children.length) break
    lines.push(line)
    children.push(docRef({ doc: child }))
    spent += cost
  }
  const visibleChildCount = Number(metrics.childCount || childResult.found || children.length)
  if (children.length < visibleChildCount) lines.push(`... ${visibleChildCount - children.length} more children omitted.`)
  const rendered = lines.join('\n')
  return {
    sourceLink,
    ...ref,
    mipLevel: 'heads',
    content: rendered,
    isVerbatim: false,
    renderedTokenCount: estimateTokens(rendered),
    omittedTokenCount: Number(metrics.fullTokenCount || 0),
    children
  }
}

const openLinkTypesense = async ({ link, budgetTokens, sessionId, agent, ...opts }) => {
  const parsed = parseSessionLink(link)
  if (!parsed || !parsed.handle) throw new Error(`Unsupported conversation_history link: ${link}`)
  if (parsed.sessionId && sessionId && parsed.sessionId !== sessionId) {
    throw new Error(`link targets session ${parsed.sessionId}, loaded session is ${sessionId}`)
  }
  const doc = await exactDocument({
    sessionId: sessionId || parsed.sessionId,
    agent,
    handle: parsed.handle,
    ...opts
  })
  if (!doc) throw new Error(`Unknown session handle: ${parsed.handle}`)
  if (doc.kind === 'reasoning' || /\/reasoning(?:\/|$)/.test(String(doc.handle || ''))) {
    throw new Error(`Reasoning records are not available through conversation_history: ${doc.handle}`)
  }
  return renderTypesenseNode({
    doc,
    sourceLink: link,
    budgetTokens,
    ...opts
  })
}

const optionalString = value => {
  const text = String(value || '')
  return text ? text : undefined
}

const browseTopics = refs => {
  const out = []
  const seen = new Set()
  for (const ref of refs || []) {
    const topics = normalizeTopics(ref.topics || [], { max: 0 })
    const fallback = ref.summary || ref.head || ref.title || ref.breadcrumb || ''
    const values = topics.length ? topics : fallback ? [fallback] : []
    for (let index = 0; index < values.length; index += 1) {
      const description = values[index]
      const topicId = topicIdForHandle({ handle: ref.handle, topicIndex: topics.length ? index : -1 })
      if (!topicId || seen.has(topicId)) continue
      seen.add(topicId)
      out.push({
        topic_id: topicId,
        label: optionalString(ref.breadcrumb) || optionalString(ref.title) || `topic ${out.length + 1}`,
        description,
        index: optionalString(ref.index)
      })
    }
  }
  return out
}

const browseRef = ref => {
  const topics = browseTopics([ref])
  return {
    topic_id: topicIdForHandle({ handle: ref.handle }),
    agent: ref.agent,
    sourceKind: ref.sourceKind,
    link: ref.link,
    index: optionalString(ref.index),
    kind: ref.kind,
    title: ref.title,
    breadcrumb: optionalString(ref.breadcrumb),
    summary: ref.summary || ref.head || undefined,
    topics: topics.length ? topics : undefined,
    isVerbatim: ref.isVerbatim,
    child_count: Number(ref.childCount || 0),
    full_token_count: Number(ref.fullTokenCount || 0) || undefined
  }
}

const searchRef = ref => {
  const topics = Array.isArray(ref.topics) && ref.topics.length ? ref.topics : undefined
  return {
    score: ref.score,
    handle: ref.handle,
    agent: ref.agent,
    sourceKind: ref.sourceKind,
    link: ref.link,
    index: optionalString(ref.index),
    kind: ref.kind,
    title: ref.title,
    summary: ref.summary || ref.head || ref.excerpt || undefined,
    topics,
    isVerbatim: ref.isVerbatim,
    childCount: Number(ref.childCount || 0),
    fullTokenCount: Number(ref.fullTokenCount || 0) || undefined
  }
}

const normalizeBrowseZoom = ({ zoom, topicId }) => {
  const value = String(zoom || '').trim().toLowerCase()
  if (!value) return topicId ? 'in' : 'children'
  if (['children', 'in', 'out', 'siblings'].includes(value)) return value
  throw new Error('--zoom must be children, in, out, or siblings')
}

const normalizeBrowseTopicId = topicId => {
  const text = String(topicId || '').trim()
  return text.toLowerCase() === 'root' ? '' : text
}

const browseDocForTopicId = async ({ topicId, sessionId, agent, ...opts }) => {
  const parsed = parseTopicId(topicId)
  if (!parsed) throw new Error(`Invalid browse topic_id: ${topicId}`)
  const doc = await exactDocument({
    sessionId,
    agent,
    handle: parsed.handle,
    ...opts
  })
  if (!doc) throw new Error(`Unknown browse topic_id: ${topicId}`)
  return { doc, parsed }
}

const parentDocument = async ({ doc, sessionId, agent, ...opts }) => {
  if (!doc || !doc.parentHandle) return null
  return exactDocument({
    sessionId: sessionId || doc.sessionId,
    agent: agent || doc.agent,
    handle: doc.parentHandle,
    ...opts
  })
}

const browseTypesense = async ({ sessionId, agent, handle, topicId, zoom, start, startAt = 0, limit = 20, topic, ...opts }) => {
  topicId = normalizeBrowseTopicId(topicId)
  const resolvedStart = start !== undefined ? start : startAt
  const resolvedZoom = normalizeBrowseZoom({ zoom, topicId })
  let targetHandle = handle || `session/${sessionId}`
  let selectedTopicId = topicId || undefined
  let doc

  if (topicId) {
    const selected = await browseDocForTopicId({
      topicId,
      sessionId,
      agent,
      ...opts
    })
    doc = selected.doc
    targetHandle = doc.handle
  } else {
    doc = await exactDocument({
      sessionId,
      agent,
      handle: targetHandle,
      ...opts
    })
  }

  if (!doc) throw new Error(`Unknown session browse target`)
  if (resolvedZoom === 'out' || resolvedZoom === 'siblings') {
    const parent = await parentDocument({
      doc,
      sessionId,
      agent,
      ...opts
    })
    if (parent) {
      doc = parent
      targetHandle = parent.handle
    }
  }

  if (doc.kind === 'reasoning' || /\/reasoning(?:\/|$)/.test(String(doc.handle || ''))) {
    throw new Error(`Reasoning records are not available through conversation_history: ${doc.handle}`)
  }

  const ref = docRef({ doc })
  const childResult = await childDocuments({
    sessionId,
    agent: agent || doc.agent,
    parentHandle: targetHandle,
    startAt: resolvedStart,
    limit,
    topic,
    ...opts
  })
  const children = childResult.docs.map(child => browseRef(docRef({ doc: child })))
  const childRefs = childResult.docs.map(child => docRef({ doc: child }))
  const startNumber = Math.max(0, Number(resolvedStart || 0))
  const limitNumber = Math.max(1, Number(limit || 20))
  const nextStart = startNumber + childResult.docs.length
  return {
    topic_id: topicIdForHandle({ handle: ref.handle }),
    selected_topic_id: selectedTopicId,
    zoom: resolvedZoom,
    ...browseRef(ref),
    topics: browseTopics(childRefs),
    page: {
      start: startNumber,
      limit: limitNumber,
      returned: childResult.docs.length,
      total: childResult.found,
      next_start: nextStart < childResult.found ? nextStart : undefined
    },
    topic_filter: topic || undefined,
    children
  }
}

const searchTypesense = async (opts = {}) => {
  const config = typesenseConfig(opts)
  await ensureManagedTypesense(config, opts)
  const query = compactText([
    opts.query,
    opts.topic
  ].filter(Boolean).join(' '))
  const filter = buildFilter(opts)
  if (!query && !opts.topic && !filter) return []
  const startAt = Math.max(0, Number(opts.startAt || opts.start_at || 0) || 0)
  const window = pageWindow({ startAt, limit: opts.limit || 10 })
  const params = new URLSearchParams()
  params.set('q', query || '*')
  params.set('query_by', 'title,summary,topicsText,searchText,excerpt,handle')
  params.set('include_fields', searchFields)
  params.set('per_page', String(window.perPage))
  params.set('page', String(window.page))
  params.set('sort_by', '_text_match:desc,ts:asc')
  if (filter) params.set('filter_by', filter)
  const result = await request(config, 'GET', `/collections/${encodeURIComponent(config.collection)}/documents/search?${params.toString()}`)
  if (Number(result.found || 0) > 0 && startAt < Number(result.found || 0) && !(result.hits || []).length) {
    const logs = config.managed && config.managed.logs
      ? ` stdout=${config.managed.logs.stdout}; stderr=${config.managed.logs.stderr};`
      : ''
    throw new Error(`Typesense returned found=${result.found} with no hits for query ${JSON.stringify(query || '*')};${logs} raw=${preview(JSON.stringify(result), 1000)}`)
  }
  return (result.hits || []).slice(window.offset, window.offset + window.requestedLimit).map(mapHit)
}

const health = async opts => {
  const config = await resolveTypesenseConfig(opts)
  return request(config, 'GET', '/health')
}

module.exports = {
  DEFAULT_TYPESENSE_API_KEY,
  DEFAULT_TYPESENSE_COLLECTION,
  browseTypesense,
  collectionSchema,
  docForTypesense,
  deleteSessionDocuments,
  ensureCollection,
  exactDocument,
  health,
  importDocuments,
  isCollectionNotFoundError,
  openLinkTypesense,
  resolveTypesenseConfig,
  searchTypesense,
  typesenseConfig,
  ensureManagedTypesense
}
