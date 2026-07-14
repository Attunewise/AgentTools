const fs = require('fs')
const path = require('path')
const chokidar = require('chokidar')
const { adapterFor } = require('./adapters/index.js')
const { loadCodexSessionTools } = require('./codexSessionTools.js')
const { deploySkill } = require('./deploy.js')
const {
  DEFAULT_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  makeIndexingJobId,
  readJobState,
  startIndexingJob,
  stopIndexingJobs,
  writeJobState
} = require('./indexing.js')
const { buildMipTree } = require('./mip.js')
const { defaultPiAgentDir, writePiSession } = require('./pi.js')
const {
  DEFAULT_PRICING_CACHE_DIR,
  compactSummaryBudget,
  estimateCost,
  listModels,
  loadModelsDevCatalog,
  resolvePricing
} = require('./pricing.js')
const {
  DEFAULT_INDEX_DIR,
  DEFAULT_SEARCH_BACKEND,
  DEFAULT_SUMMARY_MODE,
  browseIndexWithBackend,
  browseSessionCatalog,
  completedSummaryJobs,
  indexStatus,
  readManifest,
  openLinkWithBackend,
  resetSessionIndexWithBackend,
  searchIndexWithBackend,
  writeSessionIndexWithBackend
} = require('./store.js')
const {
  DEFAULT_TYPESENSE_API_KEY,
  DEFAULT_TYPESENSE_COLLECTION,
  health: typesenseHealth
} = require('./typesense.js')
const {
  DEFAULT_MANAGED_TYPESENSE_VERSION,
  installManagedTypesense,
  managedTypesenseStatus,
  startManagedTypesense,
  stopManagedTypesense
} = require('./typesenseManaged.js')
const {
  DEFAULT_SUMMARY_MAX_BUDGET_USD,
  DEFAULT_SUMMARY_REASONING_EFFORT,
  DEFAULT_SUMMARY_PROVIDER,
  summaryProvider
} = require('./summarizer.js')
const { runRetrievalEvaluation } = require('./retrievalEval.js')
const {
  expandHome,
  newestFile
} = require('./util.js')

const {
  primeMarkerLookupCache,
  walkJsonlFiles: walkCodexJsonlFiles
} = loadCodexSessionTools()

const DEFAULT_SESSION_MARKER_WAIT_TIMEOUT_MS = 30 * 60 * 1000

const usage = () => `
Usage:
  session-indexer inspect --source codex|claude [--this-chat --session-marker id|--latest|--session path]
  session-indexer index --source codex|claude [--this-chat --session-marker id|--latest|--all|--session path]
  session-indexer search [--query text] [--topic text] [--filter json] [--session-id id] [--index-id id] [--within handle] [--start-at 0] [--limit 10]
  session-indexer browse [--query text] [--agent name] [--start 0|--start-at 0] [--limit 20]
  session-indexer browse --index-id id [--session-id filter] [--topic-id id] [--zoom children|in|out|siblings] [--start 0] [--limit 20]
  session-indexer openLink --link tool:conversation_history://open?indexId=...&handle=...
  session-indexer index_status --start-at n --limit n [--session-id id]
  session-indexer start_indexing_session [--scope this_session_only|all] [--this-chat --session-marker id|--latest|--session path] [--timeout-ms 30000]
  session-indexer stop_indexing_session [--scope this_session_only|all] [--this-chat --session-marker id|--latest|--session path] [--timeout-ms 30000]
  session-indexer reset_session_index [--scope this_session_only|all] [--session-id id|--this-chat --session-marker id|--latest|--session path]
  session-indexer redeploy_session_index_mcp [--target codex-plugin|claude-plugin] [--mode symlink|copy] [--dest dir] [--marketplace-path file] [--no-marketplace] [--force]
  session-indexer typesense_install [--typesense-version ${DEFAULT_MANAGED_TYPESENSE_VERSION}]
  session-indexer typesense_start [--typesense-version ${DEFAULT_MANAGED_TYPESENSE_VERSION}]
  session-indexer typesense_stop [--typesense-version ${DEFAULT_MANAGED_TYPESENSE_VERSION}]
  session-indexer typesense_status [--typesense-version ${DEFAULT_MANAGED_TYPESENSE_VERSION}]
  session-indexer search_server_status
  session-indexer list_models [--filter text] [--provider id] [--limit 25] [--refresh]
  session-indexer get_pricing --model-id provider/model-id [--refresh]
  session-indexer get_cost --model-id provider/model-id (--usage json|--usage-file file|--session-id id) [--refresh]
  session-indexer eval_retrieval --question text --expected-answer text [--session-id id]
  session-indexer import_codex_session_to_pi [--session path|--latest|--all] [--pi-agent-dir dir|--output file] [--force]
  session-indexer deploy [--target codex|pi|codex-plugin|claude-plugin] [--mode symlink|copy] [--dest dir] [--marketplace-path file] [--no-marketplace] [--force]
  session-indexer watch --source codex|claude [--latest|--all]

Options:
  --index-dir dir        Defaults to shared user state: ${DEFAULT_INDEX_DIR}
  --source name          codex or claude. Defaults to codex
  --source-root dir      Source session root. Codex: ~/.codex/sessions. Claude: ~/.claude/projects
  --session-index file   Codex thread-name index. Defaults to ~/.codex/session_index.jsonl
  --this-chat            Resolve the current session by finding --session-marker in exactly one source session file.
  --session-marker id    Required for --this-chat. Use a marker like conversation_history-session-{guid}.
  --search-backend name  typesense. Defaults to ${DEFAULT_SEARCH_BACKEND}
  --typesense-api-key k  Defaults to env TYPESENSE_API_KEY or ${DEFAULT_TYPESENSE_API_KEY}
  --typesense-collection Defaults to ${DEFAULT_TYPESENSE_COLLECTION}
  --typesense-version v  Managed Typesense version. Defaults to ${DEFAULT_MANAGED_TYPESENSE_VERSION}
  --typesense-import-chunk-size n Docs per Typesense import upsert batch. Defaults to 500.
  --typesense-force      Reinstall or restart managed Typesense.
  --no-typesense-install Do not auto-install managed Typesense when starting it.
  --summary-mode name    model, off, or none. Defaults to ${DEFAULT_SUMMARY_MODE}
  --summary-provider p   Defaults to ${DEFAULT_SUMMARY_PROVIDER}
  --summary-model m      Defaults to provider-specific auto selection.
  --summary-reasoning-effort e Defaults to ${DEFAULT_SUMMARY_REASONING_EFFORT} for Codex Responses. Use off to omit.
  --max-summary-nodes n  Defaults to 20 in model mode.
  --max-summary-child-chars n Defaults to 1200.
  --summary-input-token-budget n Defaults to 20000.
  --summary-max-output-tokens n Defaults to 320.
  --summary-max-budget-usd n Defaults to ${DEFAULT_SUMMARY_MAX_BUDGET_USD}. Use off to disable.
  --summary-concurrency n  Concurrent non-batch summary calls. Defaults to 16.
  --summary-rate-limit-max-retries n  429 retry count before failing a target. Defaults to 5.
  --summary-rate-limit-backoff-ms n   Initial 429 backoff. Defaults to 60000.
  --summary-rate-limit-max-backoff-ms n Maximum 429 backoff. Defaults to 300000.
  --summary-batch-id id Existing provider batch id to poll/apply instead of creating a new one.
  --summary-batch-timeout-ms n Wait for batch completion after submit/retrieve. Defaults to 0.
  --summary-batch-poll-ms n Batch poll interval. Defaults to 5000.
  --codex-home dir       Codex auth/models root. Defaults to ~/.codex.
  --summary-region r     Region for Bedrock summary providers.
  --anthropic-aws-workspace-id id  Claude Platform on AWS workspace id. Env ANTHROPIC_AWS_WORKSPACE_ID also works.
  --aws-profile name      AWS profile for Claude Platform on AWS SDK auth.
  --bedrock-cwd dir      Bedrock credential helper cwd.
  --claude-cli-path file  Claude CLI command. Defaults to env CLAUDE_CLI_PATH or claude.
  --claude-cli-max-budget-usd n Optional per-call Claude CLI budget guard.
  --pricing-cache-dir d  Defaults to ${path.join(DEFAULT_INDEX_DIR, 'pricing')}
  --question text       Retrieval evaluation user question.
  --expected-answer text Retrieval evaluation expected exact answer.
  --eval-max-turns n    Retrieval evaluation model/tool loop max turns. Defaults to 8.
  --budget-tokens n      openLink render budget. Defaults to 1200.
  --topic text           Optional generated topic filter for search.
  --topic-id id          Browse topic id returned by a previous browse response.
  --zoom mode            Browse mode: children, in, out, or siblings. Defaults to children, or in when --topic-id is set.
  --agent name           Optional indexed agent filter, e.g. codex or claude.
  --filter json          Exact search filters: agent, sessionId/session_id, indexId/index_id, messageId, inReplyToMessageId, toolCallId, role, mip, mipLevel.
  --index-id id          Definitive indexed content id for browse/open/search narrowing.
  --message-id id        Exact messageId filter.
  --in-reply-to-message-id id Exact inReplyToMessageId filter.
  --tool-call-id id      Exact toolCallId filter.
  --role role            Exact role filter: user, assistant, tool, observer, system, developer.
  --mip n                Exact MIP/depth filter. mip 0 means verbatim leaf records.
  --mip-level name       Exact mipLevel filter, e.g. leaf or summary.
  --start-at n           Zero-based search result offset.
  --include-response-messages
  --debounce-ms n        Watch debounce. Defaults to 1000
  --timeout-ms n         Start/stop wait timeout. Defaults to 30000
  --poll-ms n            Start/stop status poll interval. Defaults to 250
  --scope name           Indexing scope: this_session_only or all.
  --refresh              Refresh cached models.dev pricing data.
  --pi-agent-dir dir     Pi agent dir for import/deploy. Defaults to ${defaultPiAgentDir()}
  --output file          Output path for commands that write one file, such as import_codex_session_to_pi.
  --target name          Deploy target: codex, pi, codex-plugin, or claude-plugin. Defaults to codex.
  --mode name            Deploy mode. Defaults to copy.
  --dest dir             Deploy destination override.
  --marketplace-path f   Plugin marketplace file override.
  --no-marketplace       Build plugin target without updating marketplace.
  --force                Replace an existing deploy destination.
  --json                 Emit JSON only; currently all commands emit JSON.
`.trim()

