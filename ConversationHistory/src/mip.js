const {
  compactText,
  estimateTokens,
  hashString,
  preview,
  safeId,
  stableStringify
} = require('./util.js')
const { addUsage, blockText, eventText, normalizeUsage } = require('./ir.js')
const { normalizeTopics, parseTopicId, topicIdForHandle, topicText, topicsText } = require('./topics.js')

const RAW_CHUNK_CHARS = 6000
const MAX_INDEX_TEXT_CHARS = 20000
const MAX_INNER_DESCENDANT_SEARCH_CHARS = 8000
const MAX_TOPICS = 8
const DEFAULT_SUMMARY_MODEL = 'summary-not-generated'

const unique = values => [...new Set((values || []).filter(value => typeof value === 'string' && value.length))]

const hasUsage = usage => Object.values(normalizeUsage(usage)).some(Boolean)

const makeHandle = parts => parts.map(part => encodeURIComponent(String(part))).join('/')

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

const flattenSearchParts = (value, out = [], depth = 0) => {
  if (value == null || depth > 5) return out
  if (typeof value === 'string') {
    out.push(value)
    if (/^\s*[\[{"]/.test(value)) {
      try {
        flattenSearchParts(JSON.parse(value), out, depth + 1)
      } catch (_err) {}
    }
    return out
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenSearchParts(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      flattenSearchParts(child, out, depth + 1)
    }
  }
  return out
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
  const visibleChildren = modelVisibleChildren(node.children)
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

const eventResourceLinks = ({ sessionId, event, eventHandle, pairedHandle }) => unique([
  sessionLink({ sessionId, handle: eventHandle }),
  pairedHandle ? sessionLink({ sessionId, handle: pairedHandle }) : undefined
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
      resourceLinks: eventResourceLinks({ sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
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
      resourceLinks: eventResourceLinks({ sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
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
      resourceLinks: eventResourceLinks({ sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
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
      resourceLinks: eventResourceLinks({ sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
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
      resourceLinks: eventResourceLinks({ sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
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
    resourceLinks: eventResourceLinks({ sessionId: ir.session.id, event, eventHandle: base, pairedHandle })
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
  const childHash = hashString((children || []).map(child => child.handle).join('\n')).slice(0, 12)
  const padded = String(index).padStart(4, '0')
  return section({
    handle: `${tree.root.handle}/summary/level-${level}/span-${padded}-${childHash}`,
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

const nodeRef = (tree, node, opts = {}) => ({
  handle: node.handle,
  link: sessionLink({ sessionId: tree.ir.session.id, handle: node.handle }),
  parentHandle: tree.parentByHandle && tree.parentByHandle.get(node.handle) || undefined,
  ...nodeNavigation(tree, node),
  ...nodeTimeFields(node),
  ...nodeConversationFields(node),
  kind: node.kind,
  title: node.title,
  breadcrumb: node.breadcrumb || '',
  head: node.head,
  childCount: modelVisibleChildren(node.children).length,
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
  const visibleChildren = modelVisibleChildren(node.children)
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

const browseTopicsForRefs = refs => {
  const out = []
  const seen = new Set()
  for (const ref of refs || []) {
    const topics = normalizeTopics(ref.topics || [], { max: 0 })
    const fallback = ref.head || ref.title || ref.breadcrumb || ''
    const values = topics.length ? topics : fallback ? [fallback] : []
    for (let index = 0; index < values.length; index += 1) {
      const topicId = topicIdForHandle({ handle: ref.handle, topicIndex: topics.length ? index : -1 })
      if (!topicId || seen.has(topicId)) continue
      seen.add(topicId)
      out.push({
        topic_id: topicId,
        label: optionalString(ref.breadcrumb) || optionalString(ref.title) || `topic ${out.length + 1}`,
        description: values[index],
        index: optionalString(ref.index)
      })
    }
  }
  return out
}

const browseRef = (tree, node) => {
  const ref = nodeRef(tree, node, { includeResourceLinks: false })
  const topics = browseTopicsForRefs([ref])
  return {
    topic_id: topicIdForHandle({ handle: node.handle }),
    link: ref.link,
    index: optionalString(ref.index),
    kind: ref.kind,
    title: ref.title,
    breadcrumb: optionalString(ref.breadcrumb),
    summary: ref.head || undefined,
    topics: topics.length ? topics : undefined,
    isVerbatim: !node.children.length,
    child_count: Number(ref.childCount || 0),
    full_token_count: Number(ref.fullTokenCount || 0) || undefined
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
  const visibleChildren = modelVisibleChildren(node.children)
  const start = Math.max(0, Number(opts.start !== undefined ? opts.start : opts.startAt || opts.start_at || 0) || 0)
  const filteredChildren = visibleChildren.filter(child => topicMatches(child.topics, opts.topic))
  const pageChildren = filteredChildren
    .slice(start, start + (opts.limit || 20))
  const childRefs = pageChildren.map(child => nodeRef(tree, child, { includeResourceLinks: false }))
  const limit = Math.max(1, Number(opts.limit || 20))
  const nextStart = start + pageChildren.length
  return {
    topic_id: topicIdForHandle({ handle: node.handle }),
    selected_topic_id: topicId || undefined,
    zoom,
    link: sessionLink({ sessionId: tree.ir.session.id, handle: node.handle }),
    ...nodeTimeFields(node),
    ...nodeConversationFields(node),
    kind: node.kind,
    title: node.title,
    breadcrumb: node.breadcrumb || '',
    summary: node.head,
    topics: browseTopicsForRefs(childRefs),
    child_count: visibleChildren.length,
    page: {
      start,
      limit,
      returned: pageChildren.length,
      total: filteredChildren.length,
      next_start: nextStart < filteredChildren.length ? nextStart : undefined
    },
    topic_filter: opts.topic || undefined,
    children: pageChildren.map(child => browseRef(tree, child))
  }
}

const nodeSearchText = (node, opts = {}) => [
  node.title,
  node.breadcrumb,
  node.head,
  node.raw,
  stableStringify(node.usage),
  topicsText(opts.topics || node.topics || []),
  stableStringify(node.meta),
  ...flattenSearchParts(node.meta)
].join('\n')

const isModelHiddenDoc = doc => Boolean(doc && (
  doc.kind === 'reasoning' ||
  /\/reasoning(?:\/|$)/.test(String(doc.handle || ''))
))

const appendBounded = (parts, value, state, maxChars) => {
  if (state.used >= maxChars || value == null) return
  const text = String(value)
  if (!text) return
  const remaining = maxChars - state.used
  parts.push(text.length > remaining ? text.slice(0, remaining) : text)
  state.used += Math.min(text.length, remaining)
}

const compactNodeSearchText = node => [
  node.title,
  node.breadcrumb,
  node.head,
  topicsText(node.topics || []),
  stableStringify(node.meta)
].filter(Boolean).join('\n')

const boundedDescendantSearchText = (node, maxChars = MAX_INNER_DESCENDANT_SEARCH_CHARS) => {
  const parts = []
  const state = { used: 0 }
  const visit = child => {
    if (!child || state.used >= maxChars) return
    if (isModelHiddenNode(child)) return
    appendBounded(parts, compactNodeSearchText(child), state, maxChars)
    if (!child.children.length) {
      appendBounded(parts, child.raw, state, maxChars)
      return
    }
    for (const grandchild of child.children) {
      if (state.used >= maxChars) break
      visit(grandchild)
    }
  }
  for (const child of modelVisibleChildren(node.children)) {
    if (state.used >= maxChars) break
    visit(child)
  }
  return parts.join('\n')
}

const collectIndexDocuments = tree => {
  const docs = []
  const visit = (node, parent, depth) => {
    if (isModelHiddenNode(node)) return
    const isLeaf = !node.children.length
    const isPendingSummary = node.kind === 'summary_span' &&
      node.summaryMeta &&
      node.summaryMeta.status &&
      node.summaryMeta.status !== 'completed'
    const docTopics = isPendingSummary ? [] : node.topics || []
    const searchText = isLeaf
      ? nodeSearchText(node, { topics: docTopics })
      : isPendingSummary
        ? nodeSearchText(node, { topics: docTopics })
      : [nodeSearchText(node, { topics: docTopics }), boundedDescendantSearchText(node)].join('\n')
    const agent = tree.ir.session.agent || ''
    docs.push({
      id: hashString(`${agent}:${tree.ir.session.id}:${node.handle}`),
      sessionId: tree.ir.session.id,
      agent,
      sourceKind: tree.ir.source.kind,
      handle: node.handle,
      link: sessionLink({ sessionId: tree.ir.session.id, handle: node.handle }),
      parentHandle: parent && parent.handle,
      ...nodeNavigation(tree, node, parent, depth),
      ...nodeTimeFields(node),
      ...nodeConversationFields(node),
      depth,
      kind: node.kind,
      mipLevel: node.children.length ? 'summary' : 'leaf',
      isVerbatim: isLeaf,
      title: node.title || '',
      breadcrumb: node.breadcrumb || '',
      summary: node.head || '',
      topics: docTopics,
      summaryModel: node.summaryModel || DEFAULT_SUMMARY_MODEL,
      summaryMeta: compactSummaryMeta(node.summaryMeta),
      searchText: searchText.slice(0, MAX_INDEX_TEXT_CHARS),
      excerpt: isLeaf ? preview(node.raw, 700) : preview(node.head, 700),
      content: isLeaf ? node.raw : '',
      childCount: node.children.length,
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
  createSummaryNode,
  collectIndexDocuments,
  DEFAULT_SUMMARY_MODEL,
  hydrateMipTree,
  isModelHiddenNode,
  isModelVisibleNode,
  lastCompactionChildIndex,
  modelVisibleChildren,
  nodeConversationFields,
  nodeTimeFields,
  openLink,
  parseSessionLink,
  rebuildTreeIndex,
  renderNode,
  sessionLink
}
