const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { z } = require('zod')
const { loadCodexSessionTools } = require('./codexSessionTools.js')
const { resolveCodexSessionForMarker } = loadCodexSessionTools()
const { createMcpLogger, installMcpProcessLogging } = require('./mcpLog.js')

const REPO_ROOT = path.resolve(__dirname, '..')
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'session-indexer.js')
const MAX_CLI_OUTPUT_BYTES = 50 * 1024 * 1024
const SESSION_MARKER_PREFIX = 'conversation_history-session-'
const SHUTDOWN_TIMEOUT_MS = 10000
const SESSION_MARKER_SCAN_LIMIT = 100
const SESSION_MARKER_SCAN_BYTES = 8 * 1024 * 1024
const STATUS_POLL_INITIAL_MS = 15_000
const STATUS_POLL_MAX_MS = 120_000
const STATUS_POLL_ESTIMATE_BUFFER_MS = 1_000
const ASYNC_OPERATION_PREFIX = 'conversation_history-op-'
const ASYNC_OPERATION_TTL_MS = 30 * 60 * 1000
const ASYNC_POLL_RETRY_MS = 1_000
const ASYNC_INDEX_POLL_RETRY_MS = 2_000
const MCP_INDEX_DEBOUNCE_MS = 100

const statusPollMemory = new Map()

const stringArg = value => typeof value === 'string' && value.length ? value : undefined

const pushFlag = (argv, flag, value) => {
  if (value === undefined || value === null || value === '') return
  argv.push(flag, String(value))
}

const pushBool = (argv, flag, value) => {
  if (value) argv.push(flag)
}

const makeSessionMarker = () => `${SESSION_MARKER_PREFIX}${crypto.randomUUID()}`

const isAllScope = (args = {}) => args.all || args.scope === 'all'

const defaultSource = () => process.env.SESSION_INDEXER_SOURCE ||
  (process.env.SESSION_INDEXER_DEPLOY_TARGET === 'claude-plugin' ? 'claude' : 'codex')

const defaultSourceRoot = source => source === 'claude'
  ? path.join(os.homedir(), '.claude', 'projects')
  : path.join(os.homedir(), '.codex', 'sessions')

const shouldResolveThisChat = (args = {}) => (args.this_chat !== false && !args.session && !args.latest && !isAllScope(args)) || args.this_chat

const compactErrorMessage = err => err && err.message ? String(err.message).slice(0, 240) : String(err || '').slice(0, 240)

const codexSessionIdFromPath = file => {
  const match = String(file || '').match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match ? match[1] : null
}

const resolveCurrentMarkerSession = async (args = {}) => {
  const source = args.source || defaultSource()
  if (source !== 'codex') {
    return {
      ok: false,
      status: 'blocked',
      reason: 'unsupported_current_marker_source',
      message: 'Current-session MCP scoping by conversation_history marker is only available for Codex source sessions.'
    }
  }
  const sessionMarker = stringArg(args.session_marker)
  if (!sessionMarker) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'missing_current_session_marker',
      message: 'No conversation_history response marker is bound in this MCP process, so conversation_history did not fall back to the global session catalog.'
    }
  }
  try {
    const root = args.source_root || defaultSourceRoot(source)
    const markerSinceMs = Number(args.session_marker_since_ms)
    const resolveArgs = {
      marker: sessionMarker,
      maxBytes: SESSION_MARKER_SCAN_BYTES,
      limit: SESSION_MARKER_SCAN_LIMIT
    }
    if (Number.isFinite(markerSinceMs) && markerSinceMs > 0) {
      resolveArgs.sessionMarkerSinceMs = markerSinceMs
    }
    const resolved = args.codex_session_service
      ? await args.codex_session_service.resolveMarker(resolveArgs)
      : resolveCodexSessionForMarker(root, sessionMarker, resolveArgs)
    if (resolved && resolved.ok === false) {
      return {
        ok: false,
        status: resolved.status || 'blocked',
        reason: resolved.reason || 'current_session_marker_lookup_failed',
        sessionMarker,
        error: resolved.error,
        message: 'Codex session marker lookup failed, so conversation_history did not fall back to the global session catalog.'
      }
    }
    const sessionId = resolved && (
      resolved.codex_session_id ||
      resolved.sessionId ||
      resolved.session_id ||
      resolved.id ||
      codexSessionIdFromPath(resolved.file)
    )
    if (!sessionId) {
      return {
        ok: false,
        status: 'blocked',
        reason: 'current_session_marker_session_id_missing',
        sessionMarker,
        path: resolved && resolved.file || null,
        message: 'Codex session marker resolved without a session id, so conversation_history did not fall back to the global session catalog.'
      }
    }
    return {
      ok: true,
      status: 'resolved',
      source,
      sessionMarker,
      sessionId,
      path: resolved && resolved.file || null,
      reason: resolved && resolved.reason
    }
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      reason: err && err.code === 'AMBIGUOUS_SESSION_MARKER'
        ? 'current_session_marker_ambiguous'
        : 'current_session_marker_lookup_failed',
      sessionMarker,
      error: compactErrorMessage(err),
      message: 'Codex session marker lookup failed, so conversation_history did not fall back to the global session catalog.'
    }
  }
}

const currentScopeForResult = scope => {
  const out = {
    kind: 'current_session',
    status: scope && scope.status || (scope && scope.ok ? 'resolved' : 'blocked')
  }
  if (scope && scope.source) out.source = scope.source
  if (scope && scope.reason) out.reason = scope.reason
  if (scope && scope.error) out.error = scope.error
  return out
}

const currentSessionNotIndexedBrowse = (scope, args = {}) => ({
  schema: 'session-indexer.browse.v1',
  status: 'not_indexed',
  reason: 'current_session_not_indexed',
  message: 'The current Codex session is not indexed yet.',
  scope: currentScopeForResult(scope),
  page: {
    start: args.start || args.start_at || 0,
    limit: args.limit || 20,
    returned: 0,
    total: 0
  },
  children: []
})