const parseArgs = argv => {
  const opts = {
    command: (argv[0] === '--help' || argv[0] === '-h') ? 'help' : argv[0] || 'help',
    source: 'codex',
    searchBackend: DEFAULT_SEARCH_BACKEND,
    typesenseApiKey: DEFAULT_TYPESENSE_API_KEY,
    typesenseCollection: DEFAULT_TYPESENSE_COLLECTION,
    typesenseVersion: DEFAULT_MANAGED_TYPESENSE_VERSION,
    typesenseImportChunkSize: 500,
    typesenseForce: false,
    typesenseInstall: true,
    summaryMode: DEFAULT_SUMMARY_MODE,
    summaryProvider: DEFAULT_SUMMARY_PROVIDER,
    summaryProviderSet: false,
    summaryModel: '',
    summaryReasoningEffort: DEFAULT_SUMMARY_REASONING_EFFORT,
    maxSummaryNodes: 20,
    maxSummaryChildChars: 1200,
    summaryInputTokenBudget: 20000,
    summaryMaxOutputTokens: 320,
    summaryMaxBudgetUsd: DEFAULT_SUMMARY_MAX_BUDGET_USD,
    summaryConcurrency: 16,
    summaryRateLimitMaxRetries: 5,
    summaryRateLimitBackoffMs: 60000,
    summaryRateLimitMaxBackoffMs: 300000,
    summaryBatchId: '',
    summaryBatchTimeoutMs: 0,
    summaryBatchPollMs: 5000,
    codexHome: '',
    summaryRegion: '',
    anthropicAwsWorkspaceId: '',
    awsProfile: '',
    bedrockCwd: '',
    claudeCliPath: '',
    claudeCliMaxBudgetUsd: '',
    indexDir: DEFAULT_INDEX_DIR,
    sessions: [],
    latest: false,
    thisChat: false,
    sessionMarker: process.env.SESSION_INDEXER_SESSION_MARKER || '',
    all: false,
    includeResponseMessages: false,
    limit: 10,
    limitSet: false,
    startAt: 0,
    startAtSet: false,
    start: undefined,
    startSet: false,
    debounceMs: 1000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    waitForSessionMarker: false,
    sessionMarkerSinceMs: 0,
    sessionMarkerWaitTimeoutMs: DEFAULT_SESSION_MARKER_WAIT_TIMEOUT_MS,
    scope: 'this_session_only',
    jobId: '',
    query: '',
    topic: '',
    topicId: '',
    zoom: '',
    agent: '',
    filter: '',
    messageId: '',
    inReplyToMessageId: '',
    toolCallId: '',
    role: '',
    mip: undefined,
    mipLevel: '',
    provider: '',
    modelId: '',
    usage: '',
    usageFile: '',
    question: '',
    expectedAnswer: '',
    evalMaxTurns: 8,
    budgetTokens: 1200,
    pricingCacheDir: DEFAULT_PRICING_CACHE_DIR,
    piAgentDir: defaultPiAgentDir(),
    output: '',
    refresh: false,
    target: 'codex',
    mode: 'copy',
    dest: '',
    marketplacePath: '',
    marketplace: true,
    installDependencies: process.env.SESSION_INDEXER_DEPLOY_INSTALL_DEPS !== '0',
    force: false,
    indexId: '',
    sessionId: '',
    handle: '',
    within: '',
    link: ''
  }
  const sessionControlCommands = [
    'start_indexing_session',
    'startIndexingSession',
    'stop_indexing_session',
    'stopIndexingSession',
    'reset_session_index',
    'resetSessionIndex'
  ]
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (sessionControlCommands.includes(opts.command) && ['all', 'this_session_only'].includes(arg)) opts.scope = arg
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--source') opts.source = next()
    else if (arg === '--search-backend') opts.searchBackend = next()
    else if (arg === '--typesense-api-key') opts.typesenseApiKey = next()
    else if (arg === '--typesense-collection') opts.typesenseCollection = next()
    else if (arg === '--typesense-version') opts.typesenseVersion = next()
    else if (arg === '--typesense-import-chunk-size') opts.typesenseImportChunkSize = Number(next())
    else if (arg === '--typesense-force') opts.typesenseForce = true
    else if (arg === '--no-typesense-install') opts.typesenseInstall = false
    else if (arg === '--summary-mode') opts.summaryMode = next()
    else if (arg === '--summary-provider') { opts.summaryProvider = next(); opts.summaryProviderSet = true }
    else if (arg === '--summary-model') opts.summaryModel = next()
    else if (arg === '--summary-reasoning-effort' || arg === '--reasoning-effort' || arg === '--reasoning_effort') opts.summaryReasoningEffort = next()
    else if (arg === '--max-summary-nodes') opts.maxSummaryNodes = Number(next())
    else if (arg === '--max-summary-child-chars') opts.maxSummaryChildChars = Number(next())
    else if (arg === '--summary-input-token-budget') opts.summaryInputTokenBudget = Number(next())
    else if (arg === '--summary-max-output-tokens') opts.summaryMaxOutputTokens = Number(next())
    else if (arg === '--summary-max-budget-usd') opts.summaryMaxBudgetUsd = next()
    else if (arg === '--summary-concurrency') opts.summaryConcurrency = Number(next())
    else if (arg === '--summary-rate-limit-max-retries') opts.summaryRateLimitMaxRetries = Number(next())
    else if (arg === '--summary-rate-limit-backoff-ms') opts.summaryRateLimitBackoffMs = Number(next())
    else if (arg === '--summary-rate-limit-max-backoff-ms') opts.summaryRateLimitMaxBackoffMs = Number(next())
    else if (arg === '--summary-batch-id') opts.summaryBatchId = next()
    else if (arg === '--summary-batch-timeout-ms') opts.summaryBatchTimeoutMs = Number(next())
    else if (arg === '--summary-batch-poll-ms') opts.summaryBatchPollMs = Number(next())
    else if (arg === '--codex-home') opts.codexHome = path.resolve(expandHome(next()))
    else if (arg === '--summary-region') opts.summaryRegion = next()
    else if (arg === '--anthropic-aws-workspace-id') opts.anthropicAwsWorkspaceId = next()
    else if (arg === '--aws-profile') opts.awsProfile = next()
    else if (arg === '--bedrock-cwd') opts.bedrockCwd = path.resolve(expandHome(next()))
    else if (arg === '--claude-cli-path') opts.claudeCliPath = path.resolve(expandHome(next()))
    else if (arg === '--claude-cli-max-budget-usd') opts.claudeCliMaxBudgetUsd = next()
    else if (arg === '--index-dir') opts.indexDir = path.resolve(expandHome(next()))
    else if (arg === '--pricing-cache-dir') opts.pricingCacheDir = path.resolve(expandHome(next()))
    else if (arg === '--pi-agent-dir') opts.piAgentDir = path.resolve(expandHome(next()))
    else if (arg === '--output' || arg === '--out') opts.output = path.resolve(expandHome(next()))
    else if (arg === '--source-root') opts.sourceRoot = path.resolve(expandHome(next()))
    else if (arg === '--session-index') opts.sessionIndex = path.resolve(expandHome(next()))
    else if (arg === '--session') opts.sessions.push(path.resolve(expandHome(next())))
    else if (arg === '--latest') opts.latest = true
    else if (arg === '--this-chat') opts.thisChat = true
    else if (arg === '--session-marker' || arg === '--session_marker') opts.sessionMarker = next()
    else if (arg === '--all') opts.all = true
    else if (arg === '--include-response-messages') opts.includeResponseMessages = true
    else if (arg === '--limit') {
      opts.limit = Number(next())
      opts.limitSet = true
    } else if (arg === '--start-at' || arg === '--startAt') {
      opts.startAt = Number(next())
      opts.startAtSet = true
    } else if (arg === '--start') {
      opts.start = Number(next())
      opts.startSet = true
    }
    else if (arg === '--debounce-ms') opts.debounceMs = Number(next())
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next())
    else if (arg === '--poll-ms') opts.pollMs = Number(next())
    else if (arg === '--wait-for-session-marker') opts.waitForSessionMarker = true
    else if (arg === '--session-marker-since-ms') opts.sessionMarkerSinceMs = Number(next())
    else if (arg === '--session-marker-wait-timeout-ms') opts.sessionMarkerWaitTimeoutMs = Number(next())
    else if (arg === '--scope') opts.scope = next()
    else if (arg === '--job-id') opts.jobId = next()
    else if (arg === '--query') opts.query = next()
    else if (arg === '--agent') opts.agent = next()
    else if (arg === '--filter') opts.filter = next()
    else if (arg === '--message-id' || arg === '--messageId') opts.messageId = next()
    else if (arg === '--in-reply-to-message-id' || arg === '--inReplyToMessageId') opts.inReplyToMessageId = next()
    else if (arg === '--tool-call-id' || arg === '--toolCallId') opts.toolCallId = next()
    else if (arg === '--role') opts.role = next()
    else if (arg === '--mip') opts.mip = Number(next())
    else if (arg === '--mip-level' || arg === '--mipLevel') opts.mipLevel = next()
    else if (arg === '--provider') opts.provider = next()
    else if (arg === '--model-id') opts.modelId = next()
    else if (arg === '--usage') opts.usage = next()
    else if (arg === '--usage-file') opts.usageFile = path.resolve(expandHome(next()))
    else if (arg === '--question') opts.question = next()
    else if (arg === '--expected-answer' || arg === '--expected') opts.expectedAnswer = next()
    else if (arg === '--eval-max-turns') opts.evalMaxTurns = Number(next())
    else if (arg === '--budget-tokens' || arg === '--budget_tokens') opts.budgetTokens = Number(next())
    else if (arg === '--topic') opts.topic = next()
    else if (arg === '--topic-id' || arg === '--topic_id' || arg === '--topicId') opts.topicId = next()
    else if (arg === '--zoom') opts.zoom = next()
    else if (arg === '--index-id' || arg === '--index_id') opts.indexId = next()
    else if (arg === '--session-id') opts.sessionId = next()
    else if (arg === '--handle') opts.handle = next()
    else if (arg === '--within') opts.within = next()
    else if (arg === '--link') opts.link = next()
    else if (arg === '--refresh') opts.refresh = true
    else if (arg === '--target') { opts.target = next(); opts.targetSet = true }
    else if (arg === '--mode') opts.mode = next()
    else if (arg === '--dest') opts.dest = path.resolve(expandHome(next()))
    else if (arg === '--marketplace-path') opts.marketplacePath = path.resolve(expandHome(next()))
    else if (arg === '--no-marketplace') opts.marketplace = false
    else if (arg === '--no-install-dependencies') opts.installDependencies = false
    else if (arg === '--force') opts.force = true
    else if (arg === '--json') opts.json = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error('--limit must be a positive integer')
  if (!Number.isInteger(opts.startAt) || opts.startAt < 0) throw new Error('--start-at must be zero or greater')
  if (opts.start !== undefined && (!Number.isInteger(opts.start) || opts.start < 0)) throw new Error('--start must be zero or greater')
  if (['index_status', 'indexStatus'].includes(opts.command)) {
    if (!opts.startAtSet || !opts.limitSet) throw new Error('index_status requires --start-at and --limit')
    if (opts.limit > 100) throw new Error('index_status --limit must be 100 or less')
  }
  if (!Number.isFinite(opts.debounceMs) || opts.debounceMs < 50) throw new Error('--debounce-ms must be at least 50')
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) throw new Error('--timeout-ms must be zero or greater')
  if (!Number.isFinite(opts.pollMs) || opts.pollMs < 25) throw new Error('--poll-ms must be at least 25')
  if (!Number.isFinite(opts.sessionMarkerSinceMs) || opts.sessionMarkerSinceMs < 0) throw new Error('--session-marker-since-ms must be zero or greater')
  if (!Number.isFinite(opts.sessionMarkerWaitTimeoutMs) || opts.sessionMarkerWaitTimeoutMs <= 0) throw new Error('--session-marker-wait-timeout-ms must be positive')
  if (!Number.isInteger(opts.typesenseImportChunkSize) || opts.typesenseImportChunkSize < 1) throw new Error('--typesense-import-chunk-size must be a positive integer')
  if (!['model', 'off', 'none'].includes(opts.summaryMode)) throw new Error('--summary-mode must be model, off, or none')
  if (!Number.isInteger(opts.maxSummaryNodes) || opts.maxSummaryNodes < 0) throw new Error('--max-summary-nodes must be zero or greater')
  if (!Number.isInteger(opts.maxSummaryChildChars) || opts.maxSummaryChildChars < 200) throw new Error('--max-summary-child-chars must be at least 200')
  if (!Number.isInteger(opts.summaryInputTokenBudget) || opts.summaryInputTokenBudget < 1) throw new Error('--summary-input-token-budget must be a positive integer')
  if (!Number.isInteger(opts.summaryMaxOutputTokens) || opts.summaryMaxOutputTokens < 64) throw new Error('--summary-max-output-tokens must be at least 64')
  if (!Number.isInteger(opts.summaryConcurrency) || opts.summaryConcurrency < 1) throw new Error('--summary-concurrency must be a positive integer')
  if (!Number.isInteger(opts.summaryRateLimitMaxRetries) || opts.summaryRateLimitMaxRetries < 0) throw new Error('--summary-rate-limit-max-retries must be zero or greater')
  if (!Number.isFinite(opts.summaryRateLimitBackoffMs) || opts.summaryRateLimitBackoffMs < 1) throw new Error('--summary-rate-limit-backoff-ms must be positive')
  if (!Number.isFinite(opts.summaryRateLimitMaxBackoffMs) || opts.summaryRateLimitMaxBackoffMs < opts.summaryRateLimitBackoffMs) throw new Error('--summary-rate-limit-max-backoff-ms must be at least --summary-rate-limit-backoff-ms')
  if (!['', 'off', 'none', 'disabled'].includes(String(opts.summaryMaxBudgetUsd || '').toLowerCase())) {
    const summaryBudget = Number(opts.summaryMaxBudgetUsd)
    if (!Number.isFinite(summaryBudget) || summaryBudget < 0) throw new Error('--summary-max-budget-usd must be a non-negative number or off')
  }
  if (!/^[a-z0-9_-]+$/i.test(String(opts.summaryReasoningEffort || ''))) throw new Error('--summary-reasoning-effort must be a simple value such as low, medium, high, off, or none')
  if (!Number.isFinite(opts.summaryBatchTimeoutMs) || opts.summaryBatchTimeoutMs < 0) throw new Error('--summary-batch-timeout-ms must be zero or greater')
  if (!Number.isFinite(opts.summaryBatchPollMs) || opts.summaryBatchPollMs < 250) throw new Error('--summary-batch-poll-ms must be at least 250')
  if (opts.role && !['system', 'developer', 'user', 'assistant', 'tool', 'observer'].includes(opts.role)) throw new Error('--role must be one of system, developer, user, assistant, tool, or observer')
  if (!Number.isFinite(opts.budgetTokens) || opts.budgetTokens < 1) throw new Error('--budget-tokens must be positive')
  if (!['typesense'].includes(opts.searchBackend)) throw new Error('--search-backend must be typesense')
  if (opts.zoom && !['children', 'in', 'out', 'siblings'].includes(String(opts.zoom).toLowerCase())) throw new Error('--zoom must be children, in, out, or siblings')
  if (!['symlink', 'copy'].includes(opts.mode)) throw new Error('--mode must be symlink or copy')
  if (!['codex', 'pi', 'codex-plugin', 'claude-plugin'].includes(opts.target)) throw new Error('--target must be codex, pi, codex-plugin, or claude-plugin')
  if (opts.command === 'import_codex_session_to_pi' || opts.command === 'importCodexSessionToPi') {
    if (opts.source !== 'codex') throw new Error('import_codex_session_to_pi only supports --source codex')
    if (opts.output && opts.all) throw new Error('import_codex_session_to_pi cannot combine --output with --all')
  }
  // Claude Code sessions summarize through `claude -p` by default unless overridden.
  if (!opts.summaryProviderSet && opts.source === 'claude') opts.summaryProvider = 'claude'
  if (!['this_session_only', 'all'].includes(opts.scope)) throw new Error('--scope must be this_session_only or all')
  if (opts.mip !== undefined && (!Number.isInteger(opts.mip) || opts.mip < 0)) throw new Error('--mip must be zero or greater')
  if (opts.command === 'search' && !opts.query && !opts.topic && !opts.agent && !opts.indexId && !opts.sessionId && !opts.filter && !opts.messageId && !opts.inReplyToMessageId && !opts.toolCallId && !opts.role && opts.mip === undefined && !opts.mipLevel) {
    throw new Error('search requires --query, --topic, or a filter')
  }
  if (opts.command === 'openLink' && !opts.link) throw new Error('openLink requires --link')
  if (['get_pricing', 'getPricing', 'get_cost', 'getCost'].includes(opts.command) && !opts.modelId) throw new Error(`${opts.command} requires --model-id`)
  if (['get_cost', 'getCost'].includes(opts.command) && !opts.usage && !opts.usageFile && !opts.sessionId) {
    throw new Error('get_cost requires --usage, --usage-file, or --session-id')
  }
  if (['eval_retrieval', 'evalRetrieval'].includes(opts.command)) {
    if (!opts.question) throw new Error('eval_retrieval requires --question')
    if (!opts.expectedAnswer) throw new Error('eval_retrieval requires --expected-answer')
    if (!Number.isInteger(opts.evalMaxTurns) || opts.evalMaxTurns < 1) throw new Error('--eval-max-turns must be a positive integer')
  }
  return opts
}

