const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { z } = require('zod')

const REPO_ROOT = path.resolve(__dirname, '..')
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'session-indexer.js')
const MAX_CLI_OUTPUT_BYTES = 50 * 1024 * 1024
const SESSION_MARKER_PREFIX = 'conversation_history-session-'
const LEGACY_SESSION_MARKER_PREFIX = 'session-indexer-session-'
const SHUTDOWN_TIMEOUT_MS = 10000
const SESSION_MARKER_SCAN_LIMIT = 100
const SESSION_MARKER_SCAN_BYTES = 8 * 1024 * 1024
const SESSION_MARKER_PATTERN = /(?:conversation_history-session-|session-indexer-session-)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

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

const walkJsonlFiles = root => {
  const files = []
  const visit = dir => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_err) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && full.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(full)
          files.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size })
        } catch (_err) {
          // Ignore files that disappear while the session log tree is changing.
        }
      }
    }
  }
  visit(root)
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size || a.file.localeCompare(b.file))
}

const lastSessionMarkerInFile = file => {
  let fd
  try {
    fd = fs.openSync(file.file, 'r')
    const start = Math.max(0, file.size - SESSION_MARKER_SCAN_BYTES)
    const length = Math.max(0, file.size - start)
    if (!length) return ''
    const buffer = Buffer.allocUnsafe(length)
    fs.readSync(fd, buffer, 0, length, start)
    const text = buffer.toString('utf8')
    let last = ''
    for (const match of text.matchAll(SESSION_MARKER_PATTERN)) last = match[0]
    return last
  } catch (_err) {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch (_err) {
        // Nothing useful to report from cleanup.
      }
    }
  }
}

const shouldResolveThisChat = (args = {}) => (args.this_chat !== false && !args.session && !args.latest && !isAllScope(args)) || args.this_chat

const discoverExistingSessionMarker = (args = {}) => {
  if (!shouldResolveThisChat(args) || stringArg(args.session_marker)) return null
  const source = args.source || defaultSource()
  const root = args.source_root || defaultSourceRoot(source)
  for (const file of walkJsonlFiles(root).slice(0, SESSION_MARKER_SCAN_LIMIT)) {
    const marker = lastSessionMarkerInFile(file)
    if (marker && (marker.startsWith(SESSION_MARKER_PREFIX) || marker.startsWith(LEGACY_SESSION_MARKER_PREFIX))) return marker
  }
  return null
}

const ensureStartSessionMarker = (args = {}) => {
  if (!shouldResolveThisChat(args) || stringArg(args.session_marker)) return null
  const discovered = discoverExistingSessionMarker(args)
  if (discovered) {
    args.session_marker = discovered
    return {
      sessionMarker: discovered,
      generated: false
    }
  }
  const sessionMarker = makeSessionMarker()
  args.session_marker = sessionMarker
  args.wait_for_session_marker = true
  return {
    sessionMarker,
    generated: true
  }
}

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
    description: 'Search existing conversation_history transcript indexes. This never indexes on demand.',
    inputSchema: {
      query: z.string().optional().describe('Search query. Use this for old transcript facts, tool calls, and tool results.'),
      topic: z.string().optional().describe('Optional natural-language generated topic filter. Do not use the session title as a topic.'),
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      session_id: z.string().optional().describe('Optional indexed session id. Omit to search all indexed sessions.'),
      within: z.string().optional().describe('Optional exact parent handle returned by search; search only one level within that node.'),
      filter: searchFilterShape.describe('Structured exact filters such as {agent:"codex"}, {messageId}, {inReplyToMessageId}, {toolCallId}, {role:"assistant"}, {mip:0}, or {mipLevel:"leaf"}. Avoid exact filters for broad semantic search.'),
      ...commonSearchShape
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    if (!stringArg(args.query) && !stringArg(args.topic) && !stringArg(args.agent) && !args.filter) throw new Error('conversation_search requires query, topic, agent, or filter')
    const argv = ['search']
    pushFlag(argv, '--query', args.query)
    pushFlag(argv, '--topic', args.topic)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--within', args.within)
    if (args.filter) pushFlag(argv, '--filter', JSON.stringify(args.filter))
    addCommonSearchArgs(argv, args)
    return toolResult(await callConversationHistory(argv))
  })

  server.registerTool('conversation_browse', {
    title: 'Browse Indexed Conversation',
    description: 'Browse an existing transcript summary hierarchy. Start with session_id, optionally topic_id:"root", then navigate with topic_id values returned by previous browse results. This never indexes on demand.',
    inputSchema: {
      session_id: z.string().describe('Indexed session id.'),
      agent: z.string().optional().describe('Optional indexed coding-agent filter, e.g. codex or claude. This is not the speaker role.'),
      topic_id: z.string().optional().describe('Opaque topic id returned by a previous conversation_browse response. Use "root" or omit for the root browse.'),
      zoom: z.enum(['children', 'in', 'out', 'siblings']).optional().describe('Navigation mode. Defaults to children, or in when topic_id is supplied.'),
      start: z.number().int().min(0).optional().describe('Zero-based child/topic offset for paging.'),
      limit: z.number().int().positive().max(100).optional().describe('Maximum child/topic count.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    const argv = ['browse']
    pushFlag(argv, '--session-id', args.session_id)
    pushFlag(argv, '--agent', args.agent)
    pushFlag(argv, '--topic-id', args.topic_id)
    pushFlag(argv, '--zoom', args.zoom)
    pushFlag(argv, '--start', args.start)
    pushFlag(argv, '--limit', args.limit)
    return toolResult(await callConversationHistory(argv))
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
    description: 'Read compact conversation_history index statuses without importing or summarizing.',
    inputSchema: {
      start_at: z.number().int().min(0).describe('Zero-based session-status page offset. Required.'),
      limit: z.number().int().positive().max(100).describe('Maximum session-status records to return. Required.'),
      session_id: z.string().optional().describe('Optional indexed session id. If supplied and not indexed, sessions is empty.')
    }
  }, async args => {
    lifecycle.rememberIndexRoot()
    const argv = ['index_status']
    pushFlag(argv, '--start-at', args.start_at)
    pushFlag(argv, '--limit', args.limit)
    pushFlag(argv, '--session-id', args.session_id)
    return toolResult(await callConversationHistory(argv))
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
      const discovered = discoverExistingSessionMarker(args)
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
      const discovered = discoverExistingSessionMarker(args)
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
  startStdioServer
}