const defaultToCurrentSessionScope = async (args, lifecycle) => {
  bindLifecycleSessionMarker(args, lifecycle)
  const sessionMarker = stringArg(args.session_marker) || lifecycle.currentSessionMarker()
  const cached = lifecycle.resolvedSession(sessionMarker)
  if (cached && cached.ok) {
    args.session_id = cached.sessionId
    return { scoped: true, current: cloneJson(cached) }
  }
  const current = await resolveCurrentMarkerSession(args)
  if (!current.ok) return { scoped: true, current }
  lifecycle.rememberResolvedSession(current.sessionMarker, current)
  args.session_id = current.sessionId
  return { scoped: true, current }
}

const currentSessionScopeError = current => {
  const reason = current && current.reason || 'current_session_scope_unavailable'
  const detail = current && (current.error || current.message) || 'current-session lookup did not resolve to exactly one Codex session JSONL file'
  return new Error(`conversation_history current-session binding failed (${reason}): ${detail}`)
}

const withCurrentScope = (result, scope) => {
  if (!scope || !scope.scoped || !scope.current) return result
  return {
    ...result,
    scope: currentScopeForResult(scope.current)
  }
}

const withCurrentStatusScope = (result, scope) => {
  const scoped = withCurrentScope(result, scope)
  if (scope && scope.scoped && scope.current && scope.current.ok && Array.isArray(scoped.sessions) && scoped.sessions.length === 0) {
    return {
      ...scoped,
      status: 'not_indexed',
      reason: 'current_session_not_indexed',
      message: 'The current Codex session is not indexed yet.'
    }
  }
  return scoped
}

const currentSessionMissingFrom = err => /Unknown session browse target|Unknown index browse target|no indexed|not indexed/i.test(compactErrorMessage(err))

const scopedRootHandle = sessionId => `session/${encodeURIComponent(sessionId)}`

const publicHandleForScope = (handle, scope = {}) => {
  const text = String(handle || '')
  const sessionId = scope.sessionId || scope.current && scope.current.sessionId
  if (!text || !sessionId) return text
  const root = scopedRootHandle(sessionId)
  if (text === root) return 'root'
  if (text.startsWith(`${root}/`)) return text.slice(root.length + 1)
  return text
}

const internalHandleForScope = (handle, scope = {}) => {
  const text = String(handle || '').trim()
  const sessionId = scope && scope.current && scope.current.sessionId || scope && scope.sessionId
  if (!text || !sessionId) return text || undefined
  if (text === 'root') return scopedRootHandle(sessionId)
  if (text.startsWith('session/')) return text
  return `${scopedRootHandle(sessionId)}/${text}`
}

const stripImplementationDetails = (value, scope = {}) => {
  if (Array.isArray(value)) return value.map(item => stripImplementationDetails(item, scope))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (key.startsWith('_')) continue
    if (lower.includes('typesense')) continue
    if (key === 'searchBackend' || key === 'serverIndex' || key === 'managed') continue
    if (key === 'sessionId' || key === 'session_id') continue
    if (key === 'indexId' || key === 'index_id') continue
    if (key === 'sourcePath' || key === 'source_path' || key === 'sourceRoot' || key === 'source_root' || key === 'sourceFingerprint') continue
    if (key === 'currentSessionResolution') continue
    if (key === 'rootHandle' || key === 'parentHandle') continue
    if (key === 'link' || key === 'sourceLink' || key === 'resourceLinks') continue
    if (key === 'topic' || key === 'topics' || key === 'topic_id' || key === 'topic_filter' || key === 'selected_topic_id') continue
    if (key === 'title' || key === 'breadcrumb' || key === 'head' || key === 'summary' || key === 'excerpt') continue
    if (key === 'summaryModel' || key === 'summaryMeta') continue
    if (key === 'usage' || key === 'navigation') continue
    if (key === 'messageId' || key === 'inReplyToMessageId' || key === 'inReplyTo' || key === 'toolCallId') continue
    if (key === 'sourceKind' || key === 'role' || key === 'kind' || key === 'mipLevel') continue
    if (key === 'at' || key === 'timeRange') continue
    if (key === 'maxSummaryNodes' || key === 'max_summary_nodes') continue
    if (key === 'removedFiles' || key === 'removedJobArtifacts') continue
    if (key === 'compactions' || key === 'compactionLog') continue
    out[key] = key === 'handle'
      ? publicHandleForScope(item, scope)
      : stripImplementationDetails(item, scope)
  }
  return out
}

const compactNavigationRef = ref => {
  if (!ref || typeof ref !== 'object') return ref
  const out = {}
  if (ref.handle) out.handle = ref.handle
  if (ref.text) out.text = ref.text
  if (ref.openable) out.openable = true
  else if (Number(ref.child_count || 0) > 0) out.child_count = Number(ref.child_count)
  return out
}

const navigationRefKey = ref => {
  const text = String(ref && ref.text || '').replace(/\s+/g, ' ').trim()
  const line = Number(ref && ref.line || 0)
  if (text && line) return `${line}:${text}`
  return `handle:${ref && ref.handle || ''}:${text}`
}

const canonicalNavigationRefs = refs => {
  const byKey = new Map()
  for (const ref of refs || []) {
    if (!ref || typeof ref !== 'object') continue
    const key = navigationRefKey(ref)
    const previous = byKey.get(key)
    if (!previous || String(ref.handle || '').length < String(previous.handle || '').length) {
      byKey.set(key, ref)
    }
  }
  return [...byKey.values()]
}