const adapterOpts = (adapter, opts) => ({
  sessionIndex: opts.sessionIndex || adapter.defaultSessionIndex,
  includeResponseMessages: opts.includeResponseMessages
})

const selectFiles = (adapter, opts) => {
  if (opts.sessions.length) return opts.sessions
  const root = opts.sourceRoot || adapter.defaultRoot
  const files = adapter.files(root)
  if (!files.length) throw new Error(`no ${adapter.name} session files found under ${root}`)
  if (opts.all) return files
  const sessionControl = [
    'start_indexing_session',
    'startIndexingSession',
    'stop_indexing_session',
    'stopIndexingSession',
    'reset_session_index',
    'resetSessionIndex'
  ].includes(opts.command)
  const shouldResolveThisChat = opts.thisChat || (sessionControl && opts.scope === 'this_session_only' && !opts.latest)
  if (shouldResolveThisChat) {
    if (!adapter.resolveCurrentSessionFile) throw new Error(`${adapter.name} does not support --this-chat`)
    if (!String(opts.sessionMarker || '').trim()) throw new Error('--this-chat requires --session-marker id')
    const resolved = adapter.resolveCurrentSessionFile({
      root,
      command: opts.command,
      sessionMarker: opts.sessionMarker
    })
    if (!resolved || !resolved.file) throw new Error(`could not resolve current ${adapter.name} session under ${root} from session marker`)
    opts.currentSessionResolution = {
      file: resolved.file,
      reason: resolved.reason,
      score: resolved.score,
      signals: resolved.signals
    }
    return [resolved.file]
  }
  const latest = newestFile(files)
  if (!latest) throw new Error(`no readable ${adapter.name} session files found under ${root}`)
  return [latest.file]
}

