const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { z } = require('zod')
const {
  readFileWindow,
  walkJsonlFiles: walkCodexJsonlFiles
} = require('codex-session-tools')
const { connectOrStartCodexSessionServer } = require('codex-session-tools/src/client.js')
const { CodexAppServerClient } = require('codex-session-tools/src/appServerClient.js')

const REPO_ROOT = path.resolve(__dirname, '..')
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'session-indexer.js')
const MAX_CLI_OUTPUT_BYTES = 50 * 1024 * 1024
const SESSION_MARKER_PREFIX = 'conversation_history-session-'
const LEGACY_SESSION_MARKER_PREFIX = 'session-indexer-session-'
const SHUTDOWN_TIMEOUT_MS = 10000
const SESSION_MARKER_SCAN_LIMIT = 100
const SESSION_MARKER_SCAN_BYTES = 8 * 1024 * 1024
const SESSION_MARKER_PATTERN = /(?:conversation_history-session-|session-indexer-session-)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const STATUS_POLL_INITIAL_MS = 15_000
const STATUS_POLL_MAX_MS = 120_000
const STATUS_POLL_ESTIMATE_BUFFER_MS = 1_000
const CURRENT_THREAD_ID_ENV = 'CODEX_THREAD_ID'

const statusPollMemory = new Map()
const codexSessionClients = new Map()

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

const codexSessionServiceFor = async root => {
  const resolved = path.resolve(root)
  if (!codexSessionClients.has(resolved)) {
    codexSessionClients.set(resolved, connectOrStartCodexSessionServer({
      sessionRoot: resolved
    }))
  }
  return codexSessionClients.get(resolved)
}

const lastSessionMarkerInFile = file => {
  const window = readFileWindow(file.file, SESSION_MARKER_SCAN_BYTES)
  if (!window || !window.text) return null
  let last = null
  for (const match of window.text.matchAll(SESSION_MARKER_PATTERN)) {
    last = {
      marker: match[0],
      file: file.file,
      mtimeMs: file.mtimeMs,
      size: file.size,
      byteOffset: window.start + match.index
    }
  }
  return last
}

const shouldResolveThisChat = (args = {}) => (args.this_chat !== false && !args.session && !args.latest && !isAllScope(args)) || args.this_chat

const discoverExistingSessionMarker = async (args = {}) => {
  if (!shouldResolveThisChat(args) || stringArg(args.session_marker)) return null
  const source = args.source || defaultSource()
  const root = args.source_root || defaultSourceRoot(source)
  if (source === 'codex') {
    const service = args.codex_session_service || await codexSessionServiceFor(root)
    const latest = await service.latestMarker({
      pattern: SESSION_MARKER_PATTERN,
      maxBytes: SESSION_MARKER_SCAN_BYTES,
      limit: SESSION_MARKER_SCAN_LIMIT
    })
    return latest ? latest.marker : null
  }
  const latest = walkCodexJsonlFiles(root)
    .slice(0, SESSION_MARKER_SCAN_LIMIT)
    .map(lastSessionMarkerInFile)
    .filter(Boolean)
    .sort((a, b) =>
      b.mtimeMs - a.mtimeMs ||
      b.byteOffset - a.byteOffset ||
      b.size - a.size ||
      a.file.localeCompare(b.file)
    )[0]
  return latest ? latest.marker : null
}

const ensureStartSessionMarker = (args = {}) => {
  delete args.session_marker
  if (!shouldResolveThisChat(args)) return null
  const sessionMarker = makeSessionMarker()
  args.session_marker = sessionMarker
  args.wait_for_session_marker = true
  return {
    sessionMarker,
    generated: true
  }
}

const compactErrorMessage = err => err && err.message ? String(err.message).slice(0, 240) : String(err || '').slice(0, 240)

const currentThreadIdFrom = (args = {}) => stringArg(args.current_thread_id) ||
  stringArg(process.env.SESSION_INDEXER_CURRENT_THREAD_ID) ||
  stringArg(process.env[CURRENT_THREAD_ID_ENV])

const threadFromAppServerRead = read => read && (
  read.thread ||
  read.result && read.result.thread ||
  read.result && read.result.data && read.result.data.thread ||
  read.result
)