const compactRetrievalResult = clean => {
  const schema = clean && clean.schema
  if (schema === 'session-indexer.search.v1') {
    return {
      schema,
      hits: canonicalNavigationRefs(clean.hits).map(compactNavigationRef)
    }
  }
  if (schema === 'session-indexer.browse.v1') {
    const children = canonicalNavigationRefs(clean.children)
    const ownKey = navigationRefKey(clean)
    const repeatedByChild = children.some(child => navigationRefKey(child) === ownKey)
    const out = {
      schema,
      ...(clean.status ? { status: clean.status } : {}),
      ...(clean.reason ? { reason: clean.reason } : {}),
      ...(clean.message ? { message: clean.message } : {}),
      ...(clean.handle ? { handle: clean.handle } : {}),
      ...(!repeatedByChild && clean.text ? { text: clean.text } : {}),
      ...(clean.openable ? { openable: true } : {}),
      ...(Number(clean.child_count || 0) > 0 ? { child_count: Number(clean.child_count) } : {}),
      children: children.map(compactNavigationRef)
    }
    if (clean.page && clean.page.next_start !== undefined) out.next_start = clean.page.next_start
    return out
  }
  if (schema === 'session-indexer.openLink.v1') {
    return {
      schema,
      ...(clean.handle ? { handle: clean.handle } : {}),
      isVerbatim: Boolean(clean.isVerbatim),
      omittedTokenCount: Number(clean.omittedTokenCount || 0),
      content: clean.content || ''
    }
  }
  return clean
}

const renderNavigationRef = ref => {
  const action = ref.openable ? 'open' : Number(ref.child_count || 0) > 0 ? 'browse' : 'select'
  const text = String(ref.text || '').trim()
  const target = ref.handle ? `${action}: ${ref.handle}` : ''
  return [text, target].filter(Boolean).join('\n  ')
}

const renderRetrievalResult = result => {
  if (result.schema === 'session-indexer.search.v1') {
    const hits = result.hits || []
    return hits.length
      ? hits.map(ref => `- ${renderNavigationRef(ref)}`).join('\n')
      : 'No matching conversation records.'
  }
  if (result.schema === 'session-indexer.browse.v1') {
    if (result.status && result.status !== 'resolved') {
      return [result.status, result.reason, result.message].filter(Boolean).join(' ')
    }
    const lines = []
    if (result.text) lines.push(result.text)
    if (result.openable && result.handle) lines.push(`open: ${result.handle}`)
    for (const child of result.children || []) lines.push(`- ${renderNavigationRef(child)}`)
    if (result.next_start !== undefined) lines.push(`next: start=${result.next_start}`)
    return lines.filter(Boolean).join('\n') || 'No conversation records at this level.'
  }
  if (result.schema === 'session-indexer.openLink.v1') {
    const state = `source: ${result.handle || 'unknown'} verbatim=${result.isVerbatim ? 1 : 0} omitted=${result.omittedTokenCount}`
    return [result.content, state].filter(Boolean).join('\n\n')
  }
  return null
}

const toolResult = (result, scope = {}) => {
  const clean = compactRetrievalResult(stripImplementationDetails(result, scope))
  const rendered = renderRetrievalResult(clean)
  return {
    content: [{
      type: 'text',
      text: rendered || JSON.stringify(clean, null, 2)
    }],
    structuredContent: {
      result: clean
    }
  }
}

const CONVERSATION_HISTORY_SYSTEM_PROMPT = `
Active context can compact. conversation_history keeps the conversation outside the context window as a hierarchy.

Search finds candidate regions. Browse moves through the hierarchy by handle and zoom. OpenLink spends a bounded token budget on source text.

Higher zoom levels are compact navigation. The lowest zoom level is lossless. Trust opened source when isVerbatim is true.

Keep recovery incremental: search or browse first, open the smallest relevant link, and increase budget_tokens on the same link when omittedTokenCount is nonzero. Do not fill gaps from memory when the transcript can be recovered.

Search, browse, openLink, and index status are read-only. If retrieval reports current_session_not_indexed, call start_indexing_session explicitly.
`.trim()

const preview = value => {
  const text = String(value || '').trim()
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text
}

const runCli = argv => new Promise((resolve, reject) => {
  const child = childProcess.spawn(process.execPath, [CLI_PATH, ...argv], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout = []
  const stderr = []
  let outputBytes = 0
  let outputTooLarge = false
  let settled = false

  const finish = (err, value) => {
    if (settled) return
    settled = true
    if (err) reject(err)
    else resolve(value)
  }

  const append = (chunks, chunk) => {
    outputBytes += chunk.length
    if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
      outputTooLarge = true
      child.kill('SIGTERM')
      return
    }
    chunks.push(chunk)
  }

  child.stdout.on('data', chunk => append(stdout, chunk))
  child.stderr.on('data', chunk => append(stderr, chunk))
  child.on('error', err => finish(err))
  child.on('close', (code, signal) => {
    const stdoutText = Buffer.concat(stdout).toString('utf8')
    const stderrText = Buffer.concat(stderr).toString('utf8')
    if (outputTooLarge) {
      finish(new Error(`conversation_history CLI output exceeded ${MAX_CLI_OUTPUT_BYTES} bytes`))
      return
    }
    if (code !== 0) {
      const status = signal ? `signal ${signal}` : `exit ${code}`
      finish(new Error(`conversation_history CLI failed (${status})\nstderr:\n${preview(stderrText)}\nstdout:\n${preview(stdoutText)}`))
      return
    }
    finish(null, stdoutText)
  })
})

const parseCliResult = stdout => {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`conversation_history CLI returned invalid JSON: ${err.message}\nstdout:\n${preview(text)}`)
  }
}

const callConversationHistory = async argv => {
  return parseCliResult(await runCli(argv))
}

const cloneJson = value => JSON.parse(JSON.stringify(value || {}))

const asyncOperationId = () => `${ASYNC_OPERATION_PREFIX}${crypto.randomUUID()}`