const importFile = (adapter, file, opts) => adapter.importFile(file, adapterOpts(adapter, opts))

const parseSearchFilter = opts => {
  let filter = {}
  if (opts.filter) {
    try {
      filter = JSON.parse(opts.filter)
    } catch (err) {
      throw new Error(`--filter must be JSON for search filters: ${err.message}`)
    }
  }
  return {
    ...filter,
    ...(opts.indexId ? { indexId: opts.indexId } : {}),
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    ...(opts.inReplyToMessageId ? { inReplyToMessageId: opts.inReplyToMessageId } : {}),
    ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.mip !== undefined ? { mip: opts.mip } : {}),
    ...(opts.mipLevel ? { mipLevel: opts.mipLevel } : {})
  }
}

const inspect = (opts) => {
  const adapter = adapterFor(opts.source)
  const file = selectFiles(adapter, opts)[0]
  const ir = importFile(adapter, file, opts)
  const tree = buildMipTree(ir)
  return {
    schema: 'session-indexer.inspect.v1',
    currentSessionResolution: opts.currentSessionResolution,
    session: ir.session,
    source: ir.source,
    eventCount: ir.events.length,
    root: {
      handle: tree.root.handle,
      title: tree.root.title,
      head: tree.root.head,
      fullTokenCount: tree.root.fullTokenCount,
      usage: tree.root.usage,
      childCount: tree.root.children.length
    }
  }
}

const backendOpts = opts => ({
  searchBackend: opts.searchBackend,
  indexDir: opts.indexDir,
  typesenseApiKey: opts.typesenseApiKey,
  typesenseCollection: opts.typesenseCollection,
  typesenseVersion: opts.typesenseVersion,
  typesenseImportChunkSize: opts.typesenseImportChunkSize
})

const summaryOpts = opts => ({
  summaryMode: opts.summaryMode,
  summaryProvider: opts.summaryProvider,
  summaryModel: opts.summaryModel || undefined,
  summaryReasoningEffort: opts.summaryReasoningEffort || undefined,
  maxSummaryNodes: opts.maxSummaryNodes,
  maxSummaryChildChars: opts.maxSummaryChildChars,
  summaryInputTokenBudget: opts.summaryInputTokenBudget,
  summaryMaxOutputTokens: opts.summaryMaxOutputTokens,
  summaryMaxBudgetUsd: opts.summaryMaxBudgetUsd,
  summaryConcurrency: opts.summaryConcurrency,
  summaryRateLimitMaxRetries: opts.summaryRateLimitMaxRetries,
  summaryRateLimitBackoffMs: opts.summaryRateLimitBackoffMs,
  summaryRateLimitMaxBackoffMs: opts.summaryRateLimitMaxBackoffMs,
  pricingCacheDir: opts.pricingCacheDir,
  summaryBatchId: opts.summaryBatchId || undefined,
  summaryBatchTimeoutMs: opts.summaryBatchTimeoutMs,
  summaryBatchPollMs: opts.summaryBatchPollMs,
  codexHome: opts.codexHome || undefined,
  summaryRegion: opts.summaryRegion || undefined,
  anthropicAwsWorkspaceId: opts.anthropicAwsWorkspaceId || undefined,
  awsProfile: opts.awsProfile || undefined,
  bedrockCwd: opts.bedrockCwd || undefined,
  claudeCliPath: opts.claudeCliPath || undefined,
  claudeCliMaxBudgetUsd: opts.claudeCliMaxBudgetUsd || undefined
})

const index = async (opts) => {
  const adapter = adapterFor(opts.source)
  const files = selectFiles(adapter, opts)
  const sessions = []
  for (const file of files) {
    sessions.push(await writeSessionIndexWithBackend({
      root: opts.indexDir,
      ir: importFile(adapter, file, opts),
      ...summaryOpts(opts),
      ...backendOpts(opts)
    }))
  }
  return {
    schema: 'session-indexer.index.v1',
    indexDir: opts.indexDir,
    currentSessionResolution: opts.currentSessionResolution,
    sessions
  }
}

const search = async opts => {
  const filter = parseSearchFilter(opts)
  const result = await searchIndexWithBackend({
    root: opts.indexDir,
    query: opts.query,
    indexId: opts.indexId || undefined,
    sessionId: opts.sessionId || undefined,
    agent: opts.agent || undefined,
    within: opts.within || undefined,
    topic: opts.topic || undefined,
    filter,
    startAt: opts.startAt,
    limit: opts.limit,
    ...backendOpts(opts)
  })
  const hasFilter = Object.keys(filter).length > 0
  return {
    schema: 'session-indexer.search.v1',
    ...(opts.query ? { query: opts.query } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.indexId ? { index_id: opts.indexId } : {}),
    ...(opts.topic ? { topic: opts.topic } : {}),
    ...(hasFilter ? { filter } : {}),
    ...(opts.startAt ? { startAt: opts.startAt } : {}),
    hits: result.hits
  }
}

const browse = async opts => {
  if (!opts.indexId && !opts.sessionId) {
    return {
      schema: 'session-indexer.browse.v1',
      ...browseSessionCatalog({
        root: opts.indexDir,
        agent: opts.agent || undefined,
        query: opts.query || undefined,
        start: opts.startSet ? opts.start : undefined,
        startAt: opts.startAt,
        limit: opts.limit
      })
    }
  }
  const browsed = await browseIndexWithBackend({
    indexId: opts.indexId || undefined,
    sessionId: opts.sessionId,
    agent: opts.agent || undefined,
    handle: opts.handle || undefined,
    topicId: opts.topicId || undefined,
    zoom: opts.zoom || undefined,
    start: opts.startSet ? opts.start : undefined,
    topic: opts.topic || undefined,
    startAt: opts.startAt,
    limit: opts.limit,
    searchBackend: opts.searchBackend,
    root: opts.indexDir,
    indexDir: opts.indexDir,
    ...backendOpts(opts)
  })
  return {
    schema: 'session-indexer.browse.v1',
    ...browsed.result
  }
}

const idsFromLink = link => {
  const match = String(link || '').match(/^tool:(?:conversation_history|ConversationHistory):\/\/open\?(.+)$/)
  if (!match) return {}
  const params = new URLSearchParams(match[1])
  return {
    indexId: params.get('indexId') || params.get('index_id') || '',
    sessionId: params.get('sessionId') || ''
  }
}

const open = async opts => {
  const linkIds = idsFromLink(opts.link)
  const indexId = opts.indexId || linkIds.indexId
  const sessionId = opts.sessionId || linkIds.sessionId
  if (!indexId && !sessionId) throw new Error('openLink needs an indexId in the link or --index-id')
  const opened = await openLinkWithBackend({
    link: opts.link,
    indexId,
    sessionId,
    agent: opts.agent || undefined,
    budgetTokens: opts.budgetTokens || 1200,
    searchBackend: opts.searchBackend,
    root: opts.indexDir,
    indexDir: opts.indexDir,
    ...backendOpts(opts)
  })
  return {
    schema: 'session-indexer.openLink.v1',
    ...opened.result
  }
}

const loadPricingCatalog = opts => loadModelsDevCatalog({
  cacheDir: opts.pricingCacheDir,
  refresh: opts.refresh
})

const listPricingModels = async opts => {
  const catalog = await loadPricingCatalog(opts)
  return {
    schema: 'session-indexer.list_models.v1',
    source: 'https://models.dev/api.json',
    filter: opts.filter || undefined,
    provider: opts.provider || undefined,
    models: listModels({
      catalog,
      filter: opts.filter,
      provider: opts.provider,
      limit: opts.limit
    })
  }
}

const getPricing = async opts => {
  const catalog = await loadPricingCatalog(opts)
  return {
    schema: 'session-indexer.get_pricing.v1',
    source: 'https://models.dev/api.json',
    pricing: resolvePricing({
      catalog,
      model_id: opts.modelId,
      provider: opts.provider || undefined
    })
  }
}

const readUsageForCost = opts => {
  if (opts.usage) return JSON.parse(opts.usage)
  if (opts.usageFile) return JSON.parse(fs.readFileSync(opts.usageFile, 'utf8'))
  const manifest = readManifest(opts.indexDir)
  const session = manifest.sessions && manifest.sessions[opts.sessionId]
  if (!session || !session.usage) throw new Error(`no indexed usage found for session ${opts.sessionId}`)
  return session.usage
}

const getCost = async opts => {
  const catalog = await loadPricingCatalog(opts)
  const pricing = resolvePricing({
    catalog,
    model_id: opts.modelId,
    provider: opts.provider || undefined
  })
  return {
    schema: 'session-indexer.get_cost.v1',
    source: 'https://models.dev/api.json',
    sessionId: opts.sessionId || undefined,
    ...estimateCost({
      pricing,
      usage: readUsageForCost(opts)
    })
  }
}

const evalRetrieval = async opts => {
  const resolved = summaryProvider({
    ...summaryOpts(opts),
    promptCacheKey: `session-indexer-retrieval-eval:${opts.sessionId || 'all'}`,
    summarySessionId: opts.sessionId
      ? `session-indexer-retrieval-eval-${opts.sessionId}`
      : 'session-indexer-retrieval-eval'
  })
  const result = await runRetrievalEvaluation({
    provider: resolved.provider,
    observerName: resolved.observerName,
    model: resolved.model,
    callOptions: resolved.callOptions,
    question: opts.question,
    expectedAnswer: opts.expectedAnswer,
    context: {
      indexDir: opts.indexDir,
      sessionId: opts.sessionId || undefined,
      agent: opts.agent || undefined,
      ...backendOpts(opts)
    },
    maxTurns: opts.evalMaxTurns
  })
  return {
    ...result,
    provider: {
      name: resolved.providerName,
      model: resolved.model,
      modelSource: resolved.modelSource,
      reasoningEffort: resolved.reasoningEffort
    }
  }
}

