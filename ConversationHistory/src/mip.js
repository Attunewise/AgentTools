const {
  compactText,
  estimateTokens,
  hashString,
  preview,
  safeId,
  stableStringify
} = require('./util.js')
const { addUsage, blockText, eventText, normalizeUsage } = require('./ir.js')
const { normalizeTopics, parseTopicId, topicIdForHandle, topicText } = require('./topics.js')

const RAW_CHUNK_CHARS = 6000
const MAX_SEARCH_MESSAGE_CHARS = 4000
const MAX_TOPICS = 8
const DEFAULT_SUMMARY_MODEL = 'summary-not-generated'

const unique = values => [...new Set((values || []).filter(value => typeof value === 'string' && value.length))]

const hasUsage = usage => Object.values(normalizeUsage(usage)).some(Boolean)

const makeHandle = parts => parts.map(part => encodeURIComponent(String(part))).join('/')

const indexEventMaterial = event => {
  if (!event || typeof event !== 'object') return event
  const { source: _source, ...rest } = event
  return rest
}

const indexIdForIR = ir => {
  const explicit = ir && (ir.indexId || ir.index_id || ir.session && (ir.session.indexId || ir.session.index_id))
  if (explicit) return String(explicit)
  return `idx-${hashString(stableStringify({
    schema: 'conversation-history.index.v1',
    sourceKind: ir && ir.source && ir.source.kind || '',
    agent: ir && ir.session && ir.session.agent || '',
    events: (ir && ir.events || []).map(indexEventMaterial)
  })).slice(0, 32)}`
}

const sessionLink = ({ indexId, sessionId, handle }) => {
  const params = new URLSearchParams()
  if (indexId) params.set('indexId', indexId)
  else if (sessionId) params.set('sessionId', sessionId)
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
    indexId: params.get('indexId') || params.get('index_id') || undefined,
    sessionId: params.get('sessionId') || undefined,
    handle: params.get('handle') || undefined
  }
}

const mergeTopic = (map, topic, weight = 1) => {
  const text = topicText(topic)
  if (!text) return
  const key = text.toLowerCase()
  const existing = map.get(key)
  if (!existing) {
    map.set(key, {
      topic: text,
      weight
    })
    return
  }
  existing.weight += weight
}

const aggregateChildTopics = node => {
  const map = new Map()
  for (const child of modelVisibleChildren(node.children)) {
    for (const topic of child.topics || []) {
      mergeTopic(map, topic, Math.max(1, Math.ceil(child.fullTokenCount / 1000)))
    }
  }
  return [...map.values()]
    .sort((a, b) => b.weight - a.weight || a.topic.localeCompare(b.topic))
    .slice(0, MAX_TOPICS)
    .map(item => item.topic)
}

const topicMatches = (topics = [], topicFilter = '') => {
  const needle = compactText(topicFilter).toLowerCase()
  if (!needle) return true
  return normalizeTopics(topics, { max: 0 }).some(topic => topic.toLowerCase().includes(needle))
}

const searchableReasoning = event => (event.reasoning || [])
  .map(item => [
    item.modelFamily,
    item.summary,
    item.signature ? 'has signature' : '',
    item.encrypted ? 'has encrypted reasoning' : ''
  ].filter(Boolean).join(' '))
  .join('\n')

const eventTitle = event => {
  if (event.title) return event.title
  if (event.type === 'tool_call') return `tool call ${event.call && event.call.name || 'unknown'}`
  if (event.type === 'tool_result') return `tool result ${event.toolName || event.callId || 'unknown'}`
  if (event.type === 'message') return `${event.role || 'message'} message`
  if (event.type === 'usage') return 'token usage'
  return event.type
}

const eventHead = event => {
  if (event.type === 'tool_call') {
    const call = event.call || {}
    const args = typeof call.arguments === 'string' ? call.arguments : stableStringify(call.arguments)
    return `tool call ${call.name || 'unknown'} ${preview(args, 180)}`
  }
  if (event.type === 'tool_result') {
    return `tool result ${event.toolName || event.callId || 'unknown'} ${preview(event.output, 180)}`
  }
  if (event.type === 'reasoning') {
    return `reasoning ${preview(searchableReasoning(event), 180)}`
  }
  if (event.type === 'usage') {
    return `token usage ${stableStringify(normalizeUsage(event.usage))}`
  }
  const text = eventText(event)
  return `${event.role || event.type}: ${preview(text, 180)}`
}