const pendingMessageFor = reason => {
  if (reason === 'current_session_pending') return 'conversation_history is binding this request to the current Codex session.'
  if (reason === 'current_session_not_indexed') return 'The current Codex session is not indexed; call start_indexing_session explicitly.'
  if (reason === 'current_session_indexing') return 'conversation_history is waiting for the current Codex session index to become ready.'
  return 'conversation_history is still preparing this request.'
}

const pendingOperationPayload = ({
  operation,
  reason,
  message,
  retryAfterMs = ASYNC_POLL_RETRY_MS,
  current,
  indexing
}) => ({
  schema: 'conversation_history.async_operation.v1',
  status: 'pending',
  reason,
  message: message || pendingMessageFor(reason),
  operationId: operation.id,
  operation: operation.name,
  sessionMarker: operation.sessionMarker,
  createdAt: operation.createdAt,
  updatedAt: operation.updatedAt,
  poll: {
    tool: 'conversation_history_poll',
    operation_id: operation.id,
    retryAfterMs,
    retryAt: retryAtFrom(Date.now(), retryAfterMs)
  },
  ...(current ? { scope: currentScopeForResult(current) } : {}),
  ...(indexing ? { indexing } : {})
})

const terminalAsyncPayload = ({ operation, status, reason, message, current }) => ({
  schema: 'conversation_history.async_operation.v1',
  status,
  reason,
  message,
  operationId: operation && operation.id,
  operation: operation && operation.name,
  ...(operation && operation.sessionMarker ? { sessionMarker: operation.sessionMarker } : {}),
  ...(current ? { scope: currentScopeForResult(current) } : {})
})

const parseTimeMs = value => {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

const retryAtFrom = (nowMs, retryAfterMs) => new Date(nowMs + Math.max(0, Number(retryAfterMs || 0))).toISOString()

const statusPollKey = session => [
  session && (session.indexId || session.sessionId || 'unknown-index'),
  session && session.sessionId || 'unknown-session',
  session && session.indexingJob && session.indexingJob.jobId || 'no-job'
].join(':')

const statusPollSessionPrefix = session => [
  session && (session.indexId || session.sessionId || 'unknown-index'),
  session && session.sessionId || 'unknown-session'
].join(':')

const deleteStatusPollMemoryForSession = (session, exceptKey = null) => {
  const prefix = `${statusPollSessionPrefix(session)}:`
  for (const key of statusPollMemory.keys()) {
    if (key.startsWith(prefix) && key !== exceptKey) statusPollMemory.delete(key)
  }
}

const statusPollFingerprint = session => {
  const job = session && session.indexingJob || {}
  const progress = job.progress || {}
  const stats = session && session.indexingStats || {}
  const store = session && session.summaryTargetStore || {}
  return JSON.stringify({
    state: session && session.state,
    indexed: session && session.indexed,
    jobStatus: job.status,
    suspendedReason: job.suspendedReason,
    progressPhase: progress.phase,
    progressTargetId: progress.targetId,
    progressCompletedModelJobCount: progress.completedModelJobCount,
    progressTotalModelJobCount: progress.totalModelJobCount,
    indexedCompactionCount: stats.indexedCompactionCount,
    pendingCompactionCount: stats.pendingCompactionCount,
    completedTargetCount: stats.completedTargetCount,
    pendingTargetCount: stats.pendingTargetCount,
    failedTargetCount: stats.failedTargetCount,
    currentStoredCompletedTargetCount: store.currentStoredCompletedTargetCount,
    currentStoredClaimedTargetCount: store.currentStoredClaimedTargetCount,
    currentStoredFailedTargetCount: store.currentStoredFailedTargetCount,
    currentStoredStaleClaimCount: store.currentStoredStaleClaimCount
  })
}

const nextStatusPollForSession = (session, now = new Date()) => {
  const key = statusPollKey(session)
  if (!session || session.state === 'suspended-budget' || session.state === 'suspended') {
    deleteStatusPollMemoryForSession(session)
    const suspension = session && session.suspension
    return {
      retryAfterMs: null,
      retryAt: null,
      reason: 'approval_required',
      message: suspension && suspension.requiredAction
        ? `Indexing is suspended until the required action is handled. ${suspension.requiredAction}`
      : 'Indexing is suspended until the blocking condition is resolved.'
    }
  }
  const activeBackgroundIndexing = session &&
    session.indexed !== false &&
    session.indexingJob &&
    session.indexingJob.status &&
    !['ready', 'stopped', 'error', 'stale', 'suspended'].includes(session.indexingJob.status)
  if ((session.state !== 'indexing-in-progress' && !activeBackgroundIndexing) || !session.indexingJob) {
    deleteStatusPollMemoryForSession(session)
    return null
  }
  deleteStatusPollMemoryForSession(session, key)

  const fingerprint = statusPollFingerprint(session)
  const previous = statusPollMemory.get(key)
  const backoffMs = previous && previous.fingerprint === fingerprint
    ? Math.min(STATUS_POLL_MAX_MS, Math.max(STATUS_POLL_INITIAL_MS, Number(previous.backoffMs || STATUS_POLL_INITIAL_MS) * 2))
    : STATUS_POLL_INITIAL_MS
  const nowMs = now.getTime()
  const progress = session.indexingJob.progress || {}
  const retryAtMs = parseTimeMs(progress.retryAt)
  const estimatedCompletionMs = parseTimeMs(progress.estimatedCompletionAt)
  const retryAfterMs = Math.max(
    backoffMs,
    retryAtMs === null ? 0 : retryAtMs - nowMs + STATUS_POLL_ESTIMATE_BUFFER_MS,
    estimatedCompletionMs === null ? 0 : estimatedCompletionMs - nowMs + STATUS_POLL_ESTIMATE_BUFFER_MS
  )

  statusPollMemory.set(key, {
    fingerprint,
    backoffMs,
    updatedAt: now.toISOString()
  })

  return {
    retryAfterMs,
    retryAt: retryAtFrom(nowMs, retryAfterMs),
    reason: activeBackgroundIndexing
      ? 'background_indexing'
      : retryAtMs !== null
      ? 'worker_retry'
      : estimatedCompletionMs !== null
        ? 'estimated_completion'
        : 'active_indexing',
    source: retryAtMs !== null
      ? 'progress.retryAt'
      : estimatedCompletionMs !== null
        ? 'progress.estimatedCompletionAt'
        : 'mcp_backoff',
    message: retryAtMs !== null
      ? 'Poll after the worker retry window.'
      : estimatedCompletionMs !== null
        ? 'Poll after the current indexing batch is expected to complete.'
        : activeBackgroundIndexing
          ? 'Published index is usable; background indexing is catching up on newer transcript changes.'
          : 'Indexing is active; MCP is applying exponential backoff for repeated unchanged status.',
    backoff: {
      strategy: 'exponential',
      currentMs: backoffMs,
      initialMs: STATUS_POLL_INITIAL_MS,
      maxMs: STATUS_POLL_MAX_MS,
      resetOn: [
        'state changes',
        'progress phase or target changes',
        'completed or pending counts change',
        'job reaches ready, suspended, stopped, stale, or error'
      ]
    }
  }
}

const withStatusPollHints = result => {
  if (!result || !Array.isArray(result.sessions)) return result
  const now = new Date()
  return {
    ...result,
    sessions: result.sessions.map(session => {
      const nextStatusPoll = nextStatusPollForSession(session, now)
      return nextStatusPoll ? { ...session, nextStatusPoll } : session
    })
  }
}

const runCliSyncQuiet = argv => {
  childProcess.spawnSync(process.execPath, [CLI_PATH, ...argv], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'ignore',
    timeout: SHUTDOWN_TIMEOUT_MS
  })
}