const readCurrentThreadDirect = async threadId => {
  const client = new CodexAppServerClient({
    requestTimeoutMs: Number(process.env.SESSION_INDEXER_APP_SERVER_TIMEOUT_MS || 10000)
  })
  try {
    return await client.threadRead(threadId, { includeTurns: false })
  } finally {
    await client.stop().catch(() => {})
  }
}

const readCurrentThread = async ({ service, threadId }) => {
  let fallbackReason = null
  if (service && typeof service.appServerThreadRead === 'function') {
    try {
      const read = await service.appServerThreadRead({ threadId, includeTurns: false })
      if (!(read && read.ok === false)) return read
      fallbackReason = read.reason || read.status || 'shared_session_service_failed'
    } catch (err) {
      fallbackReason = compactErrorMessage(err) || 'shared_session_service_failed'
    }
  }
  try {
    const read = await readCurrentThreadDirect(threadId)
    return {
      ok: true,
      status: fallbackReason ? 'degraded' : 'resolved',
      warning: fallbackReason ? 'shared_session_service_app_server_failed' : undefined,
      fallbackReason,
      result: read
    }
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'current_thread_lookup_failed',
      fallbackReason,
      error: compactErrorMessage(err)
    }
  }
}

const resolveCurrentThreadSession = async (args = {}) => {
  const source = args.source || defaultSource()
  if (source !== 'codex') {
    return {
      ok: false,
      status: 'blocked',
      reason: 'unsupported_current_thread_source',
      message: 'Current-session MCP scoping is only available for Codex source sessions.'
    }
  }
  const threadId = currentThreadIdFrom(args)
  if (!threadId) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'missing_current_thread_id',
      message: `No ${CURRENT_THREAD_ID_ENV} binding was available, so conversation_history did not fall back to the global session catalog.`
    }
  }
  try {
    const root = args.source_root || defaultSourceRoot(source)
    const service = args.codex_session_service || await codexSessionServiceFor(root)
    const read = await readCurrentThread({ service, threadId })
    if (read && read.ok === false) {
      return {
        ok: false,
        status: read.status || 'blocked',
        reason: read.reason || 'current_thread_lookup_failed',
        threadId,
        error: read.error,
        fallbackReason: read.fallbackReason,
        message: 'Codex app-server could not resolve the current thread, so conversation_history did not fall back to the global session catalog.'
      }
    }
    const thread = threadFromAppServerRead(read)
    const sessionId = thread && (thread.sessionId || thread.session_id || thread.id)
    if (!sessionId) {
      return {
        ok: false,
        status: 'blocked',
        reason: 'current_thread_session_id_missing',
        threadId,
        message: 'Codex app-server resolved the thread without a session id, so conversation_history did not fall back to the global session catalog.'
      }
    }
    return {
      ok: true,
      status: 'resolved',
      source,
      threadId,
      sessionId,
      warning: read && read.warning,
      path: thread.path || thread.rollout_path || thread.rolloutPath || null
    }
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'current_thread_lookup_failed',
      threadId,
      error: compactErrorMessage(err),
      message: 'Codex app-server thread lookup failed, so conversation_history did not fall back to the global session catalog.'
    }
  }
}

const currentScopeForResult = scope => {
  const out = {
    kind: 'current_session',
    status: scope && scope.status || (scope && scope.ok ? 'resolved' : 'blocked')
  }
  if (scope && scope.threadId) out.thread_id = scope.threadId
  if (scope && scope.sessionId) out.session_id = scope.sessionId
  if (scope && scope.source) out.source = scope.source
  if (scope && scope.reason) out.reason = scope.reason
  if (scope && scope.error) out.error = scope.error
  return out
}

const emptyScopedStatus = (scope, args = {}) => ({
  schema: 'session-indexer.index_status.v1',
  status: scope && scope.status || 'blocked',
  reason: scope && scope.reason || 'current_session_scope_unavailable',
  message: scope && scope.message || 'Current session scope was unavailable, so no global sessions were returned.',
  scope: currentScopeForResult(scope),
  startAt: args.start_at || 0,
  limit: args.limit || 10,
  sessions: []
})

const emptyScopedBrowse = (scope, args = {}) => ({
  schema: 'session-indexer.browse.v1',
  status: scope && scope.status || 'blocked',
  reason: scope && scope.reason || 'current_session_scope_unavailable',
  message: scope && scope.message || 'Current session scope was unavailable, so no global sessions were returned.',
  scope: currentScopeForResult(scope),
  level: 'sessions',
  page: {
    start: args.start || args.start_at || 0,
    limit: args.limit || 20,
    returned: 0,
    total: 0
  },
  sessions: []
})