const importCodexSessionToPi = async opts => {
  const adapter = adapterFor('codex')
  const files = selectFiles(adapter, {
    ...opts,
    source: 'codex'
  })
  const sessions = []
  for (const file of files) {
    sessions.push(writePiSession({
      ir: importFile(adapter, file, { ...opts, source: 'codex' }),
      outputPath: opts.output || undefined,
      agentDir: opts.piAgentDir,
      force: opts.force
    }))
  }
  return {
    schema: 'session-indexer.import_codex_session_to_pi.v1',
    piAgentDir: opts.piAgentDir,
    importedCount: sessions.length,
    sessions
  }
}

const searchServerStatus = async opts => {
  const managed = await managedTypesenseStatus({
    root: opts.indexDir,
    version: opts.typesenseVersion,
    apiKey: opts.typesenseApiKey
  })
  return {
    schema: 'session-indexer.search_server_status.v1',
    backend: 'typesense',
    status: 'ready',
    config: {
      collection: opts.typesenseCollection,
      apiKey: opts.typesenseApiKey ? 'set' : 'unset'
    },
    managed,
    health: await typesenseHealth(opts)
  }
}

const typesenseInstall = async opts => ({
  schema: 'session-indexer.typesense_install.v1',
  result: await installManagedTypesense({
    root: opts.indexDir,
    version: opts.typesenseVersion,
    force: opts.typesenseForce
  })
})

const typesenseStart = async opts => ({
  schema: 'session-indexer.typesense_start.v1',
  result: await startManagedTypesense({
    root: opts.indexDir,
    version: opts.typesenseVersion,
    apiKey: opts.typesenseApiKey,
    install: opts.typesenseInstall,
    forceRestart: opts.typesenseForce,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs
  })
})

const typesenseStop = async opts => ({
  schema: 'session-indexer.typesense_stop.v1',
  result: await stopManagedTypesense({
    root: opts.indexDir,
    version: opts.typesenseVersion,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs
  })
})

const typesenseStatus = async opts => ({
  schema: 'session-indexer.typesense_status.v1',
  result: await managedTypesenseStatus({
    root: opts.indexDir,
    version: opts.typesenseVersion,
    apiKey: opts.typesenseApiKey
  })
})

const conversationIndexStatus = opts => ({
  schema: 'session-indexer.index_status.v1',
  indexDir: opts.indexDir,
  ...indexStatus({
    root: opts.indexDir,
    sessionId: opts.sessionId || undefined,
    startAt: opts.startAt,
    limit: opts.limit
  })
})

const deploy = opts => ({
  schema: 'session-indexer.deploy.v1',
  result: deploySkill({
    target: opts.target,
    mode: opts.mode,
    dest: opts.dest || undefined,
    marketplace: opts.marketplace,
    marketplacePath: opts.marketplacePath || undefined,
    piAgentDir: opts.piAgentDir,
    installDependencies: opts.installDependencies,
    force: opts.force
  })
})

const redeploySessionIndexMcp = opts => {
  // Redeploy targets the plugin whose MCP server is running. That server injects
  // SESSION_INDEXER_DEPLOY_TARGET into its launch env so the spawned CLI knows its
  // own plugin context; an explicit --target always wins, and direct CLI use with
  // neither set falls back to codex-plugin.
  const target = opts.targetSet ? opts.target : (process.env.SESSION_INDEXER_DEPLOY_TARGET || 'codex-plugin')
  return {
    schema: 'session-indexer.redeploy_session_index_mcp.v1',
    reloadRequired: true,
    note: 'conversation_history was deployed. Restart or reload the plugin/MCP process before expecting new tools in an already-running MCP session.',
    result: deploySkill({
      target,
      mode: opts.mode,
      dest: opts.dest || undefined,
      marketplace: opts.marketplace,
      marketplacePath: opts.marketplacePath || undefined,
      piAgentDir: opts.piAgentDir,
      installDependencies: opts.installDependencies,
      force: true
    })
  }
}

const indexingFiles = (opts) => {
  const adapter = adapterFor(opts.source)
  if (opts.scope === 'all') {
    return selectFiles(adapter, {
      ...opts,
      sessions: [],
      all: true
    })
  }
  return selectFiles(adapter, {
    ...opts,
    all: false
  })
}

const resetSessionIds = (opts) => {
  if (opts.sessionId) return [{
    sessionId: opts.sessionId,
    agent: opts.agent || null,
    sourcePath: null
  }]
  if (opts.scope === 'all' || opts.all) {
    const manifest = readManifest(opts.indexDir)
    const manifestSessions = Object.values(manifest.sessions || {}).map(session => ({
      sessionId: session.sessionId,
      agent: session.agent || null,
      sourcePath: session.sourcePath || null
    }))
    if (manifestSessions.length) return manifestSessions
  }
  const adapter = adapterFor(opts.source)
  return indexingFiles(opts).map(file => {
    const ir = importFile(adapter, file, opts)
    return {
      sessionId: ir.session.id,
      agent: ir.session.agent || null,
      sourcePath: file
    }
  })
}

const resetSessionIndexCommand = async opts => {
  const targets = resetSessionIds(opts)
  const sessions = []
  for (const target of targets) {
    sessions.push({
      ...target,
      ...(await resetSessionIndexWithBackend({
        root: opts.indexDir,
        sessionId: target.sessionId,
        agent: opts.agent || target.agent || undefined,
        ...backendOpts(opts)
      }))
    })
  }
  return {
    schema: 'session-indexer.reset_session_index.v1',
    indexDir: opts.indexDir,
    scope: opts.scope,
    currentSessionResolution: opts.currentSessionResolution,
    resetCount: sessions.length,
    sessions
  }
}

const samePath = (left, right) => {
  if (!left || !right) return false
  try {
    return path.resolve(left) === path.resolve(right)
  } catch (_err) {
    return String(left) === String(right)
  }
}

const sameFingerprint = (left, right) => JSON.stringify(left || null) === JSON.stringify(right || null)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ceilUsdCents = value => {
  const number = Number(value || 0)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.ceil((number - 1e-9) * 100) / 100
}

const workerSuspensionForSummaryBudget = summaryBudget => {
  const budget = compactSummaryBudget(summaryBudget || {})
  const remainingEstimate = Number(
    budget && budget.deferredBudgetUsd ||
    budget && budget.estimatedCostUsd ||
    budget && budget.neededBudgetUsd ||
    budget && budget.total_cost_usd ||
    0
  )
  const current = Number(budget && budget.maxBudgetUsd || 0)
  const remainingBudget = Number(budget && budget.remainingBudgetUsd)
  const approvalCap = ceilUsdCents(remainingEstimate)
  const approvalCapText = approvalCap.toFixed(2)
  const additionalBase = Number.isFinite(remainingBudget) && Object.hasOwn(budget, 'remainingBudgetUsd')
    ? remainingBudget
    : current
  const additional = approvalCap ? Math.max(0, approvalCap - additionalBase) : Number(budget && budget.additionalBudgetUsd || Math.max(0, remainingEstimate - current))
  const targetCount = Number(budget && budget.deferredTargetCount || budget && budget.targetCount || 0)
  const status = budget && budget.status
  const message = status === 'budget_limited'
    ? `summary budget consumed after completing affordable targets; remaining estimated spend is $${remainingEstimate.toFixed(4)} for ${targetCount} target(s)`
    : `summary budget suspended; estimated spend is $${remainingEstimate.toFixed(4)} for ${targetCount} target(s)`
  const approval = remainingEstimate
    ? {
        type: 'summary_budget',
        status: 'required',
        amountUsd: approvalCap,
        estimatedCostUsd: remainingEstimate,
        currentCapUsd: current,
        additionalUsd: additional,
        targetCount,
        prompt: `Resume conversation_history summarization with budget cap $${approvalCapText} for ${targetCount} target(s).`,
        resumeArgs: {
          summary_max_budget_usd: approvalCapText
        },
        cliFlag: `--summary-max-budget-usd ${approvalCapText}`
      }
    : {
        type: 'summary_budget',
        status: 'required',
        prompt: 'Resume conversation_history summarization with a higher budget cap.'
      }
  return {
    reason: 'summary_budget',
    phase: 'summary:budget_suspended',
    message,
    summaryBudget: budget,
    approval,
    requiredAction: remainingEstimate
      ? `Resume with summary_max_budget_usd=${approvalCapText} to cover ${targetCount} remaining target(s).`
      : 'Resume with a higher conversation_history summarization budget cap.'
  }
}

const workerSuspensionForError = err => {
  const message = err && err.message ? err.message : String(err || '')
  if (/pricing.*(?:cannot|could not|unresolved|unknown)|unknown model_id|ambiguous model_id|unknown pricing/i.test(message)) {
    return {
      reason: 'summary_pricing',
      phase: 'summary:pricing_suspended',
      message,
      requiredAction: 'Fix summary model pricing resolution or use --summary-max-budget-usd off to disable the guard.'
    }
  }
  return null
}

const summaryOptionsMatch = (session, opts) => {
  const summary = session.summaryIndex || {}
  if ((summary.mode || '') !== (opts.summaryMode || '')) return false
  if (opts.summaryMode !== 'model') return true
  if (opts.summaryProvider && summary.provider !== opts.summaryProvider) return false
  if (opts.summaryModel && summary.model !== opts.summaryModel) return false
  if (opts.summaryReasoningEffort && opts.summaryReasoningEffort !== 'off' && summary.reasoningEffort !== opts.summaryReasoningEffort) return false
  return true
}