const createPluginLifecycle = () => {
  const indexRoots = new Set()
  const asyncOperations = new Map()
  const indexingStarts = new Map()
  const resolvedSessions = new Map()
  let currentSessionMarker = ''
  let cleaned = false
  const rootArgs = root => root ? ['--index-dir', root] : []
  const pruneAsyncOperations = () => {
    const now = Date.now()
    for (const [id, operation] of asyncOperations) {
      if (now - operation.createdAtMs > ASYNC_OPERATION_TTL_MS) asyncOperations.delete(id)
    }
  }
  return {
    currentSessionMarker() {
      return currentSessionMarker
    },
    ensureCurrentSessionMarker(marker) {
      currentSessionMarker = stringArg(marker) || currentSessionMarker || makeSessionMarker()
      return currentSessionMarker
    },
    setCurrentSessionMarker(marker) {
      currentSessionMarker = stringArg(marker) || ''
      return currentSessionMarker
    },
    clearCurrentSessionMarker(marker) {
      if (!marker || marker === currentSessionMarker) currentSessionMarker = ''
    },
    createAsyncOperation({ name, args, sessionMarker }) {
      pruneAsyncOperations()
      const now = new Date()
      const operation = {
        id: asyncOperationId(),
        name,
        args: cloneJson(args),
        sessionMarker,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        createdAtMs: now.getTime(),
        updatedAtMs: now.getTime(),
        pollCount: 0
      }
      asyncOperations.set(operation.id, operation)
      return operation
    },
    asyncOperation(id) {
      pruneAsyncOperations()
      const operation = asyncOperations.get(String(id || ''))
      if (!operation) return null
      const now = new Date()
      operation.updatedAt = now.toISOString()
      operation.updatedAtMs = now.getTime()
      operation.pollCount += 1
      return operation
    },
    deleteAsyncOperation(id) {
      asyncOperations.delete(String(id || ''))
    },
    rememberIndexingStart(marker, result) {
      if (marker) indexingStarts.set(marker, result)
      return result
    },
    indexingStart(marker) {
      return marker ? indexingStarts.get(marker) : null
    },
    rememberResolvedSession(marker, current) {
      if (marker && current && current.ok && current.path) {
        resolvedSessions.set(marker, cloneJson(current))
      }
      return current
    },
    resolvedSession(marker) {
      return marker ? resolvedSessions.get(marker) : null
    },
    rememberIndexRoot(root) {
      indexRoots.add(root || '')
    },
    cleanupSync() {
      if (cleaned) return
      cleaned = true
      asyncOperations.clear()
      indexingStarts.clear()
      resolvedSessions.clear()
      for (const root of indexRoots) {
        const args = rootArgs(root)
        runCliSyncQuiet(['typesense_stop', '--timeout-ms', '5000', '--poll-ms', '100', ...args])
      }
    }
  }
}

const installShutdownHandlers = lifecycle => {
  const cleanupAndExit = code => {
    lifecycle.cleanupSync()
    process.exit(code)
  }
  process.once('beforeExit', () => lifecycle.cleanupSync())
  process.once('SIGINT', () => cleanupAndExit(130))
  process.once('SIGTERM', () => cleanupAndExit(143))
  process.once('SIGHUP', () => cleanupAndExit(129))
}

const commonSearchShape = {
  start_at: z.number().int().min(0).optional().describe('Zero-based result offset for paging.'),
  limit: z.number().int().positive().max(100).optional().describe('Maximum result count.')
}

const searchFilterShape = z.object({
  agent: z.string().optional(),
  messageId: z.string().optional(),
  inReplyToMessageId: z.string().optional(),
  toolCallId: z.string().optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'observer']).optional(),
  mip: z.number().int().min(0).optional(),
  mipLevel: z.string().optional()
}).optional()

const addCommonSearchArgs = (argv, args = {}) => {
  pushFlag(argv, '--start-at', args.start_at)
  pushFlag(argv, '--limit', args.limit)
}

const bindLifecycleSessionMarker = (args = {}, lifecycle) => {
  if (!stringArg(args.session_marker) && lifecycle && typeof lifecycle.currentSessionMarker === 'function') {
    args.session_marker = lifecycle.currentSessionMarker()
  }
  return stringArg(args.session_marker)
}