const emptyScopedSearch = (scope, args = {}) => ({
  schema: 'session-indexer.search.v1',
  status: scope && scope.status || 'blocked',
  reason: scope && scope.reason || 'current_session_scope_unavailable',
  message: scope && scope.message || 'Current session scope was unavailable, so no global hits were returned.',
  scope: currentScopeForResult(scope),
  ...(args.query ? { query: args.query } : {}),
  ...(args.topic ? { topic: args.topic } : {}),
  ...(args.agent ? { agent: args.agent } : {}),
  ...(args.start_at ? { startAt: args.start_at } : {}),
  hits: []
})

const defaultToCurrentSessionScope = async args => {
  if (args.all_sessions || stringArg(args.session_id) || stringArg(args.index_id)) return { scoped: false }
  const current = await resolveCurrentThreadSession(args)
  if (!current.ok) return { scoped: true, current }
  args.session_id = current.sessionId
  return { scoped: true, current }
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

const stripImplementationDetails = value => {
  if (Array.isArray(value)) return value.map(stripImplementationDetails)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (lower.includes('typesense')) continue
    if (key === 'searchBackend' || key === 'serverIndex' || key === 'managed') continue
    if (key === 'maxSummaryNodes' || key === 'max_summary_nodes') continue
    if (key === 'removedFiles' || key === 'removedJobArtifacts') continue
    if (key === 'compactions' || key === 'compactionLog') continue
    out[key] = stripImplementationDetails(item)
  }
  return out
}

const toolResult = result => {
  const clean = stripImplementationDetails(result)
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(clean, null, 2)
    }],
    structuredContent: {
      result: clean
    }
  }
}