const statusReadiness = status => {
  const stats = status && status.indexingStats || {}
  const store = status && status.summaryTargetStore || {}
  const storePendingTargetCount = Math.max(0,
    Number(store.currentTargetCount || 0) -
    Number(store.currentStoredCompletedTargetCount || 0) -
    Number(store.currentStoredFailedTargetCount || 0)
  )
  const pendingTargetCount = Math.max(
    Number(stats.pendingTargetCount || 0),
    storePendingTargetCount
  )
  const completedTargetCount = Number(stats.completedTargetCount || 0)
  const claimedTargetCount = Number(store.currentStoredClaimedTargetCount || 0)
  const failedTargetCount = Number(stats.failedTargetCount || 0) +
    Number(store.currentStoredFailedTargetCount || 0) +
    Number(store.currentStoredStaleClaimCount || 0)
  return {
    ready: Boolean(status && status.indexed !== false && pendingTargetCount === 0 && claimedTargetCount === 0 && failedTargetCount === 0),
    pendingTargetCount,
    completedTargetCount,
    claimedTargetCount,
    failedTargetCount
  }
}

const reusableIndexedSession = ({ adapter, file, opts }) => {
  if (!adapter.sourceFingerprint) return null
  const fingerprint = adapter.sourceFingerprint(file)
  const manifest = readManifest(opts.indexDir)
  const session = Object.values(manifest.sessions || {})
    .find(item => item && samePath(item.sourcePath, file))
  if (!session || !sameFingerprint(session.sourceFingerprint, fingerprint)) return null
  if (!summaryOptionsMatch(session, opts)) return null
  const status = indexStatus({
    root: opts.indexDir,
    sessionId: session.sessionId,
    startAt: 0,
    limit: 1
  }).sessions[0]
  const readiness = statusReadiness(status)
  if (!readiness.ready && readiness.pendingTargetCount > 0 && readiness.failedTargetCount === 0) return null
  return {
    sessionId: session.sessionId,
    title: session.title,
    sourcePath: session.sourcePath,
    sourceFingerprint: fingerprint,
    eventCount: session.eventCount,
    docCount: session.docCount,
    rootHandle: session.rootHandle,
    fullTokenCount: session.fullTokenCount,
    usage: session.usage,
    summaryIndex: session.summaryIndex,
    compactions: session.compactions,
    indexingStats: session.indexingStats,
    reusedExistingIndex: true,
    readiness
  }
}

const compactJobSession = session => ({
  sessionId: session.sessionId,
  title: session.title,
  sourcePath: session.sourcePath,
  sourceFingerprint: session.sourceFingerprint,
  eventCount: session.eventCount,
  docCount: session.docCount,
  rootHandle: session.rootHandle,
  fullTokenCount: session.fullTokenCount,
  indexingStats: session.indexingStats,
  readiness: session.readiness,
  reusedExistingIndex: Boolean(session.reusedExistingIndex)
})

const workerArgsFor = ({ opts, jobId, files }) => {
  const args = [
    'index_worker',
    '--job-id', jobId,
    '--scope', opts.scope,
    '--source', opts.source,
    '--index-dir', opts.indexDir,
    '--search-backend', opts.searchBackend,
    '--typesense-api-key', opts.typesenseApiKey,
    '--typesense-collection', opts.typesenseCollection,
    '--typesense-import-chunk-size', String(opts.typesenseImportChunkSize),
    '--summary-mode', opts.summaryMode,
    '--summary-provider', opts.summaryProvider,
    '--summary-reasoning-effort', opts.summaryReasoningEffort,
    '--max-summary-nodes', String(opts.maxSummaryNodes),
    '--max-summary-child-chars', String(opts.maxSummaryChildChars),
    '--summary-input-token-budget', String(opts.summaryInputTokenBudget),
    '--summary-max-output-tokens', String(opts.summaryMaxOutputTokens),
    '--summary-max-budget-usd', String(opts.summaryMaxBudgetUsd),
    '--summary-concurrency', String(opts.summaryConcurrency),
    '--summary-rate-limit-max-retries', String(opts.summaryRateLimitMaxRetries),
    '--summary-rate-limit-backoff-ms', String(opts.summaryRateLimitBackoffMs),
    '--summary-rate-limit-max-backoff-ms', String(opts.summaryRateLimitMaxBackoffMs),
    '--summary-batch-timeout-ms', String(opts.summaryBatchTimeoutMs),
    '--summary-batch-poll-ms', String(opts.summaryBatchPollMs),
    '--pricing-cache-dir', opts.pricingCacheDir,
    '--debounce-ms', String(opts.debounceMs)
  ]
  if (opts.summaryModel) args.push('--summary-model', opts.summaryModel)
  if (opts.summaryBatchId) args.push('--summary-batch-id', opts.summaryBatchId)
  if (opts.codexHome) args.push('--codex-home', opts.codexHome)
  if (opts.summaryRegion) args.push('--summary-region', opts.summaryRegion)
  if (opts.anthropicAwsWorkspaceId) args.push('--anthropic-aws-workspace-id', opts.anthropicAwsWorkspaceId)
  if (opts.awsProfile) args.push('--aws-profile', opts.awsProfile)
  if (opts.bedrockCwd) args.push('--bedrock-cwd', opts.bedrockCwd)
  if (opts.claudeCliPath) args.push('--claude-cli-path', opts.claudeCliPath)
  if (opts.claudeCliMaxBudgetUsd) args.push('--claude-cli-max-budget-usd', opts.claudeCliMaxBudgetUsd)
  if (opts.sourceRoot) args.push('--source-root', opts.sourceRoot)
  if (opts.sessionIndex) args.push('--session-index', opts.sessionIndex)
  if (opts.includeResponseMessages) args.push('--include-response-messages')
  if (opts.waitForSessionMarker) {
    args.push(
      '--this-chat',
      '--session-marker', opts.sessionMarker,
      '--wait-for-session-marker',
      '--session-marker-since-ms', String(opts.sessionMarkerSinceMs),
      '--session-marker-wait-timeout-ms', String(opts.sessionMarkerWaitTimeoutMs)
    )
  } else if (opts.scope === 'all') args.push('--all')
  else for (const file of files) args.push('--session', file)
  return args
}

const startIndexingSession = async opts => {
  const waitForSessionMarker = Boolean(opts.waitForSessionMarker && opts.thisChat && opts.sessionMarker)
  const files = waitForSessionMarker ? [] : indexingFiles(opts)
  const sessionMarkerBaseline = waitForSessionMarker && opts.source === 'codex'
    ? walkCodexJsonlFiles(opts.sourceRoot || adapterFor(opts.source).defaultRoot)
    : []
  opts.waitForSessionMarker = waitForSessionMarker
  if (waitForSessionMarker && !(Number(opts.sessionMarkerSinceMs) > 0)) {
    opts.sessionMarkerSinceMs = Date.now()
  }
  const jobId = makeIndexingJobId({
    source: opts.source,
    scope: opts.scope,
    indexDir: opts.indexDir,
    sourceRoot: opts.sourceRoot,
    sessions: waitForSessionMarker ? [] : files,
    searchBackend: opts.searchBackend,
    typesenseCollection: opts.typesenseCollection,
    summaryMode: opts.summaryMode,
    summaryProvider: opts.summaryProvider,
    summaryModel: opts.summaryModel,
    summaryReasoningEffort: opts.summaryReasoningEffort,
    summaryBatchId: opts.summaryBatchId,
    summaryInputTokenBudget: opts.summaryInputTokenBudget,
    summaryMaxBudgetUsd: opts.summaryMaxBudgetUsd,
    summaryConcurrency: opts.summaryConcurrency,
    summaryRateLimitMaxRetries: opts.summaryRateLimitMaxRetries,
    summaryRateLimitBackoffMs: opts.summaryRateLimitBackoffMs,
    summaryRateLimitMaxBackoffMs: opts.summaryRateLimitMaxBackoffMs,
    pricingCacheDir: opts.pricingCacheDir,
    maxSummaryNodes: opts.maxSummaryNodes,
    sessionMarker: waitForSessionMarker ? opts.sessionMarker : ''
  })
  const workerArgs = workerArgsFor({ opts, jobId, files })
  const result = await startIndexingJob({
    binPath: path.resolve(__dirname, '..', 'bin', 'session-indexer.js'),
    root: opts.indexDir,
    jobId,
    source: opts.source,
    scope: opts.scope,
    searchBackend: opts.searchBackend,
    typesenseCollection: opts.typesenseCollection,
    summaryMode: opts.summaryMode,
    summaryProvider: opts.summaryProvider,
    summaryModel: opts.summaryModel,
    summaryReasoningEffort: opts.summaryReasoningEffort,
    summaryBatchId: opts.summaryBatchId,
    summaryInputTokenBudget: opts.summaryInputTokenBudget,
    summaryMaxBudgetUsd: opts.summaryMaxBudgetUsd,
    summaryConcurrency: opts.summaryConcurrency,
    summaryRateLimitMaxRetries: opts.summaryRateLimitMaxRetries,
    summaryRateLimitBackoffMs: opts.summaryRateLimitBackoffMs,
    summaryRateLimitMaxBackoffMs: opts.summaryRateLimitMaxBackoffMs,
    pricingCacheDir: opts.pricingCacheDir,
    maxSummaryNodes: opts.maxSummaryNodes,
    sourceRoot: opts.sourceRoot,
    sessionMarker: waitForSessionMarker ? opts.sessionMarker : '',
    waitForSessionMarker,
    sessionMarkerBaseline,
    sessions: files,
    workerArgs,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs
  })
  return {
    schema: 'session-indexer.start_indexing_session.v1',
    timeoutMs: opts.timeoutMs,
    currentSessionResolution: opts.currentSessionResolution,
    ...(opts.sessionMarker ? { sessionMarker: opts.sessionMarker } : {}),
    ...(waitForSessionMarker ? { generatedSessionMarker: true } : {}),
    reused: result.reused,
    job: result.job
  }
}