const addSourceArgs = (argv, args = {}) => {
  const source = args.source || defaultSource()
  pushFlag(argv, '--source', source)
  pushFlag(argv, '--source-root', args.source_root)
  pushFlag(argv, '--session-index', args.session_index)
  pushFlag(argv, '--session', args.session)
  pushBool(argv, '--latest', args.latest)
  const useThisChat = shouldResolveThisChat(args)
  const sessionMarker = stringArg(args.session_marker)
  if (useThisChat && !sessionMarker) throw new Error('resolving this chat requires session_marker')
  pushBool(argv, '--this-chat', useThisChat)
  pushFlag(argv, '--session-marker', sessionMarker)
  if (source === 'codex') pushBool(argv, '--include-response-messages', true)
  return sessionMarker
}

const currentSessionIndexArgv = args => {
  const argv = ['start_indexing_session']
  pushFlag(argv, '--scope', 'this_session_only')
  pushBool(argv, '--wait-for-session-marker', !args.session)
  pushFlag(argv, '--timeout-ms', 0)
  pushFlag(argv, '--debounce-ms', MCP_INDEX_DEBOUNCE_MS)
  if (!args.session) pushFlag(argv, '--session-marker-since-ms', args.session_marker_since_ms)
  addSourceArgs(argv, args)
  return argv
}

const currentResolutionIsRetryable = current => {
  const reason = current && current.reason
  return [
    'missing_current_session_marker',
    'current_session_marker_session_id_missing',
    'current_session_marker_lookup_failed',
    'current_session_marker_ambiguous'
  ].includes(reason)
}

const statusForCurrentSession = async sessionId => withStatusPollHints(await callConversationHistory([
  'index_status',
  '--start-at',
  '0',
  '--limit',
  '1',
  '--session-id',
  sessionId
]))

const operationNeedsReadyIndex = name => [
  'conversation_search',
  'conversation_browse',
  'conversation_openLink'
].includes(name)

const readinessForOperation = async ({ name, scope }) => {
  if (!operationNeedsReadyIndex(name)) return { ready: true }
  const status = await statusForCurrentSession(scope.current.sessionId)
  const session = status && status.sessions && status.sessions[0]
  if (!session) {
    return {
      ready: false,
      terminal: true,
      reason: 'current_session_not_indexed',
      message: 'The current Codex session is not indexed. Call start_indexing_session explicitly before searching or browsing it.',
      status
    }
  }
  if (session.indexed !== false) {
    return {
      ready: true,
      status
    }
  }
  if (session.state === 'error' || session.state === 'suspended' || session.state === 'suspended-budget') {
    return {
      ready: false,
      terminal: true,
      reason: session.state === 'error' ? 'current_session_index_error' : 'current_session_index_suspended',
      message: session.errorMessage || session.statusMessage || 'The current Codex session index is blocked.',
      status
    }
  }
  const jobStatus = session.indexingJob && session.indexingJob.status
  if (!session.indexingJob || ['not-started', 'stopped', 'stale'].includes(session.state) || ['stopped', 'stale'].includes(jobStatus)) {
    return {
      ready: false,
      terminal: true,
      reason: 'current_session_not_indexed',
      message: 'The current Codex session is not indexed. Call start_indexing_session explicitly before searching or browsing it.',
      status
    }
  }
  const nextStatusPoll = session.nextStatusPoll || {}
  return {
    ready: false,
    reason: 'current_session_indexing',
    message: 'The current Codex session index is not ready yet.',
    retryAfterMs: Number(nextStatusPoll.retryAfterMs || ASYNC_INDEX_POLL_RETRY_MS),
    status
  }
}

const operationWithMarker = ({ lifecycle, name, args, operation }) => {
  const sessionMarker = stringArg(args.session_marker) ||
    operation && operation.sessionMarker ||
    lifecycle.ensureCurrentSessionMarker()
  const markerSinceMs = Number(args.session_marker_since_ms) ||
    operation && operation.markerSinceMs ||
    Date.now()
  lifecycle.ensureCurrentSessionMarker(sessionMarker)
  args.session_marker = sessionMarker
  args.session_marker_since_ms = markerSinceMs
  if (operation) {
    operation.sessionMarker = sessionMarker
    operation.markerSinceMs = markerSinceMs
    operation.args = cloneJson(args)
    return operation
  }
  const created = lifecycle.createAsyncOperation({
    name,
    args,
    sessionMarker
  })
  created.markerSinceMs = markerSinceMs
  return created
}

const pendingForOperation = async ({
  lifecycle,
  name,
  args,
  operation,
  current,
  reason,
  message,
  retryAfterMs,
  status
}) => {
  const pending = operationWithMarker({ lifecycle, name, args, operation })
  const indexing = lifecycle.indexingStart(pending.sessionMarker)
  return toolResult(pendingOperationPayload({
    operation: pending,
    reason,
    message,
    retryAfterMs,
    current,
    indexing: status
      ? {
          status,
          start: indexing
        }
      : indexing
  }), current)
}

const blockedForOperation = ({ lifecycle, operation, name, args, current, reason, message }) => {
  const blocked = operation || lifecycle.createAsyncOperation({
    name,
    args,
    sessionMarker: stringArg(args.session_marker) || current && current.sessionMarker || lifecycle.currentSessionMarker()
  })
  lifecycle.deleteAsyncOperation(blocked.id)
  return toolResult(terminalAsyncPayload({
    operation: blocked,
    status: 'blocked',
    reason,
    message,
    current
  }), current)
}