class MipNode {
  constructor (fields) {
    Object.assign(this, fields)
    this.children = this.children || []
    this.raw = this.raw || ''
    this.meta = this.meta || {}
    this.topics = this.topics || []
    this.summaryModel = this.summaryModel || DEFAULT_SUMMARY_MODEL
    this.summaryMeta = this.summaryMeta || {
      strategy: DEFAULT_SUMMARY_MODEL
    }
    this.ownUsage = normalizeUsage(
      this.ownUsage ||
      this.directUsage ||
      (this.meta.type === 'usage' ? this.usage : undefined)
    )
    this.usage = normalizeUsage(this.usage)
    this.resourceLinks = unique(this.resourceLinks || [])
    this.renderedTokenCount = estimateTokens(this.head || this.raw || this.title || '')
    this.fullTokenCount = 0
    this.nextLevelTokenCount = 0
  }
}

const rawLeaf = fields => new MipNode({
  ...fields,
  kind: fields.kind || 'leaf',
  head: fields.head || preview(fields.raw),
  raw: stableStringify(fields.raw)
})

const section = fields => new MipNode({
  ...fields,
  kind: fields.kind || 'section'
})

const splitRaw = ({ baseHandle, kind, title, head, raw, meta, resourceLinks }) => {
  const text = stableStringify(raw)
  if (text.length <= RAW_CHUNK_CHARS) {
    return rawLeaf({ handle: baseHandle, kind, title, head, raw: text, meta, resourceLinks })
  }
  const children = []
  for (let start = 0, index = 0; start < text.length; start += RAW_CHUNK_CHARS, index++) {
    const chunk = text.slice(start, start + RAW_CHUNK_CHARS)
    children.push(rawLeaf({
      handle: `${baseHandle}/chunk/${index}`,
      kind: `${kind}_chunk`,
      title: `${title} chunk ${index + 1}`,
      head: `${title} characters ${start}-${start + chunk.length}`,
      raw: chunk,
      meta: { ...(meta || {}), charStart: start, charEnd: start + chunk.length },
      resourceLinks
    }))
  }
  return section({
    handle: baseHandle,
    kind,
    title,
    head: `${head || title} (${children.length} chunks)`,
    children,
    meta,
    resourceLinks
  })
}

const finalize = node => {
  const isSessionRoot = node.kind === 'session' && node.meta && node.meta.sessionId
  if (!node.children.length) {
    node.ownUsage = normalizeUsage(node.ownUsage)
    node.usage = addUsage(node.ownUsage)
    node.fullTokenCount = estimateTokens(node.raw)
    node.nextLevelTokenCount = node.fullTokenCount
    node.renderedTokenCount = estimateTokens(node.head || node.raw)
    node.topics = normalizeTopics(node.topics || [], { max: MAX_TOPICS })
    return node
  }
  node.children.forEach(finalize)
  const nodeChildren = modelVisibleChildren(node.children)
  const rootSummaryAlias = !modelTextForNode(node) &&
    node.kind === 'session' &&
    nodeChildren.length === 1 &&
    nodeChildren[0].kind === 'summary_span'
  const surfaceNode = rootSummaryAlias ? nodeChildren[0] : node
  const visibleChildren = modelVisibleChildren(surfaceNode.children)
  node.ownUsage = normalizeUsage(node.ownUsage)
  node.usage = isSessionRoot && hasUsage(node.ownUsage)
    ? node.ownUsage
    : addUsage(node.ownUsage, ...visibleChildren.map(child => child.usage))
  node.fullTokenCount = visibleChildren.reduce((sum, child) => sum + child.fullTokenCount, 0)
  node.nextLevelTokenCount = visibleChildren.reduce((sum, child) => sum + child.renderedTokenCount, 0)
  node.renderedTokenCount = estimateTokens(node.head || node.title)
  const startAt = visibleChildren.map(nodeStartAt).find(Boolean)
  const endAt = [...visibleChildren].reverse().map(nodeEndAt).find(Boolean)
  if (startAt && !node.meta.at) node.meta.startAt = startAt
  if (endAt && !node.meta.at) node.meta.endAt = endAt
  node.topics = node.topics.length ? normalizeTopics(node.topics, { max: MAX_TOPICS }) : aggregateChildTopics(node)
  node.resourceLinks = unique([
    ...node.resourceLinks,
    ...visibleChildren.flatMap(child => child.resourceLinks || [])
  ])
  return node
}