const stopIndexingSession = async opts => {
  const files = opts.scope === 'all' ? [] : indexingFiles(opts)
  const jobs = await stopIndexingJobs({
    root: opts.indexDir,
    scope: opts.scope,
    sessions: files,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs
  })
  return {
    schema: 'session-indexer.stop_indexing_session.v1',
    scope: opts.scope,
    timeoutMs: opts.timeoutMs,
    currentSessionResolution: opts.currentSessionResolution,
    stoppedCount: jobs.filter(job => job && job.status === 'stopped').length,
    jobs
  }
}

const runIndexWorker = async opts => {
  const adapter = adapterFor(opts.source)
  const jobId = opts.jobId || makeIndexingJobId({
    source: opts.source,
    scope: opts.scope,
    indexDir: opts.indexDir,
    sourceRoot: opts.sourceRoot,
    sessions: indexingFiles(opts),
    searchBackend: opts.searchBackend,
    typesenseCollection: opts.typesenseCollection,
    summaryMode: opts.summaryMode,
    summaryProvider: opts.summaryProvider,
    summaryModel: opts.summaryModel,
    summaryReasoningEffort: opts.summaryReasoningEffort,
    summaryBatchId: opts.summaryBatchId,
    summaryInputTokenBudget: opts.summaryInputTokenBudget,
    summaryMaxBudgetUsd: opts.summaryMaxBudgetUsd,
    summaryConcurrency: opts.summaryConcurrency,
    summaryRateLimitMaxRetries: opts.summaryRateLimitMaxRetries,
    summaryRateLimitBackoffMs: opts.summaryRateLimitBackoffMs,
    summaryRateLimitMaxBackoffMs: opts.summaryRateLimitMaxBackoffMs,
    pricingCacheDir: opts.pricingCacheDir,
    maxSummaryNodes: opts.maxSummaryNodes
  })
  const markerLookupCache = new Map()
  if (opts.source === 'codex' && opts.waitForSessionMarker) {
    const initial = readJobState({ root: opts.indexDir, jobId }) || {}
    primeMarkerLookupCache({
      markerLookupCache,
      root: opts.sourceRoot || adapter.defaultRoot,
      marker: opts.sessionMarker,
      sessionFiles: initial.sessionMarkerBaseline || []
    })
  }
  const writeState = state => writeJobState({
    root: opts.indexDir,
    state: {
      jobId,
      scope: opts.scope,
      source: opts.source,
      indexDir: opts.indexDir,
      sourceRoot: opts.sourceRoot,
      searchBackend: opts.searchBackend,
      typesenseCollection: opts.typesenseCollection,
      summaryMode: opts.summaryMode,
      summaryProvider: opts.summaryProvider,
      summaryModel: opts.summaryModel,
      summaryReasoningEffort: opts.summaryReasoningEffort,
      summaryBatchId: opts.summaryBatchId,
      summaryInputTokenBudget: opts.summaryInputTokenBudget,
      summaryMaxBudgetUsd: opts.summaryMaxBudgetUsd,
      summaryConcurrency: opts.summaryConcurrency,
      summaryRateLimitMaxRetries: opts.summaryRateLimitMaxRetries,
      summaryRateLimitBackoffMs: opts.summaryRateLimitBackoffMs,
      summaryRateLimitMaxBackoffMs: opts.summaryRateLimitMaxBackoffMs,
      pricingCacheDir: opts.pricingCacheDir,
      maxSummaryNodes: opts.maxSummaryNodes,
      sessions: state.sessions || opts.sessions,
      pid: process.pid,
      ...state
    }
  })
  const logProgress = event => {
    const line = {
      event: 'index_progress',
      jobId,
      at: new Date().toISOString(),
      ...event
    }
    process.stdout.write(`${JSON.stringify(line)}\n`)
  }
  let stopped = false
  let watcher = null
  const pendingTimers = new Map()
  const summaryBudgetBaselineTargetIdsBySession = new Map()
  const budgetSuspensionForSession = session => {
    const summary = session && session.summaryIndex || {}
    if (summary.status !== 'suspended-budget') return null
    return workerSuspensionForSummaryBudget(summary.summaryBudget)
  }
  const stop = () => {
    stopped = true
    writeState({
      status: 'stopped',
      progress: {
        phase: 'stopped'
      }
    })
    process.exit(0)
  }
  const suspendWorkerWithSuspension = async (suspension, extraProgress = {}) => {
    stopped = true
    const progress = {
      phase: suspension.phase || 'suspended',
      suspended: true,
      reason: suspension.reason,
      ...(suspension.summaryBudget ? { summaryBudget: suspension.summaryBudget } : {}),
      ...(suspension.approval ? { approval: suspension.approval } : {}),
      ...extraProgress
    }
    logProgress({ ...progress, message: suspension.message })
    writeState({
      status: 'suspended',
      ready: false,
      suspendedReason: suspension.reason,
      suspension,
      ...(suspension.summaryBudget ? { summaryBudget: suspension.summaryBudget } : {}),
      message: suspension.message,
      progress
    })
    for (const timer of pendingTimers) clearTimeout(timer)
    pendingTimers.clear()
    if (watcher) await watcher.close()
  }
  const suspendWorker = async (err, extraProgress = {}) => {
    const suspension = workerSuspensionForError(err) || {
      reason: 'unknown',
      phase: 'suspended',
      message: err && err.message ? err.message : String(err)
    }
    await suspendWorkerWithSuspension(suspension, extraProgress)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  const importAndIndex = file => {
    logProgress({ phase: 'import:start', file })
    const ir = importFile(adapter, file, opts)
    if (!summaryBudgetBaselineTargetIdsBySession.has(ir.session.id)) {
      summaryBudgetBaselineTargetIdsBySession.set(
        ir.session.id,
        completedSummaryJobs({ root: opts.indexDir, sessionId: ir.session.id })
          .map(job => job.targetId)
          .filter(Boolean)
      )
    }
    logProgress({
      phase: 'import:done',
      file,
      sessionId: ir.session.id,
      eventCount: ir.events.length,
      updatedAt: ir.session.updatedAt
    })
    return writeSessionIndexWithBackend({
      root: opts.indexDir,
      ir,
      ...summaryOpts(opts),
      summaryBudgetBaselineTargetIds: summaryBudgetBaselineTargetIdsBySession.get(ir.session.id),
      ...backendOpts(opts),
      onProgress: event => {
        const progress = {
          currentFile: file,
          sessionId: ir.session.id,
          ...event
        }
        logProgress(progress)
        writeState({
          status: 'indexing',
          ready: false,
          sessions: opts.sessions,
          progress
        })
      }
    })
  }
  const sessionReadiness = session => {
    if (session.readiness) return session.readiness
    const stats = session.indexingStats || {}
    const pendingTargetCount = Number(stats.pendingTargetCount || 0)
    const failedTargetCount = Number(stats.failedTargetCount || 0)
    return {
      ready: pendingTargetCount === 0 && failedTargetCount === 0,
      pendingTargetCount,
      completedTargetCount: Number(stats.completedTargetCount || 0),
      claimedTargetCount: 0,
      failedTargetCount
    }
  }
  const summarizeReadiness = sessions => {
    const readiness = sessions.map(sessionReadiness)
    const pendingTargetCount = readiness.reduce((sum, item) => sum + Number(item.pendingTargetCount || 0), 0)
    const completedTargetCount = readiness.reduce((sum, item) => sum + Number(item.completedTargetCount || 0), 0)
    const claimedTargetCount = readiness.reduce((sum, item) => sum + Number(item.claimedTargetCount || 0), 0)
    const failedTargetCount = readiness.reduce((sum, item) => sum + Number(item.failedTargetCount || 0), 0)
    return {
      ready: readiness.length > 0 && readiness.every(item => item.ready),
      pendingTargetCount,
      completedTargetCount,
      claimedTargetCount,
      failedTargetCount,
      canContinue: Number(opts.maxSummaryNodes || 0) > 0 && pendingTargetCount > 0 && failedTargetCount === 0
    }
  }
  const indexFiles = async files => {
    let pass = 0
    while (!stopped) {
      const sessions = []
      for (let index = 0; index < files.length; index++) {
        const file = files[index]
        if (stopped) return
        writeState({
          status: 'indexing',
          ready: false,
          sessions: files,
          progress: {
            phase: 'indexing',
            pass,
            indexed: index,
            total: files.length,
            currentFile: file
          }
        })
        sessions.push(reusableIndexedSession({ adapter, file, opts }) || await importAndIndex(file))
      }
      const readiness = summarizeReadiness(sessions)
      const changedDuringIndex = adapter.sourceFingerprint
        ? files.filter((file, index) => !sameFingerprint(
            sessions[index] && sessions[index].sourceFingerprint,
            adapter.sourceFingerprint(file)
          ))
        : []
      if (changedDuringIndex.length) {
        const progress = {
          phase: 'source_changed_during_index',
          pass,
          changedFiles: changedDuringIndex,
          changedFileCount: changedDuringIndex.length
        }
        logProgress(progress)
        writeState({
          status: 'indexing',
          ready: false,
          sessions: files,
          progress
        })
        pass += 1
        continue
      }
      const budgetSuspendedSession = sessions.find(session => budgetSuspensionForSession(session))
      if (budgetSuspendedSession) {
        await suspendWorkerWithSuspension(budgetSuspensionForSession(budgetSuspendedSession), {
          pass,
          indexed: sessions.length,
          total: files.length,
          sessionId: budgetSuspendedSession.sessionId,
          currentFile: budgetSuspendedSession.sourcePath,
          pendingTargetCount: readiness.pendingTargetCount,
          completedTargetCount: readiness.completedTargetCount,
          claimedTargetCount: readiness.claimedTargetCount,
          failedTargetCount: readiness.failedTargetCount,
          lastIndexedAt: new Date().toISOString()
        })
        return
      }
      writeState({
        status: readiness.ready ? 'ready' : 'indexing',
        ready: readiness.ready,
        sessions: files,
        result: {
          sessions: sessions.map(compactJobSession)
        },
        progress: {
          phase: readiness.ready ? 'watching' : 'summarizing',
          pass,
          indexed: sessions.length,
          total: files.length,
          pendingTargetCount: readiness.pendingTargetCount,
          completedTargetCount: readiness.completedTargetCount,
          claimedTargetCount: readiness.claimedTargetCount,
          failedTargetCount: readiness.failedTargetCount,
          lastIndexedAt: new Date().toISOString()
        }
      })
      if (readiness.ready || !readiness.canContinue) return
      pass += 1
    }
  }

  const resolveWorkerFiles = async () => {
    if (!opts.waitForSessionMarker) return selectFiles(adapter, opts)
    const markerWaitStartedAtMs = Number(opts.sessionMarkerSinceMs) > 0
      ? Number(opts.sessionMarkerSinceMs)
      : Date.now()
    const markerWaitTimeoutMs = Math.max(0, Number(opts.sessionMarkerWaitTimeoutMs || 0))
    while (!stopped) {
      let markerAmbiguity = null
      let resolved = null
      try {
        resolved = adapter.resolveCurrentSessionFile({
          root: opts.sourceRoot || adapter.defaultRoot,
          command: opts.command,
          sessionMarker: opts.sessionMarker,
          sessionMarkerSinceMs: opts.sessionMarkerSinceMs,
          markerLookupCache
        })
      } catch (err) {
        if (!err || err.code !== 'AMBIGUOUS_SESSION_MARKER') throw err
        markerAmbiguity = err.message
      }
      if (resolved && resolved.file) {
        opts.currentSessionResolution = {
          file: resolved.file,
          reason: resolved.reason,
          score: resolved.score,
          signals: resolved.signals
        }
        logProgress({
          phase: 'session_marker_found',
          file: resolved.file,
          sessionMarker: opts.sessionMarker
        })
        return [resolved.file]
      }
      const progress = {
        phase: 'waiting_for_session_marker',
        sessionMarker: opts.sessionMarker,
        ...(markerAmbiguity ? { reason: 'awaiting_fork_disambiguation', message: markerAmbiguity } : {})
      }
      logProgress(progress)
      writeState({
        status: 'indexing',
        ready: false,
        sessionMarker: opts.sessionMarker,
        waitForSessionMarker: true,
        sessions: [],
        progress
      })
      if (markerWaitTimeoutMs > 0 && Date.now() - markerWaitStartedAtMs >= markerWaitTimeoutMs) {
        const message = `session marker did not appear within ${markerWaitTimeoutMs}ms`
        const timeoutProgress = {
          phase: 'session_marker_timeout',
          sessionMarker: opts.sessionMarker,
          waitedMs: Date.now() - markerWaitStartedAtMs
        }
        logProgress({ ...timeoutProgress, message })
        writeState({
          status: 'error',
          ready: false,
          error: message,
          sessionMarker: opts.sessionMarker,
          waitForSessionMarker: true,
          sessions: [],
          progress: timeoutProgress
        })
        return []
      }
      await sleep(opts.pollMs)
    }
    return []
  }

  try {
    const files = await resolveWorkerFiles()
    if (!files.length) return
    writeState({
      status: 'starting',
      sessions: files,
      sessionMarker: opts.sessionMarker || undefined,
      waitForSessionMarker: Boolean(opts.waitForSessionMarker),
      progress: {
        phase: 'starting',
        indexed: 0,
        total: files.length
      },
      startedAt: new Date().toISOString()
    })
    const watched = opts.scope === 'all'
      ? path.join(opts.sourceRoot || adapter.defaultRoot, '**', '*.jsonl')
      : files
    const changedFiles = new Set()
    let watcherIndexRunning = false
    let watcherIndexAgain = false
    const indexQueuedChanges = async () => {
      if (watcherIndexRunning) {
        watcherIndexAgain = true
        writeState({
          status: 'indexing',
          ready: false,
          sessions: files,
          progress: {
            phase: 'indexing:queued',
            pendingChangeCount: changedFiles.size
          }
        })
        return
      }
      watcherIndexRunning = true
      try {
        do {
          watcherIndexAgain = false
          const batch = opts.scope === 'all' ? Array.from(changedFiles) : files
          changedFiles.clear()
          if (!batch.length) continue
          await indexFiles(batch)
        } while (watcherIndexAgain && !stopped)
      } finally {
        watcherIndexRunning = false
      }
    }
    const queue = file => {
      if (!String(file).endsWith('.jsonl')) return
      const resolvedFile = path.resolve(file)
      if (opts.scope !== 'all' && !files.includes(resolvedFile)) return
      clearTimeout(pendingTimers.get(file))
      pendingTimers.set(file, setTimeout(async () => {
        pendingTimers.delete(file)
        changedFiles.add(resolvedFile)
        try {
          await indexQueuedChanges()
        } catch (err) {
          if (workerSuspensionForError(err)) {
            await suspendWorker(err, {
              currentFile: file
            })
            process.exit(0)
          }
          writeState({
            status: 'error',
            error: err.message,
            progress: {
              phase: 'error',
              currentFile: file
            }
          })
        }
      }, opts.debounceMs))
    }
    watcher = chokidar.watch(watched, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(250, Math.floor(opts.debounceMs / 2)),
        pollInterval: 100
      }
    })
    watcher.on('add', queue)
    watcher.on('change', queue)
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
    watcherIndexRunning = true
    try {
      await indexFiles(files)
    } finally {
      watcherIndexRunning = false
    }
    if (stopped) return
    if (watcherIndexAgain || changedFiles.size) await indexQueuedChanges()
    await new Promise(() => {})
  } catch (err) {
    if (workerSuspensionForError(err)) {
      await suspendWorker(err)
      return
    }
    writeState({
      status: 'error',
      error: err.message,
      progress: {
        phase: 'error'
      }
    })
    throw err
  }
}