const runConversationOperationNow = async ({ name, args, scope }) => {
  if (name === 'conversation_search') {
    if (!stringArg(args.query) && !stringArg(args.agent) && !args.filter) throw new Error('conversation_search requires query, agent, or filter')
    const argv = ['search']
    pushFlag(argv, '--query', args.query)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--within', internalHandleForScope(args.within, scope))
    if (args.filter) pushFlag(argv, '--filter', JSON.stringify(args.filter))
    addCommonSearchArgs(argv, args)
    return toolResult(withCurrentScope(await callConversationHistory(argv), scope), scope.current)
  }

  if (name === 'conversation_browse') {
    const argv = ['browse']
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--handle', internalHandleForScope(args.handle, scope))
    pushFlag(argv, '--zoom', args.zoom)
    pushFlag(argv, '--start', args.start)
    pushFlag(argv, '--limit', args.limit)
    try {
      return toolResult(withCurrentScope(await callConversationHistory(argv), scope), scope.current)
    } catch (err) {
      if (scope.scoped && scope.current && scope.current.ok && currentSessionMissingFrom(err)) {
        return toolResult(currentSessionNotIndexedBrowse(scope.current, args), scope.current)
      }
      throw err
    }
  }

  if (name === 'conversation_openLink') {
    const link = args.handle ? internalHandleForScope(args.handle, scope) : args.link
    if (!link) throw new Error('conversation_openLink requires handle')
    const argv = ['openLink']
    pushFlag(argv, '--link', link)
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--budget-tokens', args.budget_tokens)
    return toolResult(await callConversationHistory(argv), scope.current)
  }

  if (name === 'conversation_index_status') {
    const argv = ['index_status']
    pushFlag(argv, '--start-at', args.start_at)
    pushFlag(argv, '--limit', args.limit)
    pushFlag(argv, '--session-id', args.session_id)
    const status = withCurrentStatusScope(withStatusPollHints(await callConversationHistory(argv)), scope)
    return toolResult(status, scope.current)
  }

  if (name === 'stop_indexing_session') {
    args.source = defaultSource()
    const current = scope.current
    if (current.path) args.session = current.path
    const argv = ['stop_indexing_session']
    pushFlag(argv, '--scope', 'this_session_only')
    addSourceArgs(argv, args)
    const result = await callConversationHistory(argv)
    return toolResult(result)
  }

  if (name === 'reset_session_index') {
    args.source = defaultSource()
    const argv = ['reset_session_index']
    pushFlag(argv, '--scope', 'this_session_only')
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--agent', args.agent)
    const result = await callConversationHistory(argv)
    return toolResult(result, scope.current)
  }

  throw new Error(`unknown conversation_history operation: ${name}`)
}

const runConversationOperation = async ({ name, args, lifecycle, operation = null }) => {
  lifecycle.rememberIndexRoot()
  const workingArgs = cloneJson(args)
  if (operation && operation.sessionMarker) workingArgs.session_marker = operation.sessionMarker
  const scope = await defaultToCurrentSessionScope(workingArgs, lifecycle)
  if (scope.scoped && scope.current && scope.current.ok) {
    lifecycle.rememberResolvedSession(scope.current.sessionMarker, scope.current)
  }
  if (scope.scoped && !scope.current.ok) {
    if (currentResolutionIsRetryable(scope.current)) {
      return pendingForOperation({
        lifecycle,
        name,
        args: workingArgs,
        operation,
        current: scope.current,
        reason: 'current_session_pending',
        retryAfterMs: ASYNC_POLL_RETRY_MS
      })
    }
    return blockedForOperation({
      lifecycle,
      operation,
      name,
      args: workingArgs,
      current: scope.current,
      reason: scope.current.reason,
      message: scope.current.message || scope.current.error || 'Current-session binding is blocked.'
    })
  }

  const readiness = await readinessForOperation({ name, scope })
  if (!readiness.ready) {
    if (readiness.terminal) {
      return blockedForOperation({
        lifecycle,
        operation,
        name,
        args: workingArgs,
        current: scope.current,
        reason: readiness.reason,
        message: readiness.message
      })
    }
    return pendingForOperation({
      lifecycle,
      name,
      args: workingArgs,
      operation,
      current: scope.current,
      reason: readiness.reason,
      message: readiness.message,
      retryAfterMs: readiness.retryAfterMs,
      status: readiness.status
    })
  }
  const result = await runConversationOperationNow({ name, args: workingArgs, scope })
  if (operation) lifecycle.deleteAsyncOperation(operation.id)
  return result
}