const collectTreeIndex = (node, state = {}, parent = null, depth = 0) => {
  const out = state
  out.byHandle = out.byHandle || new Map()
  out.parentByHandle = out.parentByHandle || new Map()
  out.depthByHandle = out.depthByHandle || new Map()
  out.maxDepth = Math.max(out.maxDepth || 0, depth)
  out.byHandle.set(node.handle, node)
  out.parentByHandle.set(node.handle, parent && parent.handle || '')
  out.depthByHandle.set(node.handle, depth)
  for (const child of node.children) collectTreeIndex(child, out, node, depth + 1)
  return out
}

const rebuildTreeIndex = tree => {
  finalize(tree.root)
  const index = collectTreeIndex(tree.root)
  tree.byHandle = index.byHandle
  tree.parentByHandle = index.parentByHandle
  tree.depthByHandle = index.depthByHandle
  tree.maxDepth = index.maxDepth
  return tree
}

const hydrateMipTree = ({ ir, root }) => rebuildTreeIndex({
  ir,
  root,
  byHandle: new Map()
})

const collectDescendants = (node, out = []) => {
  out.push(node)
  for (const child of node.children) collectDescendants(child, out)
  return out
}

const collectLeaves = (node, out = []) => {
  if (isModelHiddenNode(node)) return out
  if (!node.children.length) out.push(node)
  else node.children.forEach(child => collectLeaves(child, out))
  return out
}

const eventResourceLinks = ({ indexId, sessionId, event, eventHandle, pairedHandle }) => unique([
  sessionLink({ indexId, sessionId, handle: eventHandle }),
  pairedHandle ? sessionLink({ indexId, sessionId, handle: pairedHandle }) : undefined
])