const watch = async opts => {
  const adapter = adapterFor(opts.source)
  const root = opts.sourceRoot || adapter.defaultRoot
  const files = opts.all ? selectFiles(adapter, opts) : selectFiles(adapter, { ...opts, all: false })
  process.stdout.write(`${JSON.stringify({ event: 'initial_index', result: await index({ ...opts, sessions: files }) })}\n`)
  const pending = new Map()
  const queue = file => {
    if (!file.endsWith('.jsonl')) return
    clearTimeout(pending.get(file))
    pending.set(file, setTimeout(async () => {
      pending.delete(file)
      try {
        const result = await index({ ...opts, sessions: [file] })
        process.stdout.write(`${JSON.stringify({ event: 'indexed', file, result })}\n`)
      } catch (err) {
        process.stderr.write(`${JSON.stringify({ event: 'index_error', file, error: err.message })}\n`)
      }
    }, opts.debounceMs))
  }
  const watcher = chokidar.watch(path.join(root, '**', '*.jsonl'), {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: Math.max(250, Math.floor(opts.debounceMs / 2)),
      pollInterval: 100
    }
  })
  watcher.on('add', queue)
  watcher.on('change', queue)
  process.stdout.write(`${JSON.stringify({ event: 'watching', root })}\n`)
}

const runCommand = async opts => {
  if (opts.help || opts.command === 'help') return usage()
  if (opts.command === 'inspect') return inspect(opts)
  else if (opts.command === 'index') return index(opts)
  else if (opts.command === 'search') return search(opts)
  else if (opts.command === 'browse') return browse(opts)
  else if (opts.command === 'openLink') return open(opts)
  else if (opts.command === 'index_status' || opts.command === 'indexStatus') return conversationIndexStatus(opts)
  else if (opts.command === 'search_server_status' || opts.command === 'searchServerStatus') return searchServerStatus(opts)
  else if (opts.command === 'typesense_install' || opts.command === 'typesenseInstall') return typesenseInstall(opts)
  else if (opts.command === 'typesense_start' || opts.command === 'typesenseStart') return typesenseStart(opts)
  else if (opts.command === 'typesense_stop' || opts.command === 'typesenseStop') return typesenseStop(opts)
  else if (opts.command === 'typesense_status' || opts.command === 'typesenseStatus') return typesenseStatus(opts)
  else if (opts.command === 'list_models' || opts.command === 'listModels') return listPricingModels(opts)
  else if (opts.command === 'get_pricing' || opts.command === 'getPricing') return getPricing(opts)
  else if (opts.command === 'get_cost' || opts.command === 'getCost') return getCost(opts)
  else if (opts.command === 'eval_retrieval' || opts.command === 'evalRetrieval') return evalRetrieval(opts)
  else if (opts.command === 'import_codex_session_to_pi' || opts.command === 'importCodexSessionToPi') return importCodexSessionToPi(opts)
  else if (opts.command === 'deploy') return deploy(opts)
  else if (opts.command === 'redeploy_session_index_mcp' || opts.command === 'redeploySessionIndexMcp') return redeploySessionIndexMcp(opts)
  else if (opts.command === 'start_indexing_session' || opts.command === 'startIndexingSession') return startIndexingSession(opts)
  else if (opts.command === 'stop_indexing_session' || opts.command === 'stopIndexingSession') return stopIndexingSession(opts)
  else if (opts.command === 'reset_session_index' || opts.command === 'resetSessionIndex') return resetSessionIndexCommand(opts)
  else if (opts.command === 'index_worker') return runIndexWorker(opts)
  else if (opts.command === 'watch') return watch(opts)
  else throw new Error(`unknown command: ${opts.command}`)
}

const main = async argv => {
  const opts = parseArgs(argv)
  const result = await runCommand(opts)
  if (result !== undefined) {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
  }
}

module.exports = {
  main,
  parseArgs,
  runCommand
}