const registerTools = (server, lifecycle = createPluginLifecycle()) => {
  server.registerTool('conversation_search', {
    title: 'Search Indexed Conversation',
    description: 'Search the existing current Codex session conversation_history index without starting indexing. If session binding is pending, returns an operation for conversation_history_poll; if no index exists, call start_indexing_session explicitly.',
    inputSchema: {
      query: z.string().optional().describe('Search query over original user/assistant messages and generated summaries.'),
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      within: z.string().optional().describe('Optional exact parent handle returned by search; search only one level within that node.'),
      filter: searchFilterShape.describe('Structured exact filters such as {agent:"codex"}, {messageId}, {inReplyToMessageId}, {toolCallId}, {role:"assistant"}, {mip:0}, or {mipLevel:"leaf"}. Avoid exact filters for broad semantic search.'),
      ...commonSearchShape
    }
  }, async args => {
    return runConversationOperation({ name: 'conversation_search', args, lifecycle })
  })

  server.registerTool('conversation_browse', {
    title: 'Browse Indexed Conversation',
    description: 'Browse the existing current Codex session conversation_history hierarchy without starting indexing. If session binding is pending, returns an operation for conversation_history_poll; if no index exists, call start_indexing_session explicitly. Use handles returned by previous browse/search calls to navigate.',
    inputSchema: {
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      handle: z.string().optional().describe('Short handle returned by conversation_search or conversation_browse. Omit for the root.'),
      zoom: z.enum(['children', 'in', 'out', 'siblings']).optional().describe('Navigation mode. Defaults to children.'),
      start: z.number().int().min(0).optional().describe('Zero-based child offset for paging.'),
      limit: z.number().int().positive().max(100).optional().describe('Maximum child count.')
    }
  }, async args => {
    return runConversationOperation({ name: 'conversation_browse', args, lifecycle })
  })

  server.registerTool('conversation_openLink', {
    title: 'Open Conversation Link',
    description: 'Open a conversation_history handle returned by search or browse. Returns a bounded source render; exact text is indicated by isVerbatim. Increase budget_tokens when omittedTokenCount is nonzero.',
    inputSchema: {
      handle: z.string().optional().describe('Short handle returned by search or browse. Preferred.'),
      link: z.string().optional().describe('Legacy conversation_history open link. Prefer handle.'),
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      budget_tokens: z.number().int().positive().max(200000).optional().describe('Render budget in tokens. Defaults to 1200.')
    }
  }, async args => {
    return runConversationOperation({ name: 'conversation_openLink', args, lifecycle })
  })

  server.registerTool('conversation_index_status', {
    title: 'Conversation Index Status',
    description: 'Read compact current Codex session conversation_history index status without importing or summarizing.',
    inputSchema: {
      start_at: z.number().int().min(0).describe('Zero-based session-status page offset. Required.'),
      limit: z.number().int().positive().max(100).describe('Maximum session-status records to return. Required.')
    }
  }, async args => {
    return runConversationOperation({ name: 'conversation_index_status', args, lifecycle })
  })

  server.registerTool('conversation_history_poll', {
    title: 'Poll Conversation History Operation',
    description: 'Poll a pending conversation_history operation returned by another conversation_history tool.',
    inputSchema: {
      operation_id: z.string().describe('Operation id returned by a pending conversation_history tool result.')
    }
  }, async args => {
    const operation = lifecycle.asyncOperation(args.operation_id)
    if (!operation) {
      return toolResult({
        schema: 'conversation_history.async_operation.v1',
        status: 'not_found',
        reason: 'unknown_operation',
        operationId: args.operation_id,
        message: 'No pending conversation_history operation exists for this operation_id.'
      })
    }
    return runConversationOperation({
      name: operation.name,
      args: operation.args,
      lifecycle,
      operation
    })
  })

  server.registerTool('start_indexing_session', {
    title: 'Start Session Indexing',
    description: 'Start or reuse current-session background conversation_history indexing.',
    inputSchema: {}
  }, async args => {
    lifecycle.rememberIndexRoot()
    args.source = defaultSource()
    const marker = lifecycle.currentSessionMarker() || makeSessionMarker()
    lifecycle.setCurrentSessionMarker(marker)
    args.session_marker = marker
    const resolved = lifecycle.resolvedSession(marker)
    if (resolved && resolved.path) {
      args.session = resolved.path
      args.wait_for_session_marker = false
    } else {
      args.session_marker_since_ms = Date.now()
      args.wait_for_session_marker = true
    }
    const argv = currentSessionIndexArgv(args)
    const result = await callConversationHistory(argv)
    result.sessionMarker = marker
    result.generatedSessionMarker = !resolved
    lifecycle.rememberIndexingStart(marker, result)
    return toolResult(result)
  })

  server.registerTool('stop_indexing_session', {
    title: 'Stop Session Indexing',
    description: 'Stop current-session conversation_history background indexing.',
    inputSchema: {}
  }, async args => {
    return runConversationOperation({ name: 'stop_indexing_session', args, lifecycle })
  })

  server.registerTool('reset_session_index', {
    title: 'Reset Session Index',
    description: 'Remove persisted conversation_history artifacts for the current session. This is destructive and only acts on the current session.',
    inputSchema: {
      agent: z.string().optional().describe('Optional indexed agent filter, e.g. codex or claude.')
    }
  }, async args => {
    return runConversationOperation({ name: 'reset_session_index', args, lifecycle })
  })

  server.registerTool('redeploy_session_index_mcp', {
    title: 'Redeploy conversation_history MCP',
    description: 'Redeploy conversation_history for the plugin host it is installed in. The plugin target is determined by the running install context, not chosen by the caller. This does not restart the already-running MCP process; reload the plugin host afterward.',
    inputSchema: {}
  }, async args => {
    const argv = ['redeploy_session_index_mcp']
    pushFlag(argv, '--mode', 'copy')
    return toolResult(await callConversationHistory(argv))
  })
}

const registerPrompts = server => {
  server.registerPrompt('conversation_history_system', {
    title: 'conversation_history guidance',
    description: 'Guidance for using conversation_history search, browse, openLink, and indexing tools.'
  }, async () => ({
    description: 'Guidance for conversation_history MCP use.',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: CONVERSATION_HISTORY_SYSTEM_PROMPT
      }
    }]
  }))
}

const createMcpServer = ({ lifecycle = createPluginLifecycle() } = {}) => {
  const server = new McpServer({
    name: 'conversation_history',
    version: '0.1.0'
  })
  registerTools(server, lifecycle)
  registerPrompts(server)
  return server
}

const startStdioServer = async () => {
  const logger = createMcpLogger('conversation_history')
  installMcpProcessLogging(logger)
  logger.info('start', {
    cwd: process.cwd(),
    node: process.version,
    execPath: process.execPath,
    log: logger.file
  })
  const lifecycle = createPluginLifecycle()
  installShutdownHandlers(lifecycle)
  const server = createMcpServer({ lifecycle })
  try {
    await server.connect(new StdioServerTransport())
    logger.info('connected')
  } catch (err) {
    logger.error('startup_error', err)
    throw err
  }
}

module.exports = {
  createMcpServer,
  registerPrompts,
  registerTools,
  SESSION_INDEXER_SYSTEM_PROMPT: CONVERSATION_HISTORY_SYSTEM_PROMPT,
  CONVERSATION_HISTORY_SYSTEM_PROMPT,
  createPluginLifecycle,
  startStdioServer,
  __testing: {
    currentSessionIndexArgv,
    defaultToCurrentSessionScope,
    makeSessionMarker,
    resolveCurrentMarkerSession
  }
}