const eventNode = ({ ir, event, index, pairLookup }) => {
  const eventId = event.id || `event-${index}`
  const base = makeHandle(['session', ir.session.id, 'event', `${String(index).padStart(6, '0')}-${safeId(event.type)}-${safeId(eventId).slice(0, 18)}`])
  const pairedHandle = pairLookup && pairLookup(event)
  const meta = {
    eventId,
    ordinal: event.ordinal ?? index,
    type: event.type,
    role: event.role,
    at: event.at,
    source: event.source,
    callId: event.callId || event.call && event.call.id,
    toolCallId: event.toolCallId || event.callId || event.call && event.call.id,
    messageId: event.messageId,
    inReplyToMessageId: event.inReplyToMessageId,
    toolName: event.toolName || event.call && event.call.name,
    model: event.model,
    modelFamily: event.modelFamily
  }
  const children = []
  if (event.content && event.content.length) {
    children.push(splitRaw({
      baseHandle: `${base}/content`,
      kind: 'event_content',
      title: `${eventTitle(event)} content`,
      head: eventHead(event),
      raw: event.content.map(blockText).join('\n'),
      meta,
      resourceLinks: eventResourceLinks({ indexId: ir.indexId, sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
    }))
  }
  if (event.reasoning && event.reasoning.length) {
    children.push(splitRaw({
      baseHandle: `${base}/reasoning`,
      kind: 'reasoning',
      title: `${eventTitle(event)} reasoning`,
      head: eventHead(event),
      raw: event.reasoning,
      meta,
      resourceLinks: eventResourceLinks({ indexId: ir.indexId, sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
    }))
  }
  if (event.call) {
    children.push(splitRaw({
      baseHandle: `${base}/call`,
      kind: 'tool_call',
      title: `${event.call.name || 'tool'} call`,
      head: eventHead(event),
      raw: event.call,
      meta,
      resourceLinks: eventResourceLinks({ indexId: ir.indexId, sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
    }))
  }
  if (event.output !== undefined) {
    children.push(splitRaw({
      baseHandle: `${base}/result`,
      kind: 'tool_result',
      title: `${event.toolName || 'tool'} result`,
      head: eventHead(event),
      raw: event.output,
      meta,
      resourceLinks: eventResourceLinks({ indexId: ir.indexId, sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
    }))
  }
  if (!children.length) {
    children.push(splitRaw({
      baseHandle: `${base}/raw`,
      kind: 'event_raw',
      title: eventTitle(event),
      head: eventHead(event),
      raw: event,
      meta,
      resourceLinks: eventResourceLinks({ indexId: ir.indexId, sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
    }))
  }
  return section({
    handle: base,
    kind: event.type,
    title: eventTitle(event),
    head: eventHead(event),
    children,
    ownUsage: event.usage,
    usage: event.usage,
    meta,
    resourceLinks: eventResourceLinks({ indexId: ir.indexId, sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
  })
}

const makePairLookup = ir => {
  const callHandleById = new Map()
  const resultHandleById = new Map()
  const provisionalHandle = (event, index) => makeHandle(['session', ir.session.id, 'event', `${String(index).padStart(6, '0')}-${safeId(event.type)}-${safeId(event.id).slice(0, 18)}`])
  ir.events.forEach((event, index) => {
    if (event.type === 'tool_call' && event.call && event.call.id) callHandleById.set(event.call.id, provisionalHandle(event, index))
    if (event.type === 'tool_result' && event.callId) resultHandleById.set(event.callId, provisionalHandle(event, index))
  })
  return event => {
    if (event.type === 'tool_call' && event.call && event.call.id) return resultHandleById.get(event.call.id)
    if (event.type === 'tool_result' && event.callId) return callHandleById.get(event.callId)
    return undefined
  }
}

const buildMipTree = ir => {
  ir.indexId = indexIdForIR(ir)
  const pairLookup = makePairLookup(ir)
  const children = ir.events.map((event, index) => eventNode({ ir, event, index, pairLookup }))
  const root = section({
    handle: makeHandle(['session', ir.session.id]),
    kind: 'session',
    title: ir.session.title || `Session ${ir.session.id}`,
    head: `${ir.session.agent || 'coding'} session with ${children.length} indexed events`,
    children,
    meta: {
      sessionId: ir.session.id,
      source: ir.source,
      session: ir.session
    }
  })
  finalize(root)
  return rebuildTreeIndex({
    ir,
    root,
    byHandle: new Map()
  })
}

const isCompactionNode = node => node && (node.kind === 'compaction' || node.meta && node.meta.type === 'compaction')

const lastCompactionChildIndex = tree => {
  const children = tree.root.children || []
  for (let index = children.length - 1; index >= 0; index--) {
    if (isCompactionNode(children[index])) return index
  }
  return -1
}

const compactedPrefixChildren = tree => {
  const children = tree.root.children || []
  const boundary = lastCompactionChildIndex(tree)
  if (boundary < 0) return []
  return children.slice(0, boundary).filter(child => !isCompactionNode(child) && isModelVisibleNode(child))
}

const compactedEventSpans = tree => {
  const spans = []
  let current = []
  let startIndex = 0
  let endIndex = -1
  for (const [index, child] of (tree.root.children || []).entries()) {
    if (!isCompactionNode(child)) {
      if (isModelHiddenNode(child)) continue
      if (!current.length) startIndex = index
      current.push(child)
      endIndex = index
      continue
    }
    if (current.length) {
      spans.push({
        index: spans.length,
        startIndex,
        endIndex,
        boundaryIndex: index,
        boundaryHandle: child.handle,
        children: current
      })
    }
    current = []
    endIndex = -1
  }
  return spans
}

const addVisibleHandles = (handles, node) => {
  if (!node || isModelHiddenNode(node)) return
  handles.add(node.handle)
  for (const child of modelVisibleChildren(node.children)) addVisibleHandles(handles, child)
}

const compactedRetrievalHandles = tree => {
  const handles = new Set()
  if (tree && tree.root) handles.add(tree.root.handle)
  for (const span of compactedEventSpans(tree)) {
    for (const child of modelVisibleChildren(span.children)) addVisibleHandles(handles, child)
  }
  return handles
}

const replaceRootChildren = (tree, children, head, opts = {}) => {
  tree.root.children = children || []
  if (head) tree.root.head = head
  if (opts.ownUsage) tree.root.ownUsage = normalizeUsage(opts.ownUsage)
  return rebuildTreeIndex(tree)
}

const applyCompactionSearchScope = tree => {
  const children = compactedEventSpans(tree).flatMap(span => span.children)
  const rootUsage = normalizeUsage(tree.root.usage)
  return replaceRootChildren(
    tree,
    children,
    children.length
      ? `${tree.root.title} compacted prefix with ${children.length} indexed events`
      : `${tree.root.title} has no compacted transcript span yet`,
    { ownUsage: rootUsage }
  )
}

const createSummaryNode = ({ tree, level = 1, index = 0, children, breadcrumb, head, topics, meta }) => {
  const padded = String(index).padStart(4, '0')
  return section({
    // A summary span is a logical slot in the MIP tree. Its source revision is
    // tracked by sourceGroupHash/targetId; putting a child hash in the handle
    // would replace the node every time the open right edge grows and makes it
    // impossible to maintain that spine in place.
    handle: `${tree.root.handle}/summary/level-${level}/span-${padded}`,
    kind: 'summary_span',
    title: `summary level ${level} span ${index + 1}`,
    breadcrumb: breadcrumb || `span-${index + 1}`,
    head: head || `Pending summary for ${children.length} compacted transcript events`,
    children,
    topics: topics || [],
    meta: {
      type: 'summary_span',
      summaryLevel: level,
      spanIndex: index,
      childCount: children.length,
      childStartHandle: children[0] && children[0].handle,
      childEndHandle: children[children.length - 1] && children[children.length - 1].handle,
      ...(meta || {})
    }
  })
}

const concatRaw = node => collectLeaves(node).map(leaf => leaf.raw).join('\n')

const nodeNavigation = (tree, node, parent, depth) => {
  const parentHandle = parent
    ? parent.handle
    : tree.parentByHandle && tree.parentByHandle.get(node.handle) || ''
  const actualParent = parent || parentHandle && tree.byHandle && tree.byHandle.get(parentHandle)
  const siblings = actualParent ? modelVisibleChildren(actualParent.children) : [tree.root]
  const zeroBasedIndex = Math.max(0, siblings.findIndex(child => child.handle === node.handle))
  const siblingIndex = zeroBasedIndex + 1
  const siblingCount = Math.max(1, siblings.length)
  const rawDepth = Number.isInteger(depth)
    ? depth
    : tree.depthByHandle && tree.depthByHandle.get(node.handle)
  const mip = Math.max(1, Number.isInteger(rawDepth) ? rawDepth + 1 : 1)
  const mips = Math.max(mip, Number(tree.maxDepth || 0) + 1)
  return {
    index: `${siblingIndex}/${siblingCount}`,
    zoom: `${mip}/${mips}`,
    navigation: {
      siblingIndex,
      siblingCount,
      mip,
      mips,
      parentHandle: parentHandle || undefined
    }
  }
}

const compactSummaryMeta = meta => {
  if (!meta) return undefined
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

const compactResourceLinks = (links, limit = 5) => unique(links || []).slice(0, limit)

const isModelHiddenNode = node => Boolean(node && (
  node.kind === 'reasoning' ||
  node.meta && node.meta.type === 'reasoning'
))

const isModelVisibleNode = node => !isModelHiddenNode(node)

const modelVisibleChildren = children => (children || []).filter(isModelVisibleNode)

const nodeStartAt = node => node && node.meta && (node.meta.startAt || node.meta.at) || ''

const nodeEndAt = node => node && node.meta && (node.meta.endAt || node.meta.at) || ''

const nodeTimeFields = node => {
  const meta = node && node.meta || {}
  if (meta.at) return { at: meta.at }
  if (meta.startAt || meta.endAt) {
    return {
      timeRange: {
        start: meta.startAt || meta.endAt,
        end: meta.endAt || meta.startAt
      }
    }
  }
  return {}
}

const nodeConversationFields = node => {
  const meta = node && node.meta || {}
  const out = {}
  if (meta.role) out.role = meta.role
  if (meta.messageId) out.messageId = meta.messageId
  if (meta.inReplyToMessageId) {
    out.inReplyToMessageId = meta.inReplyToMessageId
    out.inReplyTo = { messageId: meta.inReplyToMessageId }
  }
  if (meta.toolCallId || meta.callId) out.toolCallId = meta.toolCallId || meta.callId
  return out
}

const nodeSourceFields = node => {
  const meta = node && node.meta || {}
  const source = meta.source || {}
  const lineNumber = Number(source.lineNumber || 0)
  const out = {}
  if (source.path) out.sourcePath = source.path
  if (Number.isInteger(lineNumber) && lineNumber > 0) {
    out.sourceLineNumber = lineNumber
    out.sourceLineEnd = lineNumber
  }
  if (Number.isInteger(meta.charStart)) out.sourceCharStart = meta.charStart
  if (Number.isInteger(meta.charEnd)) out.sourceCharEnd = meta.charEnd
  return out
}

const nodeRef = (tree, node, opts = {}) => ({
  handle: node.handle,
  index_id: tree.ir.indexId,
  link: sessionLink({ indexId: tree.ir.indexId, handle: node.handle }),
  parentHandle: tree.parentByHandle && tree.parentByHandle.get(node.handle) || undefined,
  ...nodeNavigation(tree, node),
  ...nodeTimeFields(node),
  ...nodeConversationFields(node),
  ...nodeSourceFields(node),
  kind: node.kind,
  title: node.title,
  breadcrumb: node.breadcrumb || '',
  head: node.head,
  childCount: navigationChildren(node).length,
  renderedTokenCount: node.renderedTokenCount,
  nextLevelTokenCount: node.nextLevelTokenCount,
  fullTokenCount: node.fullTokenCount,
  usage: node.usage,
  ...(opts.includeResourceLinks === false ? {} : { resourceLinks: compactResourceLinks(node.resourceLinks) }),
  topics: node.topics || [],
  summaryModel: node.summaryModel || DEFAULT_SUMMARY_MODEL,
  summaryMeta: compactSummaryMeta(node.summaryMeta)
})

const renderNode = (tree, node, budgetTokens = 1200, opts = {}) => {
  if (isModelHiddenNode(node)) throw new Error(`Reasoning records are not available through conversation_history: ${node.handle}`)
  const budget = Math.max(1, Number(budgetTokens || 1200))
  if (sourceMessageContainer(node)) {
    const source = modelTextForNode(node)
    const maxChars = Math.max(160, budget * 4)
    const content = source.slice(0, maxChars)
    return {
      ...nodeRef(tree, node),
      mipLevel: content === source ? 'raw' : 'leaf_excerpt',
      content,
      isVerbatim: content === source,
      renderedTokenCount: estimateTokens(content),
      omittedTokenCount: Math.max(0, estimateTokens(source) - estimateTokens(content))
    }
  }
  if (budget >= node.fullTokenCount && !(opts.summaryOnly && node.children.length)) {
    const content = concatRaw(node)
    return {
      ...nodeRef(tree, node),
      mipLevel: 'raw',
      content,
      isVerbatim: true,
      renderedTokenCount: estimateTokens(content),
      omittedTokenCount: 0
    }
  }
  if (!node.children.length) {
    const maxChars = Math.max(160, budget * 4)
    const content = node.raw.slice(0, maxChars)
    return {
      ...nodeRef(tree, node),
      mipLevel: 'leaf_excerpt',
      content,
      isVerbatim: content === node.raw,
      renderedTokenCount: estimateTokens(content),
      omittedTokenCount: Math.max(0, node.fullTokenCount - estimateTokens(content))
    }
  }
  const lines = [
    node.head || node.title,
    '',
    `Rendered under ${budget} token budget. Full expansion is ~${node.fullTokenCount} tokens; one level deeper is ~${node.nextLevelTokenCount} tokens.`,
    node.usage.total ? `Provider usage under this node: ${stableStringify(node.usage)}.` : '',
    'Open child links for detail.',
    ''
  ].filter(line => line !== '')
  const children = []
  let spent = estimateTokens(lines.join('\n'))
  const visibleChildren = navigationChildren(node)
  for (const child of visibleChildren) {
    const label = child.breadcrumb || child.title
    const line = `- ${label}: ${child.head} (${child.fullTokenCount} full tokens) [${child.handle}]`
    const cost = estimateTokens(line)
    if (spent + cost > budget && children.length) break
    lines.push(line)
    children.push(nodeRef(tree, child))
    spent += cost
  }
  if (children.length < visibleChildren.length) lines.push(`... ${visibleChildren.length - children.length} more children omitted.`)
  const content = lines.join('\n')
  return {
    ...nodeRef(tree, node),
    mipLevel: 'heads',
    content,
    isVerbatim: false,
    renderedTokenCount: estimateTokens(content),
    omittedTokenCount: node.fullTokenCount,
    children
  }
}

const openLink = (tree, link, opts = {}) => {
  const parsed = parseSessionLink(link)
  if (!parsed || !parsed.handle) throw new Error(`Unsupported conversation_history link: ${link}`)
  if (parsed.sessionId && parsed.sessionId !== tree.ir.session.id) {
    throw new Error(`link targets session ${parsed.sessionId}, loaded session is ${tree.ir.session.id}`)
  }
  if (parsed.indexId && parsed.indexId !== tree.ir.indexId) {
    throw new Error(`link targets index ${parsed.indexId}, loaded index is ${tree.ir.indexId}`)
  }
  const node = tree.byHandle.get(parsed.handle)
  if (!node) throw new Error(`Unknown session handle: ${parsed.handle}`)
  if (isModelHiddenNode(node)) throw new Error(`Reasoning records are not available through conversation_history: ${node.handle}`)
  return {
    sourceLink: link,
    ...renderNode(tree, node, opts.budgetTokens || opts.budget_tokens || 1200, opts)
  }
}

const optionalString = value => {
  const text = String(value || '')
  return text ? text : undefined
}

const truncateSearchText = (value, maxChars) => String(value || '').slice(0, maxChars)

const nodeHasCompletedSummary = node => {
  const meta = node && node.summaryMeta || {}
  return node && (node.kind === 'summary_span' || node.kind === 'session') &&
    meta.status === 'completed' &&
    meta.strategy !== 'summary-disabled' &&
    compactText(node && node.head)
}

const sourceMessageNode = node => {
  const meta = node && node.meta || {}
  return meta.type === 'message' &&
    (meta.role === 'user' || meta.role === 'assistant') &&
    (node.kind === 'message' || /^event_content(?:_chunk)?$/.test(String(node.kind || '')))
}

const sourceMessageContainer = node => Boolean(node &&
  node.kind === 'message' &&
  node.meta && node.meta.type === 'message' &&
  (node.meta.role === 'user' || node.meta.role === 'assistant'))

const sourceMessageContentNode = (node, parent) => Boolean(node && parent &&
  sourceMessageContainer(parent) &&
  /^event_content(?:_chunk)?$/.test(String(node.kind || '')))

const navigationChildren = node => sourceMessageContainer(node)
  ? []
  : modelVisibleChildren(node && node.children)

const modelTextForNode = node => {
  if (!node || isModelHiddenNode(node)) return ''
  if (sourceMessageNode(node)) {
    return node.kind === 'message'
      ? concatRaw(node)
      : String(node.raw || '')
  }
  if (nodeHasCompletedSummary(node)) return String(node.head || '')
  return ''
}

const navigationTextForNode = node => {
  const text = modelTextForNode(node)
  return sourceMessageNode(node) ? truncateSearchText(text, MAX_SEARCH_MESSAGE_CHARS) : text
}

const browseRef = (tree, node) => {
  const ref = nodeRef(tree, node, { includeResourceLinks: false })
  return {
    handle: ref.handle,
    index_id: ref.index_id,
    index: optionalString(ref.index),
    line: ref.sourceLineNumber || undefined,
    text: navigationTextForNode(node) || undefined,
    openable: Boolean(sourceMessageNode(node)),
    child_count: navigationChildren(node).length
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

const browseNode = (tree, opts = {}) => {
  const topicId = normalizeBrowseTopicId(opts.topicId || opts.topic_id || '')
  const parsedTopicId = topicId ? parseTopicId(topicId) : null
  if (topicId && !parsedTopicId) throw new Error(`Invalid browse topic_id: ${topicId}`)
  const zoom = normalizeBrowseZoom({ zoom: opts.zoom, topicId })
  const handle = parsedTopicId && parsedTopicId.handle || opts.handle || tree.root.handle
  let node = tree.byHandle.get(handle)
  if (!node) throw new Error(`Unknown session handle: ${handle}`)
  if (zoom === 'out' || zoom === 'siblings') {
    const parentHandle = tree.parentByHandle && tree.parentByHandle.get(node.handle)
    if (parentHandle) node = tree.byHandle.get(parentHandle) || node
  }
  if (isModelHiddenNode(node)) throw new Error(`Reasoning records are not available through conversation_history: ${handle}`)
  const directChildren = navigationChildren(node)
  const discoveredRoot = !navigationTextForNode(node) &&
    node.kind === 'session' &&
    directChildren.length === 1 &&
    directChildren[0].kind === 'summary_span'
      ? directChildren[0]
      : node
  const visibleChildren = navigationChildren(discoveredRoot)
  const start = Math.max(0, Number(opts.start !== undefined ? opts.start : opts.startAt || opts.start_at || 0) || 0)
  const filteredChildren = visibleChildren.filter(child => topicMatches(child.topics, opts.topic))
  const pageChildren = filteredChildren
    .slice(start, start + (opts.limit || 20))
  const limit = Math.max(1, Number(opts.limit || 20))
  const nextStart = start + pageChildren.length
  return {
    handle: node.handle,
    zoom,
    index_id: tree.ir.indexId,
    text: navigationTextForNode(discoveredRoot) || undefined,
    openable: Boolean(sourceMessageContainer(discoveredRoot)),
    child_count: visibleChildren.length,
    page: {
      start,
      limit,
      returned: pageChildren.length,
      total: filteredChildren.length,
      next_start: nextStart < filteredChildren.length ? nextStart : undefined
    },
    children: pageChildren.map(child => browseRef(tree, child))
  }
}

const nodeSearchText = (node, opts = {}) => {
  if (!node || isModelHiddenNode(node)) return ''
  if (sourceMessageNode(node)) {
    return truncateSearchText(modelTextForNode(node), MAX_SEARCH_MESSAGE_CHARS)
  }
  if (!opts.isPendingSummary && nodeHasCompletedSummary(node)) {
    return String(node.head || '')
  }
  return ''
}

const defaultRetrievalVisible = (node, parent) => Boolean(node &&
  !isModelHiddenNode(node) &&
  !sourceMessageContentNode(node, parent) &&
  (node.kind === 'session' || modelTextForNode(node))
)

const isModelHiddenDoc = doc => Boolean(doc && (
  doc.kind === 'reasoning' ||
  /\/reasoning(?:\/|$)/.test(String(doc.handle || ''))
))

const collectIndexDocuments = (tree, opts = {}) => {
  const docs = []
  const indexId = tree.ir.indexId || indexIdForIR(tree.ir)
  const customRetrievalVisible = typeof opts.retrievalVisible === 'function'
    ? opts.retrievalVisible
    : null
  const retrievalVisible = (node, parent) => opts.retrievalVisible !== false &&
    defaultRetrievalVisible(node, parent) &&
    (!customRetrievalVisible || customRetrievalVisible(node, parent))
  const visit = (node, parent, depth) => {
    if (isModelHiddenNode(node)) return
    const isLeaf = !node.children.length
    const retrievalChildren = modelVisibleChildren(node.children)
      .filter(child => retrievalVisible(child, node))
    const isPendingSummary = node.kind === 'summary_span' &&
      node.summaryMeta &&
      node.summaryMeta.status &&
      node.summaryMeta.status !== 'completed'
    const searchText = nodeSearchText(node, { isPendingSummary })
    const agent = tree.ir.session.agent || ''
    docs.push({
      id: hashString(`${agent}:${indexId}:${node.handle}`),
      indexId,
      sessionId: tree.ir.session.id,
      agent,
      sourceKind: tree.ir.source.kind,
      handle: node.handle,
      link: sessionLink({ indexId, handle: node.handle }),
      parentHandle: parent && parent.handle,
      ...nodeNavigation(tree, node, parent, depth),
      ...nodeTimeFields(node),
      ...nodeConversationFields(node),
      ...nodeSourceFields(node),
      depth,
      kind: node.kind,
      mipLevel: retrievalChildren.length ? 'summary' : 'leaf',
      retrievalVisible: Boolean(retrievalVisible(node, parent)),
      isVerbatim: isLeaf || sourceMessageContainer(node),
      title: node.title || '',
      breadcrumb: node.breadcrumb || '',
      summary: node.head || '',
      topics: [],
      summaryModel: node.summaryModel || DEFAULT_SUMMARY_MODEL,
      summaryMeta: compactSummaryMeta(node.summaryMeta),
      searchText,
      excerpt: isLeaf ? preview(node.raw, 700) : preview(node.head, 700),
      content: isLeaf ? node.raw : '',
      childCount: retrievalChildren.length,
      renderedTokenCount: node.renderedTokenCount,
      nextLevelTokenCount: node.nextLevelTokenCount,
      fullTokenCount: node.fullTokenCount,
      usage: node.usage,
      ts: Number(node.meta && (node.meta.at || node.meta.startAt) && Date.parse(node.meta.at || node.meta.startAt)) || 0,
      resourceLinks: node.resourceLinks || []
    })
    for (const child of modelVisibleChildren(node.children)) visit(child, node, depth + 1)
  }
  visit(tree.root, null, 0)
  return docs
}

module.exports = {
  applyCompactionSearchScope,
  browseNode,
  buildMipTree,
  compactedEventSpans,
  compactedPrefixChildren,
  compactedRetrievalHandles,
  createSummaryNode,
  collectIndexDocuments,
  DEFAULT_SUMMARY_MODEL,
  hydrateMipTree,
  indexIdForIR,
  isModelHiddenNode,
  isModelVisibleNode,
  lastCompactionChildIndex,
  modelVisibleChildren,
  nodeConversationFields,
  nodeSourceFields,
  nodeTimeFields,
  modelTextForNode,
  navigationTextForNode,
  openLink,
  parseSessionLink,
  rebuildTreeIndex,
  renderNode,
  sessionLink
}