const CONVERSATION_HISTORY_SYSTEM_PROMPT = `
Active context can compact. conversation_history keeps the conversation outside the context window as a hierarchy.

Search finds candidate regions. Browse moves through the hierarchy by topic and zoom. OpenLink spends a bounded token budget on source text.

Higher zoom levels are compact navigation. The lowest zoom level is lossless. Trust opened source when isVerbatim is true.

Keep recovery incremental: search or browse first, open the smallest relevant link, and increase budget_tokens on the same link when omittedTokenCount is nonzero. Do not fill gaps from memory when the transcript can be recovered.
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
        ? `Do not poll for completion until the required action is handled. ${suspension.requiredAction}`
        : 'Do not poll for completion until the suspension is resolved.'
    }
  }
  if (session.state !== 'indexing-in-progress' || !session.indexingJob) {
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
    reason: retryAtMs !== null
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
  let cleaned = false
  const rootArgs = root => root ? ['--index-dir', root] : []
  return {
    rememberIndexRoot(root) {
      indexRoots.add(root || '')
    },
    cleanupSync() {
      if (cleaned) return
      cleaned = true
      codexSessionClients.clear()
      for (const root of indexRoots) {
        const args = rootArgs(root)
        runCliSyncQuiet(['stop_indexing_session', '--scope', 'all', '--timeout-ms', '5000', '--poll-ms', '100', ...args])
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

const registerTools = (server, lifecycle = createPluginLifecycle()) => {
  server.registerTool('conversation_search', {
    title: 'Search Indexed Conversation',
    description: 'Search existing conversation_history transcript indexes. Defaults to the current Codex session when no scope is supplied. This never indexes on demand.',
    inputSchema: {
      query: z.string().optional().describe('Search query. Use this for old transcript facts, tool calls, and tool results.'),
      topic: z.string().optional().describe('Optional natural-language generated topic filter. Do not use the session title as a topic.'),
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      session_id: z.string().optional().describe('Optional visibility filter. Omit to search only the current Codex session.'),
      index_id: z.string().optional().describe('Optional definitive indexed-content id. Use to narrow search to one index.'),
      all_sessions: z.boolean().optional().describe('Explicitly search all indexed sessions. Use only when the user asks for cross-session history.'),
      within: z.string().optional().describe('Optional exact parent handle returned by search; search only one level within that node.'),
      filter: searchFilterShape.describe('Structured exact filters such as {agent:"codex"}, {messageId}, {inReplyToMessageId}, {toolCallId}, {role:"assistant"}, {mip:0}, or {mipLevel:"leaf"}. Avoid exact filters for broad semantic search.'),
      ...commonSearchShape
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    if (!stringArg(args.query) && !stringArg(args.topic) && !stringArg(args.agent) && !stringArg(args.session_id) && !stringArg(args.index_id) && !args.filter) throw new Error('conversation_search requires query, topic, agent, index_id, session_id, or filter')
    const scope = await defaultToCurrentSessionScope(args)
    if (scope.scoped && !scope.current.ok) return toolResult(emptyScopedSearch(scope.current, args))
    const argv = ['search']
    pushFlag(argv, '--query', args.query)
    pushFlag(argv, '--topic', args.topic)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--index-id', args.index_id)
    pushFlag(argv, '--within', args.within)
    if (args.filter) pushFlag(argv, '--filter', JSON.stringify(args.filter))
    addCommonSearchArgs(argv, args)
    return toolResult(withCurrentScope(await callConversationHistory(argv), scope))
  })

  server.registerTool('conversation_browse', {
    title: 'Browse Indexed Conversation',
    description: 'Browse existing conversation indexes without indexing on demand. Defaults to the current Codex session when no scope is supplied. Use index_id, optionally topic_id:"root", to drill into one transcript hierarchy. session_id is only a visibility filter.',
    inputSchema: {
      query: z.string().optional().describe('Optional title/session catalog filter used only when all_sessions is true and index_id is omitted.'),
      index_id: z.string().optional().describe('Definitive indexed-content id returned by search, catalog browse, or index status. Omit to browse the current Codex session.'),
      session_id: z.string().optional().describe('Optional visibility filter.'),
      all_sessions: z.boolean().optional().describe('Explicitly browse the compact catalog of all indexed sessions. Use only when the user asks for cross-session history.'),
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      topic_id: z.string().optional().describe('Opaque topic id returned by a previous conversation_browse response. Use "root" or omit for the root browse.'),
      zoom: z.enum(['children', 'in', 'out', 'siblings']).optional().describe('Navigation mode. Defaults to children, or in when topic_id is supplied.'),
      start: z.number().int().min(0).optional().describe('Zero-based child/topic offset for paging.'),
      limit: z.number().int().positive().max(100).optional().describe('Maximum child/topic count.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    const scope = await defaultToCurrentSessionScope(args)
    if (scope.scoped && !scope.current.ok) return toolResult(emptyScopedBrowse(scope.current, args))
    const argv = ['browse']
    pushFlag(argv, '--query', args.query)
    pushFlag(argv, '--index-id', args.index_id)
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--topic-id', args.topic_id)
    pushFlag(argv, '--zoom', args.zoom)
    pushFlag(argv, '--start', args.start)
    pushFlag(argv, '--limit', args.limit)
    try {
      return toolResult(withCurrentScope(await callConversationHistory(argv), scope))
    } catch (err) {
      if (scope.scoped && scope.current && scope.current.ok && currentSessionMissingFrom(err)) {
        return toolResult(emptyScopedBrowse({
          ...scope.current,
          status: 'not_indexed',
          reason: 'current_session_not_indexed',
          message: 'The current Codex session is not indexed yet.'
        }, args))
      }
      throw err
    }
  })

  server.registerTool('conversation_openLink', {
    title: 'Open Conversation Link',
    description: 'Open a conversation_history link returned by search or browse. Returns a bounded source render; exact text is indicated by isVerbatim. Increase budget_tokens when omittedTokenCount is nonzero.',
    inputSchema: {
      link: z.string().describe('tool:conversation_history://open?... link returned by search or browse.'),
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      budget_tokens: z.number().int().positive().max(200000).optional().describe('Render budget in tokens. Defaults to 1200.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    const argv = ['openLink']
    pushFlag(argv, '--link', args.link)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--budget-tokens', args.budget_tokens)
    return toolResult(await callConversationHistory(argv))
  })

  server.registerTool('conversation_index_status', {
    title: 'Conversation Index Status',
    description: 'Read compact conversation_history index status without importing or summarizing. Defaults to the current Codex session when no scope is supplied.',
    inputSchema: {
      start_at: z.number().int().min(0).describe('Zero-based session-status page offset. Required.'),
      limit: z.number().int().positive().max(100).describe('Maximum session-status records to return. Required.'),
      session_id: z.string().optional().describe('Optional indexed session id. If supplied and not indexed, sessions is empty.'),
      all_sessions: z.boolean().optional().describe('Explicitly return a paged status catalog of all indexed sessions. Use only when the user asks for cross-session status.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    const scope = await defaultToCurrentSessionScope(args)
    if (scope.scoped && !scope.current.ok) return toolResult(emptyScopedStatus(scope.current, args))
    const argv = ['index_status']
    pushFlag(argv, '--start-at', args.start_at)
    pushFlag(argv, '--limit', args.limit)
    pushFlag(argv, '--session-id', args.session_id)
    return toolResult(withCurrentStatusScope(withStatusPollHints(await callConversationHistory(argv)), scope))
  })

  server.registerTool('start_indexing_session', {
    title: 'Start Session Indexing',
    description: 'Explicitly start or reuse background conversation_history indexing. Use only when the user asks to index, refresh, or watch; not for one-off search answers.',
    inputSchema: {
      all: z.boolean().optional().describe('Index all source sessions instead of only this conversation.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    args.source = defaultSource()
    if (args.all) args.scope = 'all'
    const markerControl = ensureStartSessionMarker(args)
    const argv = ['start_indexing_session']
    pushFlag(argv, '--scope', args.scope || 'this_session_only')
    pushBool(argv, '--all', args.all)
    pushBool(argv, '--wait-for-session-marker', args.wait_for_session_marker)
    const sessionMarker = addSourceArgs(argv, args)
    const result = await callConversationHistory(argv)
    if (sessionMarker) result.sessionMarker = sessionMarker
    if (markerControl && markerControl.generated) result.generatedSessionMarker = true
    return toolResult(result)
  })

  server.registerTool('stop_indexing_session', {
    title: 'Stop Session Indexing',
    description: 'Stop conversation_history background indexing. Use only when the user asks to stop indexing or to undo an explicit indexing start.',
    inputSchema: {
      all: z.boolean().optional().describe('Stop indexing for all sessions instead of only this conversation.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    args.source = defaultSource()
    if (args.all) args.scope = 'all'
    if (!args.all) {
      const discovered = await discoverExistingSessionMarker(args)
      if (!discovered) {
        return toolResult({
          schema: 'session-indexer.stop_indexing_session.v1',
          status: 'not_found',
          message: 'No current conversation indexing marker was found.'
        })
      }
      args.session_marker = discovered
    }
    const argv = ['stop_indexing_session']
    pushFlag(argv, '--scope', args.scope || 'this_session_only')
    pushBool(argv, '--all', args.all)
    const sessionMarker = addSourceArgs(argv, args)
    const result = await callConversationHistory(argv)
    if (sessionMarker) result.sessionMarker = sessionMarker
    return toolResult(result)
  })

  server.registerTool('reset_session_index', {
    title: 'Reset Session Index',
    description: 'Explicitly remove persisted conversation_history artifacts. Use for testing/rebuild workflows only.',
    inputSchema: {
      all: z.boolean().optional().describe('Reset all indexed sessions.'),
      session_id: z.string().optional().describe('Indexed session id to reset directly. If omitted, this resolves the source session.'),
      agent: z.string().optional().describe('Optional indexed agent filter, e.g. codex or claude.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    args.source = defaultSource()
    if (args.all) args.scope = 'all'
    if (!args.session_id && !args.all) {
      const discovered = await discoverExistingSessionMarker(args)
      if (!discovered) {
        return toolResult({
          schema: 'session-indexer.reset_session_index.v1',
          status: 'not_found',
          message: 'No current conversation indexing marker was found.'
        })
      }
      args.session_marker = discovered
    }
    const argv = ['reset_session_index']
    pushFlag(argv, '--scope', args.scope || 'this_session_only')
    pushBool(argv, '--all', args.all)
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--agent', args.agent)
    const sessionMarker = !args.session_id ? addSourceArgs(argv, args) : null
    const result = await callConversationHistory(argv)
    if (sessionMarker) result.sessionMarker = sessionMarker
    return toolResult(result)
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
  const lifecycle = createPluginLifecycle()
  installShutdownHandlers(lifecycle)
  const server = createMcpServer({ lifecycle })
  await server.connect(new StdioServerTransport())
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
    discoverExistingSessionMarker,
    ensureStartSessionMarker,
    resolveCurrentThreadSession
  }
}
