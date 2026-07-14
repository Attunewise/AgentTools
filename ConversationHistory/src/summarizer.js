const os = require('os')
const path = require('path')
const { providerObserver } = require('./providers/ChatObserver.js')
const { OpenAICodexResponsesProvider } = require('./providers/OpenAICodexResponsesProvider.js')
const { BedrockAnthropicProvider } = require('./providers/BedrockAnthropicProvider.js')
const { ClaudeCliProvider } = require('./providers/ClaudeCliProvider.js')
const {
  applyCompactionSearchScope,
  compactedEventSpans,
  createSummaryNode,
  isModelVisibleNode,
  modelVisibleChildren,
  rebuildTreeIndex
} = require('./mip.js')
const { addUsage, normalizeUsage } = require('./ir.js')
const {
  DEFAULT_PRICING_CACHE_DIR,
  compactSummaryBudget,
  estimateCost,
  loadModelsDevCatalog,
  resolvePricing
} = require('./pricing.js')
const {
  ClaudePlatformAwsBatchProvider,
  batchMeta,
  messageText,
  safeCustomId
} = require('./providers/ClaudePlatformAwsBatchProvider.js')
const { normalizeConcurrency, runWorkQueue } = require('./workQueue.js')
const {
  compactText,
  estimateTokens,
  hashString,
  preview,
  readJson,
  stableStringify
} = require('./util.js')
const {
  normalizeTopics,
  topicsText
} = require('./topics.js')

const SUMMARY_SYSTEM_PROMPT = 'Preserve the turns in the conversation. Identify the speaker, user, assistant, or tool call. Copy the information, not the wording. Keep all concrete state. Remove filler, repetition, politeness padding, meta-commentary, and verbose restatements. Do not abstract. Do not decide salience unless something is clearly redundant or obsolete. For tool calls summarize the operation, input, and outcome'
const PARENT_SUMMARY_SYSTEM_PROMPT = 'Create a concise higher-level conversation summary from the complete ordered child summaries. Preserve concrete state, decisions, open tasks, tool outcomes, file paths, code symbols, model and tool choices, errors, constraints, and user preferences. Merge redundant facts and preserve chronology only where it changes causality or state. Do not list original turns or invent missing details. Return only one JSON object with keys breadcrumb, summary, and topics. breadcrumb is one or two words. summary is the complete parent summary. topics is an array of objects with one_word and one_line keys.'
const PARENT_UPDATE_SYSTEM_PROMPT = 'Revise an existing higher-level conversation summary using the supplied ordered child-summary suffix. The update metadata says whether the suffix is appended or replaces the previous suffix. When it replaces a suffix, remove or revise claims supported only by the superseded child summaries; new child evidence takes precedence over stale statements in the existing summary. Preserve still-valid concrete state, decisions, open tasks, tool outcomes, file paths, code symbols, model and tool choices, errors, constraints, and user preferences. Merge redundant facts and preserve chronology only where it changes causality or state. Return a complete replacement summary, not a patch. Do not list original turns or invent missing details. Return only one JSON object with keys breadcrumb, summary, and topics. breadcrumb is one or two words. summary is the complete updated parent summary. topics is an array of objects with one_word and one_line keys.'

const DEFAULT_SUMMARY_MODE = process.env.SESSION_INDEXER_SUMMARY_MODE || 'model'
const DEFAULT_SUMMARY_PROVIDER = process.env.SESSION_INDEXER_SUMMARY_PROVIDER || 'openai-codex-responses'
const DEFAULT_SUMMARY_REASONING_EFFORT = process.env.SESSION_INDEXER_SUMMARY_REASONING_EFFORT ||
  process.env.SESSION_INDEXER_REASONING_EFFORT ||
  'low'
const DEFAULT_MAX_SUMMARY_NODES = 20
const DEFAULT_MAX_CHILD_CHARS = 1200
const DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET = Number(process.env.SESSION_INDEXER_SUMMARY_INPUT_TOKEN_BUDGET || 20000)
const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = Number(process.env.SESSION_INDEXER_SUMMARY_MAX_OUTPUT_TOKENS || 320)
const DEFAULT_SUMMARY_MAX_BUDGET_USD = process.env.SESSION_INDEXER_SUMMARY_MAX_BUDGET_USD || '5'
const DEFAULT_SUMMARY_CONCURRENCY = normalizeConcurrency(process.env.SESSION_INDEXER_SUMMARY_CONCURRENCY || 16)
const DEFAULT_SUMMARY_RATE_LIMIT_MAX_RETRIES = Number(process.env.SESSION_INDEXER_SUMMARY_RATE_LIMIT_MAX_RETRIES || 5)
const DEFAULT_SUMMARY_RATE_LIMIT_BACKOFF_MS = Number(process.env.SESSION_INDEXER_SUMMARY_RATE_LIMIT_BACKOFF_MS || 60000)
const DEFAULT_SUMMARY_RATE_LIMIT_MAX_BACKOFF_MS = Number(process.env.SESSION_INDEXER_SUMMARY_RATE_LIMIT_MAX_BACKOFF_MS || 5 * 60 * 1000)
const DEFAULT_SUMMARY_EMPTY_RESPONSE_MAX_RETRIES = Number(process.env.SESSION_INDEXER_SUMMARY_EMPTY_RESPONSE_MAX_RETRIES || 2)
const DEFAULT_SUMMARY_EMPTY_RESPONSE_BACKOFF_MS = Number(process.env.SESSION_INDEXER_SUMMARY_EMPTY_RESPONSE_BACKOFF_MS || 1000)
const SPAN_SUMMARY_STRATEGY = 'compaction-contiguous-span-v1'
const ROOT_SUMMARY_STRATEGY = 'compaction-root-summary-v1'
const SUMMARY_TARGET_SCHEMA = 'session-indexer.summary-target.v1'

const summaryLevelForNode = node => {
  if (!node) return 1
  if (node.kind !== 'session') {
    return Number(node.meta && node.meta.summaryLevel || node.summaryMeta && node.summaryMeta.summaryLevel || 1)
  }
  const childLevels = (node.children || []).map(child => Number(
    child.meta && child.meta.summaryLevel || child.summaryMeta && child.summaryMeta.summaryLevel || 0
  ))
  return Math.max(1, ...childLevels) + 1
}

const summarySystemPromptForNode = (node, promptAction = 'create') => {
  if (summaryLevelForNode(node) <= 1) return SUMMARY_SYSTEM_PROMPT
  return promptAction === 'update'
    ? PARENT_UPDATE_SYSTEM_PROMPT
    : PARENT_SUMMARY_SYSTEM_PROMPT
}

const summaryPromptHashesForNode = node => summaryLevelForNode(node) <= 1
  ? new Set([hashString(SUMMARY_SYSTEM_PROMPT)])
  : new Set([
      hashString(PARENT_SUMMARY_SYSTEM_PROMPT),
      hashString(PARENT_UPDATE_SYSTEM_PROMPT)
    ])
const SUMMARY_PROMPT_SET_HASH = hashString([
  SUMMARY_SYSTEM_PROMPT,
  PARENT_SUMMARY_SYSTEM_PROMPT,
  PARENT_UPDATE_SYSTEM_PROMPT
].join('\n---\n'))

const CODEX_MODEL_PREFERENCES = [
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.5'
]

const codexHome = value => value || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

const modelsCachePath = root => path.join(codexHome(root), 'models_cache.json')

const loadCodexModels = root => {
  const file = modelsCachePath(root)
  const cache = readJson(file)
  const models = Array.isArray(cache.models) ? cache.models : []
  return {
    file,
    fetchedAt: cache.fetched_at,
    clientVersion: cache.client_version,
    models: models.map(item => item.id || item.slug || item.name).filter(Boolean)
  }
}

const chooseCodexModel = ({ model, codexHome: root } = {}) => {
  const cache = loadCodexModels(root)
  if (model && model !== 'auto') {
    if (!cache.models.includes(model)) {
      throw new Error(`Codex model ${model} is not in ${cache.file}. Available: ${cache.models.join(', ')}`)
    }
    return { model, cache }
  }
  const preferred = CODEX_MODEL_PREFERENCES.find(item => cache.models.includes(item)) ||
    cache.models.find(item => /mini|small|spark/i.test(item)) ||
    cache.models[0]
  if (!preferred) throw new Error(`No Codex models found in ${cache.file}`)
  return { model: preferred, cache }
}

const providerKey = value => String(value || '').toLowerCase().replace(/[._\s-]/g, '')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const isRateLimitError = error => {
  const text = String(error && (error.message || error.code || error.status) || '')
  return error && error.status === 429 ||
    /\b429\b|rate[_ -]?limit|too many requests|tokens per minute|requests per minute|retry after/i.test(text)
}

const retryAfterFromError = error => {
  const direct = Number(error && error.retryAfterMs)
  if (Number.isFinite(direct) && direct >= 0) return direct
  const text = String(error && error.message || '')
  const minutes = text.match(/(?:retry after|try again in)\s+([0-9.]+)\s*(m|min|mins|minute|minutes)/i)
  if (minutes) return Math.ceil(Number(minutes[1]) * 60 * 1000)
  const seconds = text.match(/(?:retry after|try again in)\s+([0-9.]+)\s*(s|sec|secs|second|seconds)?\b/i)
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000)
  return undefined
}

const rateLimitMaxRetries = opts => Math.max(0, Number.isFinite(Number(opts.summaryRateLimitMaxRetries))
  ? Number(opts.summaryRateLimitMaxRetries)
  : DEFAULT_SUMMARY_RATE_LIMIT_MAX_RETRIES)

const rateLimitBackoffMs = ({ opts, attempt, error }) => {
  const base = Math.max(1, Number.isFinite(Number(opts.summaryRateLimitBackoffMs))
    ? Number(opts.summaryRateLimitBackoffMs)
    : DEFAULT_SUMMARY_RATE_LIMIT_BACKOFF_MS)
  const max = Math.max(base, Number.isFinite(Number(opts.summaryRateLimitMaxBackoffMs))
    ? Number(opts.summaryRateLimitMaxBackoffMs)
    : DEFAULT_SUMMARY_RATE_LIMIT_MAX_BACKOFF_MS)
  const retryAfter = retryAfterFromError(error)
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(max, retryAfter)
  return Math.min(max, base * Math.max(1, 2 ** Math.max(0, attempt - 1)))
}

const emptyResponseMaxRetries = opts => Math.max(0, Number.isFinite(Number(opts.summaryEmptyResponseMaxRetries))
  ? Number(opts.summaryEmptyResponseMaxRetries)
  : DEFAULT_SUMMARY_EMPTY_RESPONSE_MAX_RETRIES)

const emptyResponseBackoffMs = opts => Math.max(1, Number.isFinite(Number(opts.summaryEmptyResponseBackoffMs))
  ? Number(opts.summaryEmptyResponseBackoffMs)
  : DEFAULT_SUMMARY_EMPTY_RESPONSE_BACKOFF_MS)

const isEmptySummaryResponseError = error =>
  /summary model returned an empty response/i.test(String(error && error.message || error || ''))

const completionEstimate = ({ startedAtMs, completedCount, totalCount, backoffMs = 0 }) => {
  const now = Date.now()
  const completed = Math.max(0, Number(completedCount || 0))
  const total = Math.max(0, Number(totalCount || 0))
  const remaining = Math.max(0, total - completed)
  const backoff = Math.max(0, Number(backoffMs || 0))
  if (completed === 0 && backoff === 0 && remaining > 0) return {}
  const averageMs = completed > 0 ? Math.max(0, now - startedAtMs) / completed : 0
  const estimatedRemainingMs = Math.ceil(backoff + (averageMs * remaining))
  return {
    estimatedRemainingMs,
    estimatedCompletionAt: new Date(now + estimatedRemainingMs).toISOString()
  }
}

const providerPricingId = providerName => {
  const key = providerKey(providerName)
  if (key.includes('openai') || key.includes('codex')) return 'openai'
  if (key.includes('anthropic') || key.includes('claude')) return 'anthropic'
  if (key.includes('google') || key.includes('gemini')) return 'google'
  return undefined
}

const summaryMaxBudgetUsd = opts => {
  const value = opts.summaryMaxBudgetUsd === undefined
    ? DEFAULT_SUMMARY_MAX_BUDGET_USD
    : opts.summaryMaxBudgetUsd
  const text = String(value || '').trim().toLowerCase()
  if (!text || text === 'off' || text === 'none' || text === 'disabled') return null
  const number = Number(text)
  if (!Number.isFinite(number) || number < 0) throw new Error('--summary-max-budget-usd must be a non-negative number or off')
  return number
}

const summaryOutputEstimate = ({ opts, resolved }) => Number(opts.summaryMaxOutputTokens ||
  resolved.callOptions && (resolved.callOptions.maxTokens || resolved.callOptions.max_tokens) ||
  DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS)

const estimatedUsageForJobs = ({ jobs, opts, resolved }) => {
  const list = jobs || []
  const outputEstimate = summaryOutputEstimate({ opts, resolved })
  return normalizeUsage({
    input: list.reduce((sum, job) => {
      const actual = normalizeUsage(job && job.usage || {})
      return sum + (actual.total ? actual.input : Number(job && job.inputTokenCount || 0))
    }, 0),
    output: list.reduce((sum, job) => {
      const actual = normalizeUsage(job && job.usage || {})
      return sum + (actual.total ? actual.output : outputEstimate)
    }, 0),
    cache_read: list.reduce((sum, job) => sum + normalizeUsage(job && job.usage || {}).cache_read, 0),
    cache_write: list.reduce((sum, job) => sum + normalizeUsage(job && job.usage || {}).cache_write, 0),
    reasoning: list.reduce((sum, job) => sum + normalizeUsage(job && job.usage || {}).reasoning, 0)
  })
}

const createSummaryBudgetEstimator = async ({ opts, resolved }) => {
  const maxBudgetUsd = summaryMaxBudgetUsd(opts)
  if (maxBudgetUsd === null) {
    return {
      maxBudgetUsd: null,
      estimate: (jobs, extra = {}) => ({
        status: 'disabled',
        maxBudgetUsd: null,
        usage: estimatedUsageForJobs({ jobs, opts, resolved }),
        ...extra
      }),
      costUsd: jobs => 0
    }
  }
  const catalog = await loadModelsDevCatalog({
    cacheDir: opts.pricingCacheDir || DEFAULT_PRICING_CACHE_DIR,
    refresh: Boolean(opts.refreshPricing)
  })
  const pricing = resolvePricing({
    catalog,
    model_id: resolved.model,
    provider: providerPricingId(resolved.providerName)
  })
  const estimate = (jobs, extra = {}) => {
    const list = jobs || []
    const usage = estimatedUsageForJobs({ jobs: list, opts, resolved })
    const cost = list.length
      ? estimateCost({ pricing, usage })
      : { total_cost_usd: 0 }
    const overBudget = cost.total_cost_usd > maxBudgetUsd
    return compactSummaryBudget({
      status: extra.status || (overBudget ? 'over_budget' : 'ok'),
      maxBudgetUsd,
      neededBudgetUsd: cost.total_cost_usd,
      additionalBudgetUsd: Math.max(0, cost.total_cost_usd - maxBudgetUsd),
      targetCount: list.length,
      provider: resolved.providerName,
      model: resolved.model,
      ...cost,
      ...extra
    })
  }
  return {
    maxBudgetUsd,
    estimate,
    costUsd: jobs => Number(estimate(jobs).total_cost_usd || 0)
  }
}

const estimateSummaryBudget = async ({ jobs, opts, resolved, enforce = true }) => {
  const estimator = await createSummaryBudgetEstimator({ opts, resolved })
  return estimator.estimate(jobs)
}

const baselineTargetIdSet = opts => new Set(
  Array.from(opts.summaryBudgetBaselineTargetIds || opts.summary_budget_baseline_target_ids || [])
    .map(String)
    .filter(Boolean)
)

const splitBudgetedPendingJobs = async ({ pendingJobs, reusedJobs, opts, resolved, limit }) => {
  const modelLimit = Math.max(0, limit)
  const limitedPendingJobs = pendingJobs.slice(0, modelLimit)
  const limitDeferredJobs = pendingJobs.slice(modelLimit)
  const estimator = await createSummaryBudgetEstimator({ opts, resolved })
  if (estimator.maxBudgetUsd === null) {
    return {
      selectedPendingJobs: limitedPendingJobs,
      deferredPendingJobs: limitDeferredJobs,
      summaryBudget: estimator.estimate([...reusedJobs, ...pendingJobs])
    }
  }

  const baselineIds = baselineTargetIdSet(opts)
  const spentJobs = (reusedJobs || []).filter(job => job && job.targetId && !baselineIds.has(String(job.targetId)))
  const spentBudgetUsd = estimator.costUsd(spentJobs)
  const remainingBudgetUsd = Math.max(0, estimator.maxBudgetUsd - spentBudgetUsd)
  const selectedPendingJobs = []
  const budgetDeferredJobs = []
  let selectedBudgetUsd = 0
  let budgetDeferredUsd = 0
  for (const job of limitedPendingJobs) {
    const nextCost = estimator.costUsd([job])
    if (selectedPendingJobs.length > 0 && selectedBudgetUsd + nextCost > remainingBudgetUsd) {
      budgetDeferredJobs.push(job)
      budgetDeferredUsd += nextCost
      continue
    }
    if (selectedPendingJobs.length === 0 && nextCost > remainingBudgetUsd) {
      budgetDeferredJobs.push(job)
      budgetDeferredUsd += nextCost
      continue
    }
    selectedPendingJobs.push(job)
    selectedBudgetUsd += nextCost
  }

  const deferredPendingJobs = [...budgetDeferredJobs, ...limitDeferredJobs]
  const limitDeferredUsd = estimator.costUsd(limitDeferredJobs)
  const pendingEstimateBudget = estimator.estimate([...spentJobs, ...pendingJobs], {
    status: budgetDeferredJobs.length
      ? selectedPendingJobs.length ? 'budget_limited' : 'over_budget'
      : 'ok',
    spentBudgetUsd,
    remainingBudgetUsd,
    selectedBudgetUsd,
    deferredBudgetUsd: budgetDeferredUsd + limitDeferredUsd,
    selectedTargetCount: selectedPendingJobs.length,
    deferredTargetCount: deferredPendingJobs.length,
    pendingTargetCount: pendingJobs.length
  })

  return {
    selectedPendingJobs,
    deferredPendingJobs,
    summaryBudget: pendingEstimateBudget
  }
}

const summaryReasoningEffort = opts => {
  const value = opts.summaryReasoningEffort || DEFAULT_SUMMARY_REASONING_EFFORT
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized === 'none' || normalized === 'off') return ''
  return normalized
}

const summaryProvider = opts => {
  const key = providerKey(opts.summaryProvider || DEFAULT_SUMMARY_PROVIDER)
  if (key === 'openaicodexresponses' || key === 'codexresponses' || key === 'codex') {
    const selected = chooseCodexModel({
      model: opts.summaryModel,
      codexHome: opts.codexHome
    })
    const reasoningEffort = summaryReasoningEffort(opts)
    return {
      providerName: 'openai-codex-responses',
      observerName: 'openai-responses',
      model: selected.model,
      reasoningEffort,
      modelSource: selected.cache.file,
      modelCache: {
        fetchedAt: selected.cache.fetchedAt,
        clientVersion: selected.cache.clientVersion
      },
      provider: new OpenAICodexResponsesProvider({
        model: selected.model,
        codexHome: opts.codexHome,
        originator: 'session-indexer'
      }),
      callOptions: {
        model: selected.model,
        sessionId: opts.summarySessionId,
        prompt_cache_key: opts.promptCacheKey,
        reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
        textVerbosity: 'low'
      }
    }
  }
  if (key === 'claudecli' || key === 'anthropiccli' || key === 'claude' || key === 'anthropic') {
    // Concrete, models.dev-resolvable id — see ClaudeCliProvider DEFAULT_MODEL.
    const model = opts.summaryModel || process.env.SESSION_INDEXER_SUMMARY_MODEL || process.env.CLAUDE_CLI_MODEL || 'claude-haiku-4-5'
    return {
      providerName: 'claude-cli',
      observerName: 'chat',
      model,
      modelSource: 'claude -p',
      provider: new ClaudeCliProvider({
        model,
        command: opts.claudeCliPath,
        cwd: opts.claudeCliCwd || process.cwd(),
        maxBudgetUsd: opts.claudeCliMaxBudgetUsd
      }),
      callOptions: {
        model
      }
    }
  }
  if (key === 'bedrockanthropic' || key === 'bedrock') {
    const model = opts.summaryModel || process.env.SESSION_INDEXER_SUMMARY_MODEL || 'us.anthropic.claude-opus-4-7'
    return {
      providerName: 'bedrock-anthropic',
      observerName: 'anthropic',
      model,
      modelSource: 'summary-model option',
      provider: new BedrockAnthropicProvider({
        model,
        region: opts.summaryRegion,
        cwd: opts.bedrockCwd || process.cwd()
      }),
      callOptions: {
        model,
        stream: true,
        max_tokens: opts.summaryMaxOutputTokens || 320
      }
    }
  }
  if (key === 'claudeplatformawsbatch' || key === 'anthropicawsbatch' || key === 'claudeawsbatch' || key === 'awsclaudebatch') {
    const model = opts.summaryModel || process.env.SESSION_INDEXER_SUMMARY_MODEL || 'claude-haiku-4-5'
    return {
      providerName: 'claude-platform-aws-batch',
      observerName: 'anthropic',
      model,
      modelSource: 'Claude Platform on AWS summary-model option',
      batch: true,
      provider: new ClaudePlatformAwsBatchProvider({
        model,
        region: opts.summaryRegion,
        workspaceId: opts.anthropicAwsWorkspaceId,
        awsProfile: opts.awsProfile
      }),
      callOptions: {
        model,
        maxTokens: opts.summaryMaxOutputTokens || 320
      }
    }
  }
  throw new Error(`unsupported summary provider: ${opts.summaryProvider}`)
}

const observeSummary = async ({ response, observerName, model }) => new Promise((resolve, reject) => {
  let final
  providerObserver(observerName, response, model, () => false).subscribe({
    next: value => {
      if (value && value.message) final = value
    },
    error: reject,
    complete: () => resolve({
      text: compactText(final && final.message && final.message.content),
      usage: normalizeUsage(final && final.usage)
    })
  })
})

const nodeBreadcrumb = node => {
  if (node.breadcrumb) return node.breadcrumb
  const parts = String(node.handle || '').split('/')
  return decodeURIComponent(parts[parts.length - 1] || node.title || node.kind || 'node')
}

const collectLeafRaw = (node, out = []) => {
  if (!isModelVisibleNode(node)) return out
  if (!node.children || !node.children.length) {
    out.push(node.raw || '')
    return out
  }
  for (const child of modelVisibleChildren(node.children)) collectLeafRaw(child, out)
  return out
}

const nodeRawText = node => collectLeafRaw(node).join('\n')

const truncateSource = (text, maxChars) => {
  const value = String(text || '')
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 64))}\n[truncated ${value.length - maxChars + 64} chars]`
}

const SUMMARY_SOURCE_EVENT_TYPES = new Set(['message', 'tool_call', 'tool_result'])
const SYNTHETIC_HARNESS_MARKER = /<(?:recommended_plugins|environment_context|permissions instructions|collaboration_mode|multi_agent_mode|skills_instructions|apps_instructions|plugins_instructions)(?:\s[^>]*)?>/i

const summarySourceEventType = child => child && child.meta && child.meta.type || child && child.kind

const isSyntheticHarnessMessage = child => {
  if (summarySourceEventType(child) !== 'message' || child.meta && child.meta.role !== 'user') return false
  const source = child.meta && child.meta.source || {}
  return source.outerType === 'response_item' &&
    source.payloadType === 'message' &&
    SYNTHETIC_HARNESS_MARKER.test(nodeRawText(child))
}

const isLevelOneSummarySource = child => {
  const type = summarySourceEventType(child)
  if (!SUMMARY_SOURCE_EVENT_TYPES.has(type)) return false
  if (type === 'message') {
    const role = child.meta && child.meta.role
    return (role === 'user' || role === 'assistant') && !isSyntheticHarnessMessage(child)
  }
  return true
}

const levelOneSummarySources = children => modelVisibleChildren(children).filter(isLevelOneSummarySource)

const parseJsonValue = value => {
  const text = String(value || '').trim()
  if (!text || (text[0] !== '{' && text[0] !== '[')) return undefined
  try {
    return JSON.parse(text)
  } catch (_err) {
    return undefined
  }
}

const summaryTextRecords = values => {
  const records = []
  const seen = new Set()
  for (const value of values || []) {
    if (!value || typeof value !== 'object') continue
    const text = String(value.text || '').trim()
    if (!text) continue
    const line = value.line === undefined || value.line === null || value.line === ''
      ? undefined
      : value.line
    const key = `${line === undefined ? '' : String(line)}\n${text}`
    if (seen.has(key)) continue
    seen.add(key)
    records.push({ text })
  }
  return records
}

const compactSessionIndexerSummaryResult = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.schema === 'session-indexer.search.v1') {
    return summaryTextRecords(value.hits)
  }
  if (value.schema === 'session-indexer.browse.v1') {
    return summaryTextRecords([value, ...(Array.isArray(value.children) ? value.children : [])])
  }
  if (value.schema === 'session-indexer.openLink.v1') {
    return {
      content: String(value.content || ''),
      isVerbatim: Boolean(value.isVerbatim),
      omittedTokenCount: Number(value.omittedTokenCount || 0)
    }
  }
  return null
}

const canonicalizeMcpCallToolResult = value => {
  if (typeof value === 'string') {
    const parsed = parseJsonValue(value)
    if (parsed === undefined) return { value, changed: false }
    const nested = canonicalizeMcpCallToolResult(parsed)
    return nested.changed
      ? { value: stableStringify(nested.value), changed: true }
      : { value, changed: false }
  }
  if (Array.isArray(value)) {
    let changed = false
    const items = value.map(item => {
      const nested = canonicalizeMcpCallToolResult(item)
      changed = changed || nested.changed
      return nested.value
    })
    return { value: changed ? items : value, changed }
  }
  if (!value || typeof value !== 'object') return { value, changed: false }

  const retrieval = compactSessionIndexerSummaryResult(value)
  if (retrieval !== null) return { value: retrieval, changed: true }

  if (Array.isArray(value.content) && value.structuredContent !== undefined) {
    const payload = value.structuredContent &&
      typeof value.structuredContent === 'object' &&
      !Array.isArray(value.structuredContent) &&
      Object.hasOwn(value.structuredContent, 'result')
      ? value.structuredContent.result
      : value.structuredContent
    const structured = canonicalizeMcpCallToolResult(payload)
    let canonical = structured.value
    if (value.isError === true) {
      canonical = canonical && typeof canonical === 'object' && !Array.isArray(canonical)
        ? { ...canonical, isError: true }
        : { result: canonical, isError: true }
    }
    return { value: canonical, changed: true }
  }

  let changed = false
  const canonical = {}
  for (const [key, item] of Object.entries(value)) {
    const nested = canonicalizeMcpCallToolResult(item)
    changed = changed || nested.changed
    canonical[key] = nested.value
  }
  return { value: changed ? canonical : value, changed }
}

const levelOneSourceText = (child, maxChars) => {
  const raw = nodeRawText(child)
  const type = summarySourceEventType(child)
  if (type === 'tool_call') {
    const parsed = parseJsonValue(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return truncateSource(raw, maxChars)
    return truncateSource(stableStringify({
      name: parsed.name || child.meta && child.meta.toolName,
      arguments: parsed.arguments
    }), maxChars)
  }
  if (type !== 'tool_result') return truncateSource(raw, maxChars)
  const parsed = parseJsonValue(raw)
  if (parsed === undefined) return truncateSource(raw, maxChars)
  const canonical = canonicalizeMcpCallToolResult(parsed)
  return truncateSource(canonical.changed ? stableStringify(canonical.value) : raw, maxChars)
}

const childRecord = (child, maxChildChars, opts = {}) => {
  if (opts.includeRawSource) {
    const type = summarySourceEventType(child)
    const record = {}
    if (type === 'message') record.role = child.meta && child.meta.role
    if (type === 'tool_call' || type === 'tool_result') {
      record.tool_role = type === 'tool_call' ? 'call' : 'result'
      if (child.meta && child.meta.toolName) record.tool_name = child.meta.toolName
      if (child.meta && child.meta.callId) record.tool_call_id = child.meta.callId
    }
    record.source_text = levelOneSourceText(child, opts.maxSourceChars || maxChildChars)
    return record
  }
  const meta = child.meta || {}
  const startAt = meta.startAt || meta.at
  const endAt = meta.endAt || meta.at
  const startMs = Date.parse(startAt || '')
  const endMs = Date.parse(endAt || '')
  const record = {
    summary: child.head || '',
    token_count: Number(child.fullTokenCount || 0),
    start_at: startAt,
    end_at: endAt,
    duration_ms: Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : undefined
  }
  for (const key of Object.keys(record)) {
    if (record[key] === undefined || record[key] === '') delete record[key]
  }
  return record
}

const previousSummaryRecord = maintenanceBase => {
  if (!maintenanceBase) return null
  const record = {
    summary: summaryRecordFromJob(maintenanceBase).summary,
    token_count: Number(maintenanceBase.fullTokenCount || 0),
    start_at: maintenanceBase.startAt,
    end_at: maintenanceBase.endAt,
    duration_ms: maintenanceBase.durationMs
  }
  for (const key of Object.keys(record)) {
    if (record[key] === undefined || record[key] === '') delete record[key]
  }
  return record.summary ? record : null
}

const makePrompt = ({ node, maxChildChars, inputTokenBudget, maintenanceBase, deltaChildren, promptPlan }) => {
  const includeRawSource = node.meta && node.meta.summaryLevel === 1
  const maxSourceChars = Math.max(maxChildChars, (inputTokenBudget || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET) * 4)
  const children = includeRawSource
    ? levelOneSummarySources(node.children)
    : Array.isArray(deltaChildren)
      ? deltaChildren
      : modelVisibleChildren(node.children)
  const childLines = children.map(child => JSON.stringify(childRecord(child, maxChildChars, {
    includeRawSource,
    maxSourceChars
  })))
  if (includeRawSource) {
    return [
      'Transcript records (JSONL):',
      ...childLines
    ].join('\n')
  }
  if (!promptPlan || promptPlan.action !== 'update') {
    return [
      'Complete ordered child summaries (JSONL):',
      ...childLines
    ].join('\n')
  }
  const existing = previousSummaryRecord(maintenanceBase)
  if (!existing) throw new Error(`parent update prompt requires an existing summary: ${node.handle}`)
  return [
    'Existing summary to revise:',
    JSON.stringify(existing),
    '',
    `Child-summary update: ${JSON.stringify({
      kind: promptPlan.updateKind,
      unchanged_child_count: promptPlan.unchangedChildCount,
      previous_child_count: promptPlan.previousChildCount,
      current_child_count: promptPlan.currentChildCount
    })}`,
    '',
    'New or replacement child-summary suffix (JSONL):',
    ...childLines
  ].join('\n')
}

const childInputTokenCost = child => {
  if (child && child.kind === 'summary_span') {
    return Math.max(1, estimateTokens([
      child.breadcrumb,
      child.head,
      topicsText(child.topics || [])
    ].filter(Boolean).join('\n')))
  }
  return Math.max(1, Number(child.fullTokenCount || child.renderedTokenCount || estimateTokens(child.head || child.raw || child.title)))
}

const TOOL_PAIR_EXTENSION_MAX_MULTIPLIER = Number(process.env.SESSION_INDEXER_TOOL_PAIR_EXTENSION_MAX_MULTIPLIER || 2)

const toolPairExtensionHardBudget = budget => {
  const multiplier = Number.isFinite(TOOL_PAIR_EXTENSION_MAX_MULTIPLIER) && TOOL_PAIR_EXTENSION_MAX_MULTIPLIER >= 1
    ? TOOL_PAIR_EXTENSION_MAX_MULTIPLIER
    : 2
  return Math.max(budget, Math.floor(budget * multiplier))
}

const toolPairInfo = child => {
  const type = child && child.meta && child.meta.type
  const callId = child && child.meta && child.meta.callId
  if (!callId || (type !== 'tool_call' && type !== 'tool_result')) return null
  return { type, callId }
}

const pendingToolCallsInRange = (children, start, end) => {
  const pending = new Map()
  for (let index = start; index <= end; index += 1) {
    const info = toolPairInfo(children[index])
    if (!info) continue
    if (info.type === 'tool_call') pending.set(info.callId, index)
    if (info.type === 'tool_result') pending.delete(info.callId)
  }
  return {
    ids: new Set(pending.keys()),
    earliestIndex: pending.size ? Math.min(...pending.values()) : -1
  }
}

const trailingPendingToolBlockInRange = (children, start, end, pendingIds) => {
  const calls = new Map()
  const results = new Set()
  for (let index = end; index >= start; index -= 1) {
    const info = toolPairInfo(children[index])
    if (!info) break
    if (info.type === 'tool_result') results.add(info.callId)
    if (info.type === 'tool_call' && pendingIds.has(info.callId) && !results.has(info.callId)) calls.set(info.callId, index)
  }
  return {
    ids: new Set(calls.keys()),
    earliestIndex: calls.size ? Math.min(...calls.values()) : -1
  }
}

const extendUntilToolResults = ({ children, start, pendingIds, inputTokenCount }) => {
  const remaining = new Set(pendingIds)
  let end = start - 1
  let tokens = inputTokenCount
  for (let index = start; index < children.length && remaining.size; index += 1) {
    tokens += childInputTokenCost(children[index])
    end = index
    const info = toolPairInfo(children[index])
    if (info && info.type === 'tool_result') remaining.delete(info.callId)
  }
  return {
    foundAll: remaining.size === 0,
    end,
    inputTokenCount: tokens
  }
}

const tokenCountForRange = (children, start, end) => {
  let tokens = 0
  for (let index = start; index <= end; index += 1) tokens += childInputTokenCost(children[index])
  return tokens
}

const maybeExtendToolBoundary = ({ children, start, end, inputTokenCount, budget }) => {
  const pending = pendingToolCallsInRange(children, start, end)
  if (!pending.ids.size || end + 1 >= children.length) return { end, inputTokenCount }

  const hardBudget = toolPairExtensionHardBudget(budget)
  const candidates = [pending]
  const trailing = trailingPendingToolBlockInRange(children, start, end, pending.ids)
  if (trailing.ids.size && trailing.ids.size !== pending.ids.size) candidates.push(trailing)

  for (const candidate of candidates) {
    const extended = extendUntilToolResults({
      children,
      start: end + 1,
      pendingIds: candidate.ids,
      inputTokenCount
    })
    if (extended.foundAll && extended.inputTokenCount <= hardBudget) {
      return {
        end: extended.end,
        inputTokenCount: extended.inputTokenCount
      }
    }
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (candidate.earliestIndex > start) {
      const backedUpEnd = candidate.earliestIndex - 1
      return {
        end: backedUpEnd,
        inputTokenCount: tokenCountForRange(children, start, backedUpEnd)
      }
    }
  }

  return { end, inputTokenCount }
}

const groupByInputTokenBudget = (children, inputTokenBudget) => {
  const list = children || []
  const budget = Math.max(1, Number(inputTokenBudget || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET))
  const groups = []
  for (let start = 0; start < list.length;) {
    let end = start
    let tokens = childInputTokenCost(list[end])
    while (end + 1 < list.length) {
      const nextCost = childInputTokenCost(list[end + 1])
      if (tokens + nextCost > budget) break
      end += 1
      tokens += nextCost
    }

    for (;;) {
      const previousEnd = end
      const bounded = maybeExtendToolBoundary({
        children: list,
        start,
        end,
        inputTokenCount: tokens,
        budget
      })
      if (bounded.end === end) {
        tokens = bounded.inputTokenCount
        break
      }
      end = bounded.end
      tokens = bounded.inputTokenCount
      if (bounded.end < previousEnd) break
    }

    groups.push({
      children: list.slice(start, end + 1),
      inputTokenCount: tokens
    })
    start = end + 1
  }
  return groups
}

const sourceFingerprint = child => {
  if (child && child.kind === 'summary_span') {
    return [
      child.handle,
      child.summaryModel || '',
      child.summaryMeta && child.summaryMeta.targetMaterialHash || '',
      child.breadcrumb || '',
      child.head || '',
      stableStringify(child.topics || [])
    ].join(':')
  }
  return [
    child.handle,
    child.fullTokenCount || 0,
    hashString(nodeRawText(child) || child.raw || child.head || child.title || '')
  ].join(':')
}

const sourceHashForChildren = children => hashString((children || []).map(sourceFingerprint).join('\n'))

const summaryLineageHandle = handle => String(handle || '').replace(
  /(\/summary\/level-\d+\/span-\d{4})(?:-[^/]+)?$/,
  '$1'
)

const childRevisionHashesForNode = node => (node.children || []).map(child => hashString(sourceFingerprint(child)))

const sourceGroupHashForNode = node => sourceHashForChildren(node.children || [])

const completedAtMs = job => {
  const value = Date.parse(job && (job.completedAt || job.generatedAt) || '')
  return Number.isFinite(value) ? value : 0
}

const jobPromptMatchesNode = (job, node) => {
  if (!job || !node) return false
  if (!job.promptHash && summaryLevelForNode(node) > 1) return false
  if (job.promptHash && !summaryPromptHashesForNode(node).has(job.promptHash)) return false
  const currentSourceHash = sourceGroupHashForNode(node)
  if (job.sourceGroupHash) return job.sourceGroupHash === currentSourceHash
  const currentRevisions = childRevisionHashesForNode(node)
  if (Array.isArray(job.childRevisionHashes) && job.childRevisionHashes.length) {
    return stableStringify(job.childRevisionHashes) === stableStringify(currentRevisions)
  }
  // Legacy span handles contained a hash of their child handles. They remain
  // safe to reuse for an unchanged non-root span, but a session root has always
  // had a stable handle and therefore needs revision evidence.
  return node.kind !== 'session' && summaryLineageHandle(job.handle) === node.handle
}

const maintenanceBaseForNode = ({ node, previousSummaryJobs }) => {
  if (summaryLevelForNode(node) <= 1) return null
  const lineage = summaryLineageHandle(node.handle)
  const currentSourceHash = sourceGroupHashForNode(node)
  const candidates = (previousSummaryJobs || [])
    .filter(job => hasReusableSummary(job))
    .filter(job => summaryLineageHandle(job.handle) === lineage)
    .filter(job => !job.sourceGroupHash || job.sourceGroupHash !== currentSourceHash)
    .sort((a, b) => completedAtMs(b) - completedAtMs(a))
  return candidates[0] || null
}

const summaryPromptPlanForNode = ({ node, maintenanceBase }) => {
  const children = modelVisibleChildren(node.children)
  if (summaryLevelForNode(node) <= 1) {
    return {
      action: 'leaf',
      children,
      currentChildCount: children.length
    }
  }
  const create = reason => ({
    action: 'create',
    reason,
    children,
    previousChildCount: Array.isArray(maintenanceBase && maintenanceBase.childRevisionHashes)
      ? maintenanceBase.childRevisionHashes.length
      : 0,
    currentChildCount: children.length
  })
  if (!maintenanceBase) return create('new_parent')
  const previous = Array.isArray(maintenanceBase.childRevisionHashes)
    ? maintenanceBase.childRevisionHashes
    : []
  const current = childRevisionHashesForNode(node)
  if (!previous.length) return create('missing_revision_lineage')
  if (current.length < previous.length) return create('child_sequence_shrank')
  let firstChanged = 0
  while (
    firstChanged < previous.length &&
    firstChanged < current.length &&
    previous[firstChanged] === current[firstChanged]
  ) firstChanged += 1
  if (firstChanged === current.length && previous.length === current.length) {
    return create('unchanged_target_not_reusable')
  }
  return {
    action: 'update',
    updateKind: firstChanged === previous.length ? 'append' : 'replace_suffix',
    children: children.slice(firstChanged),
    unchangedChildCount: firstChanged,
    previousChildCount: previous.length,
    currentChildCount: current.length
  }
}

const nodeJobMetadata = node => {
  const meta = node.meta || {}
  const startAt = meta.startAt || meta.at
  const endAt = meta.endAt || meta.at
  const startMs = Date.parse(startAt || '')
  const endMs = Date.parse(endAt || '')
  return {
    summaryLevel: summaryLevelForNode(node),
    spanIndex: node.kind === 'session' ? 0 : Number(meta.spanIndex || 0),
    lineageHandle: summaryLineageHandle(node.handle),
    sourceGroupHash: sourceGroupHashForNode(node),
    childStartHandle: node.children[0] && node.children[0].handle,
    childEndHandle: node.children[node.children.length - 1] && node.children[node.children.length - 1].handle,
    childHandles: node.children.map(child => child.handle),
    childRevisionHashes: childRevisionHashesForNode(node),
    fullTokenCount: Number(node.fullTokenCount || 0),
    startAt,
    endAt,
    durationMs: Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : undefined
  }
}

const summaryNodesUnder = (node, out = []) => {
  if (!node) return out
  if (node.kind === 'summary_span') out.push(node)
  for (const child of node.children || []) summaryNodesUnder(child, out)
  return out
}

const modelSummaryIsUsable = node => {
  const meta = node && node.summaryMeta || {}
  const head = compactText(node && node.head)
  return node &&
    node.kind === 'summary_span' &&
    meta.status === 'completed' &&
    head &&
    !/^pending summary\b/i.test(head)
}

const rootSummaryIsUsable = node => {
  const meta = node && node.summaryMeta || {}
  const head = compactText(node && node.head)
  return node &&
    node.kind === 'session' &&
    meta.status === 'completed' &&
    meta.strategy === ROOT_SUMMARY_STRATEGY &&
    head &&
    !/^pending summary\b/i.test(head)
}

const topSummaryNodes = tree => (tree.root.children || []).filter(node => node.kind === 'summary_span')

const clearRootModelSummary = tree => {
  tree.root.breadcrumb = ''
  tree.root.topics = []
  delete tree.root.summaryModel
  delete tree.root.summaryMeta
}

const createSummaryParents = ({ tree, children, level, inputTokenBudget }) => {
  const groups = groupByInputTokenBudget(children, inputTokenBudget)
  if (groups.length >= children.length) return []
  return groups.map((group, index) => {
    const sourceGroupHash = sourceHashForChildren(group.children)
    const node = createSummaryNode({
      tree,
      level,
      index,
      children: group.children,
      meta: {
        source: 'summary-rollup',
        sourceGroupHash,
        inputTokenBudget,
        inputTokenCount: group.inputTokenCount,
        strategy: SPAN_SUMMARY_STRATEGY
      }
    })
    node.summaryMeta = {
      strategy: SPAN_SUMMARY_STRATEGY,
      status: 'pending',
      summaryLevel: level,
      inputTokenBudget,
      inputTokenCount: group.inputTokenCount
    }
    return node
  })
}

const prepareRollupSummaryLayers = (tree, opts = {}) => {
  const inputTokenBudget = opts.summaryInputTokenBudget || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET
  let top = topSummaryNodes(tree)
  while (top.length > 1 && top.every(modelSummaryIsUsable)) {
    const highestLevel = Math.max(...top.map(node => Number(node.meta && node.meta.summaryLevel || 1)))
    const parents = createSummaryParents({
      tree,
      children: top,
      level: highestLevel + 1,
      inputTokenBudget
    })
    if (!parents.length) break
    tree.root.children = parents
    tree.root.head = `${tree.root.title} compacted transcript hierarchy level ${highestLevel + 1} with ${parents.length} summary spans`
    clearRootModelSummary(tree)
    rebuildTreeIndex(tree)
    if (opts.previousSummaryJobs) applyStoredSummaryJobs(tree, opts.previousSummaryJobs)
    top = topSummaryNodes(tree)
  }
  return summaryNodesUnder(tree.root)
}

const proactiveTailSpan = tree => {
  const children = tree.root.children || []
  let boundaryIndex = -1
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]
    if (child.kind === 'compaction' || child.meta && child.meta.type === 'compaction') {
      boundaryIndex = index
      break
    }
  }
  const tail = levelOneSummarySources(children.slice(boundaryIndex + 1))
  if (!tail.length) return null
  return {
    index: -1,
    startIndex: boundaryIndex + 1,
    endIndex: children.length - 1,
    boundaryIndex: undefined,
    boundaryHandle: 'proactive-tail',
    children: tail,
    proactive: true
  }
}

const readyGroupsForSpan = ({ span, inputTokenBudget }) => {
  const groups = groupByInputTokenBudget(levelOneSummarySources(span.children), inputTokenBudget)
  if (!span.proactive || !groups.length) return groups
  return groups.filter((group, index) =>
    index < groups.length - 1 || Number(group.inputTokenCount || 0) >= Number(inputTokenBudget || 0))
}

const prepareCompactedSummaryLayer = (tree, opts = {}) => {
  if ((tree.root.children || []).some(node => node.kind === 'summary_span')) {
    return {
      status: 'prepared',
      nodes: prepareRollupSummaryLayers(tree, opts),
      compactedSpanCount: undefined,
      compactedInputTokenCount: undefined
    }
  }
  const inputTokenBudget = opts.summaryInputTokenBudget || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET
  const compactedSpans = compactedEventSpans(tree)
  const tailSpan = proactiveTailSpan(tree)
  const plannedSpans = tailSpan ? [...compactedSpans, tailSpan] : compactedSpans
  const summaryNodes = []
  for (const span of plannedSpans) {
    const spanChildren = levelOneSummarySources(span.children)
    if (!spanChildren.length) continue
    const sourceSpanHash = sourceHashForChildren(spanChildren)
    for (const group of readyGroupsForSpan({ span, inputTokenBudget })) {
      const sourceGroupHash = sourceHashForChildren(group.children)
      const node = createSummaryNode({
        tree,
        level: 1,
        index: summaryNodes.length,
        children: group.children,
        meta: {
          source: span.proactive ? 'proactive-transcript-tail' : 'compacted-transcript',
          compactionBoundaryHandle: span.boundaryHandle,
          compactedSpanIndex: span.index,
          spanStartIndex: span.startIndex,
          spanEndIndex: span.endIndex,
          boundaryIndex: span.boundaryIndex,
          sourceSpanHash,
          sourceGroupHash,
          inputTokenBudget,
          inputTokenCount: group.inputTokenCount,
          strategy: SPAN_SUMMARY_STRATEGY
        }
      })
      node.summaryMeta = {
        strategy: SPAN_SUMMARY_STRATEGY,
        status: 'pending',
        summaryLevel: 1,
        inputTokenBudget,
        inputTokenCount: group.inputTokenCount
      }
      summaryNodes.push(node)
    }
  }
  tree.root.children = summaryNodes
  tree.root.head = summaryNodes.length
    ? `${tree.root.title} compacted transcript hierarchy with ${summaryNodes.length} summary spans`
    : `${tree.root.title} has no compacted transcript span yet`
  clearRootModelSummary(tree)
  rebuildTreeIndex(tree)
  if (opts.previousSummaryJobs) applyStoredSummaryJobs(tree, opts.previousSummaryJobs)
  const nodes = prepareRollupSummaryLayers(tree, opts)
  return {
    status: summaryNodes.length ? 'prepared' : 'no_compaction',
    nodes,
    compactedSpanCount: compactedSpans.length,
    compactedInputTokenCount: summaryNodes
      .filter(node => node.meta && node.meta.summaryLevel === 1)
      .reduce((sum, node) => sum + Number(node.meta && node.meta.inputTokenCount || 0), 0)
  }
}

const summaryStrategyForNode = node => node && node.kind === 'session'
  ? ROOT_SUMMARY_STRATEGY
  : SPAN_SUMMARY_STRATEGY

const rootNeedsSummary = tree => {
  const top = topSummaryNodes(tree)
  return top.length > 0 &&
    top.every(modelSummaryIsUsable) &&
    !rootSummaryIsUsable(tree.root)
}

const candidateSummaryNodes = ({ tree, prepared }) => {
  const nodes = prepared.nodes.filter(node => node.children.length)
  if (rootNeedsSummary(tree)) nodes.push(tree.root)
  return nodes
}

const summaryTargetMaterial = ({
  node,
  childHash,
  resolved,
  maxChildChars,
  inputTokenBudget,
  strategy,
  promptHash,
  promptAction,
  updateKind,
  maintenanceBaseTargetId,
  deltaChildRevisionHashes
}) => ({
  schema: SUMMARY_TARGET_SCHEMA,
  strategy,
  nodeHandle: node.handle,
  sourceGroupHash: sourceGroupHashForNode(node),
  promptHash,
  promptAction,
  updateKind: updateKind || '',
  childHash,
  maintenanceBaseTargetId: maintenanceBaseTargetId || '',
  deltaChildRevisionHashes: deltaChildRevisionHashes || [],
  provider: resolved.providerName,
  model: resolved.model,
  reasoningEffort: resolved.reasoningEffort || '',
  maxChildChars,
  inputTokenBudget,
  maxOutputTokens: resolved.callOptions && (resolved.callOptions.maxTokens || resolved.callOptions.max_tokens || resolved.callOptions.max_output_tokens)
})

const parseSummary = (text, node) => {
  const raw = String(text || '').trim()
  if (!raw) return { breadcrumb: '', summary: '', topics: [] }
  if (/^[\[{]/.test(raw)) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`summary model returned malformed serialized output: ${err.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.summary !== 'string') {
      throw new Error('summary model returned unsupported serialized output')
    }
    const summary = compactText(parsed.summary || '')
    if (summaryLooksLikeSerializedJson(summary)) {
      throw new Error('summary model returned invalid summary: summary field contains serialized JSON')
    }
    return {
      breadcrumb: compactText(parsed.breadcrumb || ''),
      summary,
      topics: normalizeTopics(parsed.topics, { max: 8, maxChars: 220 })
    }
  }
  return {
    breadcrumb: node ? compactText(nodeBreadcrumb(node)) : '',
    summary: compactText(raw),
    topics: []
  }
}

const assertSummaryHasBody = (parsed, text) => {
  if (parsed && compactText(parsed.summary)) return parsed
  throw new Error('summary model returned an empty response')
}

const summaryLooksLikeSerializedJson = text => {
  const raw = compactText(text || '')
  if (!raw) return false
  if (!/^[\[{]/.test(raw)) return false
  try {
    JSON.parse(raw)
    return true
  } catch (_err) {
    return /"breadcrumb"\s*:|"summary"\s*:|"topics"\s*:/.test(raw)
  }
}

const emitProgress = (opts, event) => {
  if (typeof opts.onProgress !== 'function') return
  try {
    opts.onProgress({
      at: new Date().toISOString(),
      ...event
    })
  } catch (_err) {}
}

const markSummaryError = ({ node, internalJob, error, mode, resolved }) => {
  const message = compactText(error && error.message || error || 'summary failed')
  if (node) {
    node.summaryModel = resolved.model
    node.summaryMeta = {
      ...(node.summaryMeta || {}),
      mode,
      provider: resolved.providerName,
      model: resolved.model,
      modelSource: resolved.modelSource,
      modelCache: resolved.modelCache,
      reasoningEffort: resolved.reasoningEffort,
      promptHash: internalJob.promptHash,
      promptAction: internalJob.promptAction,
      updateKind: internalJob.updateKind,
      childHash: internalJob.childHash,
      customId: internalJob.customId,
      targetId: internalJob.targetId,
      targetMaterialHash: internalJob.targetMaterialHash,
      strategy: internalJob.strategy || SPAN_SUMMARY_STRATEGY,
      summaryLevel: internalJob.summaryLevel || summaryLevelForNode(node),
      sourceGroupHash: internalJob.sourceGroupHash,
      childRevisionHashes: internalJob.childRevisionHashes,
      inputTokenBudget: internalJob.inputTokenBudget,
      inputTokenCount: internalJob.inputTokenCount,
      status: 'error',
      error: message,
      generatedAt: new Date().toISOString()
    }
  }
  return {
    ...publicJob(internalJob),
    status: 'error',
    resultType: 'failed',
    error: message,
    completedAt: new Date().toISOString(),
    usage: normalizeUsage()
  }
}

const innerNodesBottomUp = root => {
  const out = []
  const visit = node => {
    for (const child of node.children) visit(child)
    if (node.children.length) out.push(node)
  }
  visit(root)
  return out
}

const nodeJobs = ({ nodes, maxChildChars, inputTokenBudget, resolved, previousSummaryJobs }) => nodes.map(node => {
  const metadata = nodeJobMetadata(node)
  const exact = node.summaryMeta && node.summaryMeta.targetId
    ? (previousSummaryJobs || []).find(job =>
        job.targetId === node.summaryMeta.targetId && jobPromptMatchesNode(job, node))
    : null
  if (exact) {
    const promptAction = exact.promptAction || (summaryLevelForNode(node) <= 1 ? 'leaf' : 'create')
    const systemPrompt = summarySystemPromptForNode(node, promptAction)
    const promptHash = exact.promptHash || hashString(systemPrompt)
    return {
      ...metadata,
      handle: node.handle,
      customId: exact.customId || safeCustomId(`${node.handle}:${exact.childHash || exact.targetId}`),
      targetId: exact.targetId,
      targetMaterialHash: exact.targetMaterialHash,
      provider: resolved.providerName,
      model: resolved.model,
      inputChars: Number(exact.inputChars || 0),
      inputTokenBudget,
      inputTokenCount: Number(exact.inputTokenCount || 0),
      childCount: node.children.length,
      prompt: '',
      childHash: exact.childHash || '',
      promptHash,
      systemPrompt,
      promptCacheKey: `session-indexer-summary:${promptHash}`,
      promptAction,
      updateKind: exact.updateKind,
      strategy: summaryStrategyForNode(node),
      node
    }
  }
  const maintenanceBase = maintenanceBaseForNode({ node, previousSummaryJobs })
  const promptPlan = summaryPromptPlanForNode({ node, maintenanceBase })
  const systemPrompt = summarySystemPromptForNode(node, promptPlan.action)
  const promptHash = hashString(systemPrompt)
  const promptChildren = promptPlan.action === 'leaf' ? undefined : promptPlan.children
  const usedMaintenanceBase = promptPlan.action === 'update' ? maintenanceBase : null
  const prompt = makePrompt({
    node,
    maxChildChars,
    inputTokenBudget,
    maintenanceBase: usedMaintenanceBase,
    deltaChildren: promptChildren,
    promptPlan
  })
  const childHash = hashString(prompt)
  const strategy = summaryStrategyForNode(node)
  const deltaChildRevisionHashes = promptPlan.action === 'update'
    ? promptPlan.children.map(child => hashString(sourceFingerprint(child)))
    : []
  const targetMaterial = summaryTargetMaterial({
    node,
    childHash,
    resolved,
    maxChildChars,
    inputTokenBudget,
    strategy,
    promptHash,
    promptAction: promptPlan.action,
    updateKind: promptPlan.updateKind,
    maintenanceBaseTargetId: usedMaintenanceBase && usedMaintenanceBase.targetId,
    deltaChildRevisionHashes
  })
  return {
    ...metadata,
    handle: node.handle,
    customId: safeCustomId(`${node.handle}:${childHash}`),
    targetId: `summary-${hashString(stableStringify(targetMaterial)).slice(0, 32)}`,
    targetMaterialHash: hashString(stableStringify(targetMaterial)),
    provider: resolved.providerName,
    model: resolved.model,
    inputChars: prompt.length,
    inputTokenBudget,
    inputTokenCount: estimateTokens(prompt),
    childCount: node.children.length,
    prompt,
    childHash,
    promptHash,
    systemPrompt,
    promptCacheKey: `session-indexer-summary:${promptHash}`,
    promptAction: promptPlan.action,
    promptReason: promptPlan.reason,
    updateKind: promptPlan.updateKind,
    unchangedChildCount: promptPlan.unchangedChildCount,
    previousChildCount: promptPlan.previousChildCount,
    currentChildCount: promptPlan.currentChildCount,
    maintenanceBaseTargetId: usedMaintenanceBase && usedMaintenanceBase.targetId,
    deltaChildRevisionHashes,
    strategy,
    node
  }
})

const publicJob = job => {
  const {
    prompt,
    node,
    systemPrompt,
    promptCacheKey,
    ...out
  } = job
  return out
}

const summaryRecordFromJob = job => ({
  breadcrumb: compactText(job && job.breadcrumb || ''),
  summary: summaryLooksLikeSerializedJson(job && (job.summary || job.resultSummary || job.head) || '')
    ? ''
    : compactText(job && (job.summary || job.resultSummary || job.head) || ''),
  topics: Array.isArray(job && job.topics) ? job.topics : []
})

const hasReusableSummary = job => {
  if (!job || job.error) return false
  if (job.status && !['completed', 'reused'].includes(job.status)) return false
  return Boolean(summaryRecordFromJob(job).summary)
}

const applyParsedSummary = ({ node, parsed, mode, resolved, internalJob, batchId, reused = false, reusedFrom }) => {
  if (parsed.summary) node.head = parsed.summary
  if (parsed.breadcrumb) node.breadcrumb = parsed.breadcrumb
  if (parsed.topics && parsed.topics.length) node.topics = parsed.topics
  node.summaryModel = resolved.model
  node.summaryMeta = {
    mode,
    provider: resolved.providerName,
    model: resolved.model,
    modelSource: resolved.modelSource,
    modelCache: resolved.modelCache,
    reasoningEffort: resolved.reasoningEffort,
    generatedAt: reused ? reusedFrom && (reusedFrom.completedAt || reusedFrom.generatedAt) : new Date().toISOString(),
    promptHash: internalJob.promptHash,
    promptAction: internalJob.promptAction,
    updateKind: internalJob.updateKind,
    childHash: internalJob.childHash,
    customId: internalJob.customId,
    targetId: internalJob.targetId,
    targetMaterialHash: internalJob.targetMaterialHash,
    strategy: internalJob.strategy || SPAN_SUMMARY_STRATEGY,
    summaryLevel: internalJob.summaryLevel || summaryLevelForNode(node),
    sourceGroupHash: internalJob.sourceGroupHash,
    childRevisionHashes: internalJob.childRevisionHashes,
    inputTokenBudget: internalJob.inputTokenBudget,
    inputTokenCount: internalJob.inputTokenCount,
    status: 'completed',
    reused,
    batchId
  }
}

const completePublicJob = ({ internalJob, parsed, text, usage, batchId, reused = false, reusedFrom }) => ({
  ...publicJob(internalJob),
  status: 'completed',
  resultType: reused ? 'reused' : 'succeeded',
  reused,
  reusedFromTargetId: reusedFrom && reusedFrom.targetId,
  completedAt: reused
    ? reusedFrom && (reusedFrom.completedAt || reusedFrom.generatedAt)
    : new Date().toISOString(),
  batchId,
  usage: normalizeUsage(usage),
  outputChars: (parsed.summary || text || '').length,
  breadcrumb: parsed.breadcrumb || '',
  summary: parsed.summary || '',
  topics: parsed.topics || []
})

const splitReusableJobs = ({ internalJobs, previousSummaryJobs, mode, resolved }) => {
  const reusable = new Map()
  for (const job of previousSummaryJobs || []) {
    if (job.targetId && hasReusableSummary(job)) reusable.set(job.targetId, job)
  }
  const reusedJobs = []
  const pendingJobs = []
  for (const internalJob of internalJobs) {
    const cached = reusable.get(internalJob.targetId)
    if (!cached) {
      pendingJobs.push(internalJob)
      continue
    }
    const parsed = summaryRecordFromJob(cached)
    applyParsedSummary({
      node: internalJob.node,
      parsed,
      mode,
      resolved,
      internalJob,
      reused: true,
      reusedFrom: cached
    })
    reusedJobs.push(completePublicJob({
      internalJob,
      parsed,
      text: parsed.summary,
      usage: cached.usage,
      reused: true,
      reusedFrom: cached
    }))
  }
  return { reusedJobs, pendingJobs }
}

const reservePendingJobs = async ({ pendingJobs, opts, mode, resolved }) => {
  if (!opts.reserveSummaryJobs || !pendingJobs.length) {
    return {
      claimedJobs: pendingJobs,
      reusedJobs: [],
      skippedJobs: []
    }
  }
  const reservation = await opts.reserveSummaryJobs(pendingJobs.map(publicJob))
  const reusable = new Map((reservation.reusableJobs || []).map(job => [job.targetId, job]))
  const claimedIds = new Set(reservation.claimedTargetIds || [])
  const skipped = new Map((reservation.skippedJobs || []).map(job => [job.targetId, job]))
  const claimedJobs = []
  const reusedJobs = []
  const skippedJobs = []
  for (const internalJob of pendingJobs) {
    const cached = reusable.get(internalJob.targetId)
    if (cached && hasReusableSummary(cached)) {
      const parsed = summaryRecordFromJob(cached)
      applyParsedSummary({
        node: internalJob.node,
        parsed,
        mode,
        resolved,
        internalJob,
        reused: true,
        reusedFrom: cached
      })
      reusedJobs.push(completePublicJob({
        internalJob,
        parsed,
        text: parsed.summary,
        usage: cached.usage,
        reused: true,
        reusedFrom: cached
      }))
      continue
    }
    if (claimedIds.has(internalJob.targetId)) {
      claimedJobs.push(internalJob)
      continue
    }
    skippedJobs.push({
      ...publicJob(internalJob),
      status: skipped.get(internalJob.targetId) && skipped.get(internalJob.targetId).status || 'claimed_elsewhere',
      ownerId: skipped.get(internalJob.targetId) && skipped.get(internalJob.targetId).ownerId,
      claimExpiresAt: skipped.get(internalJob.targetId) && skipped.get(internalJob.targetId).claimExpiresAt
    })
  }
  return { claimedJobs, reusedJobs, skippedJobs }
}

const applyBatchResults = ({ results, jobs, mode, resolved }) => {
  const byCustomId = new Map(jobs.map(job => [job.customId, job]))
  let applied = 0
  for (const item of results || []) {
    const job = byCustomId.get(item && item.custom_id)
    if (!job) continue
    const result = item.result || {}
    job.resultType = result.type || 'unknown'
    if (result.type !== 'succeeded') {
      job.error = result.error
        ? compactText(result.error.message || result.error.error && result.error.error.message || stableStringify(result.error))
        : result.type || 'unknown'
      continue
    }
    job.usage = normalizeUsage(result.message && result.message.usage)
    const text = messageText(result.message)
    let parsed
    try {
      parsed = assertSummaryHasBody(parseSummary(text, job.node), text)
    } catch (err) {
      job.error = err.message
      job.status = 'error'
      job.completedAt = new Date().toISOString()
      markSummaryError({
        node: job.node,
        internalJob: job,
        error: err,
        mode,
        resolved
      })
      continue
    }
    applyParsedSummary({
      node: job.node,
      parsed,
      mode,
      resolved,
      internalJob: job,
      batchId: job.batchId
    })
    job.status = 'completed'
    job.outputChars = (parsed.summary || text).length
    job.breadcrumb = parsed.breadcrumb || ''
    job.summary = parsed.summary || ''
    job.topics = parsed.topics || []
    job.completedAt = new Date().toISOString()
    applied += 1
  }
  return applied
}

const markSummaryDisabled = (tree, opts = {}) => {
  const compactedSpans = compactedEventSpans(tree)
  const compactionLog = compactedSpans.map(span => {
    const spanChildren = modelVisibleChildren(span.children)
    return {
    compactionId: `compaction-${hashString(`${tree.ir.session.id}:${span.boundaryHandle}:${sourceHashForChildren(spanChildren)}`).slice(0, 24)}`,
    sessionId: tree.ir.session.id,
    spanIndex: span.index,
    boundaryHandle: span.boundaryHandle,
    boundaryIndex: span.boundaryIndex,
    spanStartIndex: span.startIndex,
    spanEndIndex: span.endIndex,
    sourceSpanHash: sourceHashForChildren(spanChildren),
    inputTokenCount: spanChildren.reduce((sum, child) => sum + Number(child.fullTokenCount || 0), 0),
    targetCount: 0,
    completedTargetCount: 0,
    pendingTargetCount: 0,
    failedTargetCount: 0,
    status: 'summary_disabled',
    targets: []
    }
  })
  const compactedInputTokenCount = compactedSpans.reduce((sum, span) => sum +
    modelVisibleChildren(span.children).reduce((childSum, child) => childSum + Number(child.fullTokenCount || 0), 0), 0)
  applyCompactionSearchScope(tree)
  const summary = {
    mode: opts.summaryMode || 'off',
    provider: null,
    model: null,
    strategy: 'summary-disabled',
    status: tree.root.children.length ? 'completed' : 'no_compaction',
    compactedSpanCount: compactedSpans.length,
    compactedInputTokenCount,
    generatedNodeCount: 0,
    candidateNodeCount: 0,
    compactionLog
  }
  for (const node of innerNodesBottomUp(tree.root)) {
    node.summaryModel = 'summary-disabled'
    node.summaryMeta = summary
  }
  return {
    summary,
    jobs: []
  }
}

const jobUsage = job => normalizeUsage(job && job.usage)

const jobAccounting = jobs => {
  const list = jobs || []
  const completed = list.filter(job => !job.error && (job.usage || job.outputChars || job.resultType === 'succeeded'))
  const plannedInputTokenCount = list.reduce((sum, job) => sum + Number(job.inputTokenCount || 0), 0)
  const completedInputTokenCount = completed.reduce((sum, job) => sum + Number(job.inputTokenCount || 0), 0)
  const estimatedOutputTokenCount = completed.reduce((sum, job) => sum + estimateTokens('x'.repeat(Number(job.outputChars || 0))), 0)
  const actualUsage = addUsage(...completed.map(jobUsage))
  const hasActualUsage = Object.values(actualUsage).some(Boolean)
  const estimatedUsage = normalizeUsage({
    input: completedInputTokenCount,
    output: estimatedOutputTokenCount,
    total: completedInputTokenCount + estimatedOutputTokenCount
  })
  return {
    plannedInputTokenCount,
    completedInputTokenCount,
    estimatedOutputTokenCount,
    actualUsage,
    estimatedUsage,
    usage: hasActualUsage ? actualUsage : estimatedUsage,
    usageBasis: hasActualUsage ? 'provider_usage' : 'estimated_from_summary_jobs',
    completedJobCount: completed.length,
    pendingJobCount: list.filter(job => !job.error && !completed.includes(job)).length,
    failedJobCount: list.filter(job => job.error).length
  }
}

const summarizeTreeFromStoredJobs = (tree, opts = {}) => {
  const jobs = (opts.previousSummaryJobs || []).filter(hasReusableSummary)
  if (!jobs.length) return null
  const inputTokenBudget = jobs.reduce((max, job) => {
    const value = Number(job && job.inputTokenBudget || 0)
    return value > max ? value : max
  }, 0) || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET
  const prepared = prepareCompactedSummaryLayer(tree, {
    summaryInputTokenBudget: inputTokenBudget,
    previousSummaryJobs: jobs
  })
  const applied = applyStoredSummaryJobs(tree, jobs)
  if (!applied) return null
  const providers = [...new Set(jobs.map(job => job.provider).filter(Boolean))]
  const models = [...new Set(jobs.map(job => job.model).filter(Boolean))]
  return {
    summary: {
      mode: opts.summaryMode || 'off',
      provider: providers.length === 1 ? providers[0] : providers.length ? 'mixed' : null,
      model: models.length === 1 ? models[0] : models.length ? 'mixed' : null,
      strategy: SPAN_SUMMARY_STRATEGY,
      execution: 'stored-summary-reuse',
      status: 'completed',
      generatedNodeCount: 0,
      reusedJobCount: applied,
      skippedJobCount: Math.max(0, jobs.length - applied),
      candidateNodeCount: prepared.nodes.length,
      compactedSpanCount: prepared.compactedSpanCount || 0,
      compactedInputTokenCount: prepared.compactedInputTokenCount || 0,
      compactionLog: compactionLogForNodes({
        tree,
        nodes: candidateSummaryNodes({ tree, prepared }),
        jobs
      }),
      ...jobAccounting(jobs)
    },
    jobs: []
  }
}

const updateSubmittedJobNodes = ({ jobs, batch, mode, resolved }) => {
  for (const job of jobs) {
    job.batchId = batch && batch.id
    if (!batch) continue
    job.node.summaryModel = resolved.model
    job.node.summaryMeta = {
      ...(job.node.summaryMeta || {}),
      mode,
      provider: resolved.providerName,
      model: resolved.model,
      modelSource: resolved.modelSource,
      reasoningEffort: resolved.reasoningEffort,
      promptHash: job.promptHash,
      promptAction: job.promptAction,
      updateKind: job.updateKind,
      childHash: job.childHash,
      customId: job.customId,
      strategy: job.strategy || SPAN_SUMMARY_STRATEGY,
      summaryLevel: job.summaryLevel || summaryLevelForNode(job.node),
      sourceGroupHash: job.sourceGroupHash,
      childRevisionHashes: job.childRevisionHashes,
      inputTokenBudget: job.inputTokenBudget,
      inputTokenCount: job.inputTokenCount,
      status: batch.processing_status === 'ended' ? 'completed' : 'submitted',
      batchId: batch.id
    }
  }
}

const targetStatus = job => {
  if (!job) return 'pending'
  if (job.error) return 'error'
  if (job.status === 'completed' || job.resultType === 'succeeded' || job.resultType === 'reused') return 'completed'
  if (job.status === 'submitted') return 'submitted'
  return job.status || 'pending'
}

const compactionLogForNodes = ({ tree, nodes, jobs }) => {
  const byHandle = new Map((jobs || []).map(job => [job.handle, job]))
  const byBoundary = new Map()
  for (const node of nodes || []) {
    const meta = node.meta || {}
    const boundaryHandle = meta.compactionBoundaryHandle || 'unknown-boundary'
    if (!byBoundary.has(boundaryHandle)) {
      byBoundary.set(boundaryHandle, {
        compactionId: `compaction-${hashString(`${tree.ir.session.id}:${boundaryHandle}:${meta.sourceSpanHash || ''}`).slice(0, 24)}`,
        sessionId: tree.ir.session.id,
        spanIndex: meta.compactedSpanIndex,
        boundaryHandle,
        boundaryIndex: meta.boundaryIndex,
        spanStartIndex: meta.spanStartIndex,
        spanEndIndex: meta.spanEndIndex,
        sourceSpanHash: meta.sourceSpanHash,
        inputTokenBudget: meta.inputTokenBudget,
        inputTokenCount: 0,
        targets: []
      })
    }
    const record = byBoundary.get(boundaryHandle)
    const job = byHandle.get(node.handle)
    record.inputTokenCount += Number(meta.inputTokenCount || job && job.inputTokenCount || 0)
    record.targets.push({
      targetId: job && job.targetId,
      handle: node.handle,
      status: targetStatus(job),
      reused: Boolean(job && job.reused),
      provider: job && job.provider,
      model: job && job.model,
      inputTokenCount: Number(meta.inputTokenCount || job && job.inputTokenCount || 0),
      sourceGroupHash: meta.sourceGroupHash,
      childStartHandle: meta.childStartHandle,
      childEndHandle: meta.childEndHandle,
      childCount: meta.childCount
    })
  }
  return [...byBoundary.values()].map(record => {
    const statuses = record.targets.map(target => target.status)
    const completed = statuses.filter(status => status === 'completed').length
    const failed = statuses.filter(status => status === 'error').length
    const pending = record.targets.length - completed - failed
    return {
      ...record,
      targetCount: record.targets.length,
      completedTargetCount: completed,
      pendingTargetCount: pending,
      failedTargetCount: failed,
      status: !record.targets.length
        ? 'empty'
        : failed
          ? 'error'
          : completed === record.targets.length
            ? 'indexed'
            : completed
              ? 'partial'
              : 'pending'
    }
  })
}

const applyStoredSummaryJobs = (tree, jobs = []) => {
  let applied = 0
  const aliases = []
  const jobLevel = job => {
    if (job && job.strategy === ROOT_SUMMARY_STRATEGY) return Number.MAX_SAFE_INTEGER
    const direct = Number(job && job.summaryLevel)
    if (Number.isFinite(direct) && direct > 0) return direct
    const match = String(job && job.handle || '').match(/\/summary\/level-(\d+)\//)
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
  }
  const ordered = [...(jobs || [])].sort((a, b) =>
    jobLevel(a) - jobLevel(b) || completedAtMs(b) - completedAtMs(a))
  for (const job of ordered) {
    if (!hasReusableSummary(job)) continue
    const lineageHandle = summaryLineageHandle(job.handle)
    const node = tree.byHandle.get(job.handle) || tree.byHandle.get(lineageHandle)
    if (!node) continue
    if (job.handle && job.handle !== node.handle) aliases.push([job.handle, node])
    if (!jobPromptMatchesNode(job, node)) continue
    if (node.summaryMeta && node.summaryMeta.status === 'completed') {
      if (node.summaryMeta.targetId === job.targetId) applied += 1
      continue
    }
    const parsed = summaryRecordFromJob(job)
    if (parsed.summary) node.head = parsed.summary
    if (parsed.breadcrumb) node.breadcrumb = parsed.breadcrumb
    if (parsed.topics.length) node.topics = parsed.topics
    node.summaryModel = job.model || node.summaryModel
    node.summaryMeta = {
      ...(node.summaryMeta || {}),
      mode: job.mode || 'model',
      provider: job.provider,
      model: job.model,
      targetId: job.targetId,
      targetMaterialHash: job.targetMaterialHash,
      childHash: job.childHash,
      customId: job.customId,
      promptHash: job.promptHash || hashString(summarySystemPromptForNode(node, job.promptAction)),
      promptAction: job.promptAction,
      updateKind: job.updateKind,
      strategy: job.strategy || SPAN_SUMMARY_STRATEGY,
      summaryLevel: job.summaryLevel || summaryLevelForNode(node),
      sourceGroupHash: job.sourceGroupHash || sourceGroupHashForNode(node),
      childRevisionHashes: job.childRevisionHashes || childRevisionHashesForNode(node),
      inputTokenBudget: job.inputTokenBudget,
      inputTokenCount: job.inputTokenCount,
      status: 'completed',
      reused: true,
      generatedAt: job.completedAt || job.generatedAt
    }
    applied += 1
  }
  rebuildTreeIndex(tree)
  for (const [alias, node] of aliases) tree.byHandle.set(alias, node)
  return applied
}

const observeSummaryWithRateLimitBackoff = async ({
  internalJob,
  jobIndex,
  opts,
  resolved,
  progress
}) => {
  const maxRetries = rateLimitMaxRetries(opts)
  let attempt = 0
  for (;;) {
    attempt += 1
    const emitRetryProgress = retry => {
      const backoffMs = Math.max(0, Number(retry.backoffMs || 0))
      emitProgress(opts, {
        phase: retry.rateLimited ? 'summary:model:rate_limited' : 'summary:model:retry',
        execution: 'chat-work-queue',
        jobIndex,
        targetId: internalJob.targetId,
        handle: internalJob.handle,
        attempt: retry.attempt || attempt,
        nextAttempt: retry.nextAttempt || attempt + 1,
        maxAttempts: retry.maxAttempts,
        backoffMs,
        retryAt: retry.retryAt || new Date(Date.now() + backoffMs).toISOString(),
        ...completionEstimate({
          startedAtMs: progress.startedAtMs,
          completedCount: progress.completedCount,
          totalCount: progress.totalCount,
          backoffMs
        }),
        error: retry.error
      })
    }
    try {
      const response = await resolved.provider.chat([
        { role: 'system', content: internalJob.systemPrompt },
        { role: 'user', content: internalJob.prompt }
      ], {
        ...resolved.callOptions,
        prompt_cache_key: internalJob.promptCacheKey,
        onRetry: emitRetryProgress
      })
      return observeSummary({
        response,
        observerName: resolved.observerName,
        model: resolved.model
      })
    } catch (error) {
      if (!isRateLimitError(error) || attempt > maxRetries) throw error
      const backoffMs = rateLimitBackoffMs({
        opts,
        attempt,
        error
      })
      emitRetryProgress({
        rateLimited: true,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        backoffMs,
        retryAt: new Date(Date.now() + backoffMs).toISOString(),
        error: error.message
      })
      await sleep(backoffMs)
    }
  }
}

const summarizeTreeBatch = async ({ tree, opts, mode, resolved, candidateNodes, nodes, maxChildChars, inputTokenBudget, compactedSpanCount }) => {
  const candidateJobs = nodeJobs({
    nodes: candidateNodes,
    maxChildChars,
    inputTokenBudget,
    resolved,
    previousSummaryJobs: opts.previousSummaryJobs
  })
  const selectedHandles = new Set(nodes.map(node => node.handle))
  const { reusedJobs, pendingJobs } = opts.summaryBatchId
    ? { reusedJobs: [], pendingJobs: candidateJobs.filter(job => selectedHandles.has(job.handle)) }
    : splitReusableJobs({
        internalJobs: candidateJobs.filter(job => selectedHandles.has(job.handle)),
        previousSummaryJobs: opts.previousSummaryJobs,
        mode,
        resolved
      })
  const budgetJobs = opts.summaryBatchId
    ? [...reusedJobs, ...pendingJobs]
    : (() => {
        const all = splitReusableJobs({
          internalJobs: candidateJobs,
          previousSummaryJobs: opts.previousSummaryJobs,
          mode,
          resolved
        })
        return [...all.reusedJobs, ...all.pendingJobs]
      })()
  const summaryBudget = await estimateSummaryBudget({
    jobs: budgetJobs,
    opts,
    resolved,
    enforce: false
  })
  const budgetSuspended = pendingJobs.length > 0 &&
    ['over_budget', 'budget_limited'].includes(summaryBudget && summaryBudget.status)
  if (budgetSuspended) {
    const allPublicJobs = [
      ...reusedJobs,
      ...pendingJobs.map(job => ({
        ...publicJob(job),
        status: 'pending'
      }))
    ]
    return {
      summary: {
        mode,
        provider: resolved.providerName,
        model: resolved.model,
        modelSource: resolved.modelSource,
        reasoningEffort: resolved.reasoningEffort,
        strategy: SPAN_SUMMARY_STRATEGY,
        execution: 'message-batch',
        status: 'suspended-budget',
        created: false,
        generatedNodeCount: 0,
        reusedJobCount: reusedJobs.length,
        skippedJobCount: 0,
        candidateNodeCount: candidateNodes.length,
        compactedSpanCount,
        compactionLog: compactionLogForNodes({
          tree,
          nodes: candidateNodes,
          jobs: allPublicJobs
        }),
        summaryBudget,
        resultCount: 0,
        ...jobAccounting(allPublicJobs)
      },
      jobs: allPublicJobs
    }
  }
  const reservation = await reservePendingJobs({
    pendingJobs,
    opts,
    mode,
    resolved
  })
  const modelJobs = reservation.claimedJobs
  const jobs = [...reusedJobs, ...reservation.reusedJobs, ...reservation.skippedJobs, ...modelJobs]
  let batch = null
  let created = false
  let results = []
  let generatedNodeCount = 0
  const timeoutMs = Number.isFinite(opts.summaryBatchTimeoutMs) ? opts.summaryBatchTimeoutMs : 0
  const pollMs = Number.isFinite(opts.summaryBatchPollMs) ? opts.summaryBatchPollMs : undefined

  if (modelJobs.length) {
    if (opts.summaryBatchId) {
      batch = await resolved.provider.waitForBatch({
        batchId: opts.summaryBatchId,
        timeoutMs,
        pollMs
      })
    } else {
      const systemPrompts = [...new Set(modelJobs.map(job => job.systemPrompt))]
      if (systemPrompts.length !== 1) {
        throw new Error('summary batch cannot mix leaf, parent-creation, and parent-update prompt families')
      }
      batch = await resolved.provider.createBatch({
        jobs: modelJobs,
        systemPrompt: systemPrompts[0],
        maxTokens: resolved.callOptions.maxTokens,
        cacheSystemPrompt: opts.summaryPromptCache !== false
      })
      created = true
      updateSubmittedJobNodes({ jobs: modelJobs, batch, mode, resolved })
      if (timeoutMs > 0 && batch.processing_status !== 'ended') {
        batch = await resolved.provider.waitForBatch({
          batchId: batch.id,
          timeoutMs,
          pollMs
        })
      }
    }

    updateSubmittedJobNodes({ jobs: modelJobs, batch, mode, resolved })
    if (batch && batch.processing_status === 'ended' && batch.results_url) {
      results = await resolved.provider.results(batch.id)
      generatedNodeCount = applyBatchResults({
        results,
        jobs: modelJobs,
        mode,
        resolved
      })
    }
  }

  const meta = resolved.batchMeta ? resolved.batchMeta(batch) : batchMeta(batch)
  const allPublicJobs = [
    ...reusedJobs,
    ...reservation.reusedJobs,
    ...reservation.skippedJobs,
    ...modelJobs.map(publicJob)
  ]
  const compactionLog = compactionLogForNodes({
    tree,
    nodes: candidateNodes,
    jobs: [...reusedJobs, ...reservation.reusedJobs, ...reservation.skippedJobs, ...modelJobs]
  })
  const status = !modelJobs.length
    ? reservation.skippedJobs.length ? 'waiting' : 'completed'
    : batch && batch.processing_status === 'ended'
      ? 'completed'
      : created
        ? 'submitted'
        : 'processing'

  return {
    summary: {
      mode,
      provider: resolved.providerName,
      model: resolved.model,
      modelSource: resolved.modelSource,
      reasoningEffort: resolved.reasoningEffort,
      strategy: SPAN_SUMMARY_STRATEGY,
      execution: 'message-batch',
      status,
      created,
      generatedNodeCount,
      reusedJobCount: reusedJobs.length + reservation.reusedJobs.length,
      skippedJobCount: reservation.skippedJobs.length,
      candidateNodeCount: candidateNodes.length,
      compactedSpanCount,
      compactionLog,
      summaryBudget,
      resultCount: results.length,
      ...jobAccounting(allPublicJobs),
      ...meta
    },
    jobs: allPublicJobs
  }
}

const summaryJobRank = job => {
  if (!job) return 0
  if (job.resultType === 'succeeded') return 5
  if (job.status === 'completed' && !job.reused) return 4
  if (job.resultType === 'reused' || job.reused) return 3
  if (job.status === 'submitted' || job.status === 'processing') return 2
  if (job.status === 'pending') return 1
  return 0
}

const mergeSummaryJobs = (...groups) => {
  const merged = new Map()
  let anonymous = 0
  for (const job of groups.flat()) {
    if (!job) continue
    const key = job.targetId || `${job.handle || 'job'}:${job.childHash || anonymous++}`
    const current = merged.get(key)
    if (!current || summaryJobRank(job) > summaryJobRank(current)) merged.set(key, job)
  }
  return [...merged.values()]
}

const combineSummaryPasses = (first, next) => {
  const jobs = mergeSummaryJobs(first.jobs || [], next.jobs || [])
  const accounting = jobAccounting(jobs)
  return {
    summary: {
      ...first.summary,
      ...next.summary,
      generatedNodeCount: Number(first.summary && first.summary.generatedNodeCount || 0) +
        Number(next.summary && next.summary.generatedNodeCount || 0),
      compactedSpanCount: next.summary && next.summary.compactedSpanCount === undefined
        ? first.summary && first.summary.compactedSpanCount
        : next.summary && next.summary.compactedSpanCount,
      compactedInputTokenCount: next.summary && next.summary.compactedInputTokenCount === undefined
        ? first.summary && first.summary.compactedInputTokenCount
        : next.summary && next.summary.compactedInputTokenCount,
      ...accounting
    },
    jobs
  }
}

const summarizeTree = async (tree, opts = {}) => {
  const mode = opts.summaryMode || DEFAULT_SUMMARY_MODE
  if (mode === 'off' || mode === 'none') {
    return summarizeTreeFromStoredJobs(tree, { ...opts, summaryMode: mode }) ||
      markSummaryDisabled(tree, { summaryMode: mode })
  }
  if (mode !== 'model') throw new Error(`unsupported summary mode: ${mode}`)

  const resolved = summaryProvider({
    ...opts,
    promptCacheKey: `session-indexer-summary:${SUMMARY_PROMPT_SET_HASH}`,
    summarySessionId: opts.summarySessionId || `session-indexer-summary-${tree.ir.session.id}`
  })
  const maxNodes = opts.maxSummaryNodes
  const limit = Number.isInteger(maxNodes) ? maxNodes : DEFAULT_MAX_SUMMARY_NODES
  const maxChildChars = opts.maxSummaryChildChars || DEFAULT_MAX_CHILD_CHARS
  const inputTokenBudget = opts.summaryInputTokenBudget || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET
  // The `claude -p` CLI must run one invocation at a time: each spawns a full
  // Claude Code process that races on shared mutable state under ~/.claude (config,
  // telemetry cache, shell snapshots), and parallel calls also multiply the
  // per-minute token-rate that trips the org 429 limit. Clamp to serial regardless
  // of --summary-concurrency so neither failure mode can occur on the claude path.
  const requestedConcurrency = normalizeConcurrency(opts.summaryConcurrency, DEFAULT_SUMMARY_CONCURRENCY)
  const summaryConcurrency = resolved.providerName === 'claude-cli' ? 1 : requestedConcurrency
  const prepared = prepareCompactedSummaryLayer(tree, {
    summaryInputTokenBudget: inputTokenBudget,
    previousSummaryJobs: opts.previousSummaryJobs
  })
  const candidateNodes = candidateSummaryNodes({ tree, prepared })

  if (prepared.status === 'no_compaction') {
    return {
      summary: {
        mode,
        provider: resolved.providerName,
        model: resolved.model,
        modelSource: resolved.modelSource,
        modelCache: resolved.modelCache,
        reasoningEffort: resolved.reasoningEffort,
        strategy: SPAN_SUMMARY_STRATEGY,
        status: 'no_compaction',
        generatedNodeCount: 0,
        candidateNodeCount: 0,
        compactedSpanCount: 0,
        compactedInputTokenCount: 0,
        compactionLog: [],
        ...jobAccounting([])
      },
      jobs: []
    }
  }

  if (resolved.batch) {
    const selectedNodes = candidateNodes.slice(0, Math.max(0, limit))
    const batchResult = await summarizeTreeBatch({
      tree,
      opts,
      mode,
      resolved,
      candidateNodes,
      nodes: selectedNodes,
      maxChildChars,
      inputTokenBudget,
      compactedSpanCount: prepared.compactedSpanCount
    })
    const maintenanceDepth = Number(opts._summaryMaintenanceDepth || 0)
    if (
      batchResult.summary.status === 'completed' &&
      Number(batchResult.summary.generatedNodeCount || 0) > 0 &&
      !rootSummaryIsUsable(tree.root) &&
      maintenanceDepth < 64
    ) {
      const next = await summarizeTree(tree, {
        ...opts,
        previousSummaryJobs: mergeSummaryJobs(opts.previousSummaryJobs || [], batchResult.jobs || []),
        maxSummaryNodes: Math.max(0, limit - Number(batchResult.summary.generatedNodeCount || 0)),
        summaryBatchId: undefined,
        _summaryMaintenanceDepth: maintenanceDepth + 1
      })
      return combineSummaryPasses(batchResult, next)
    }
    return batchResult
  }

  const candidateJobs = nodeJobs({
    nodes: candidateNodes,
    maxChildChars,
    inputTokenBudget,
    resolved,
    previousSummaryJobs: opts.previousSummaryJobs
  })
  emitProgress(opts, {
    phase: 'summary:prepared',
    execution: 'chat-work-queue',
    candidateNodeCount: candidateNodes.length,
    candidateJobCount: candidateJobs.length,
    maxSummaryNodes: limit
  })
  const { reusedJobs, pendingJobs } = splitReusableJobs({
    internalJobs: candidateJobs,
    previousSummaryJobs: opts.previousSummaryJobs,
    mode,
    resolved
  })
  const budgeted = await splitBudgetedPendingJobs({
    pendingJobs,
    reusedJobs,
    opts,
    resolved,
    limit
  })
  const selectedPendingJobs = budgeted.selectedPendingJobs
  const deferredJobs = budgeted.deferredPendingJobs.map(job => ({
    ...publicJob(job),
    status: 'pending'
  }))
  const summaryBudget = budgeted.summaryBudget
  const reservation = await reservePendingJobs({
    pendingJobs: selectedPendingJobs,
    opts,
    mode,
    resolved
  })
  const jobs = [...reusedJobs, ...reservation.reusedJobs, ...reservation.skippedJobs, ...deferredJobs]
  emitProgress(opts, {
    phase: 'summary:claimed',
    execution: 'chat-work-queue',
    concurrency: summaryConcurrency,
    candidateJobCount: candidateJobs.length,
    reusedJobCount: reusedJobs.length + reservation.reusedJobs.length,
    deferredJobCount: deferredJobs.length,
    claimedJobCount: reservation.claimedJobs.length,
    skippedJobCount: reservation.skippedJobs.length,
    plannedInputTokenCount: reservation.claimedJobs.reduce((sum, job) => sum + Number(job.inputTokenCount || 0), 0)
  })
  const modelProgress = {
    startedAtMs: Date.now(),
    totalCount: reservation.claimedJobs.length,
    completedCount: 0
  }
  const finishGeneratedJob = job => {
    modelProgress.completedCount += 1
    return job
  }
  const generatedJobs = await runWorkQueue({
    items: reservation.claimedJobs,
    concurrency: summaryConcurrency,
    worker: async (internalJob, jobIndex) => {
      const node = internalJob.node
      emitProgress(opts, {
        phase: 'summary:model:start',
        execution: 'chat-work-queue',
        jobIndex,
        targetId: internalJob.targetId,
        handle: internalJob.handle,
        inputTokenCount: internalJob.inputTokenCount,
        childCount: internalJob.childCount,
        completedModelJobCount: modelProgress.completedCount,
        totalModelJobCount: modelProgress.totalCount,
        ...completionEstimate({
          startedAtMs: modelProgress.startedAtMs,
          completedCount: modelProgress.completedCount,
          totalCount: modelProgress.totalCount
        })
      })
      let observed
      let parsed
      const maxEmptyRetries = emptyResponseMaxRetries(opts)
      let emptyRetryCount = 0
      for (;;) {
        try {
          observed = await observeSummaryWithRateLimitBackoff({
            internalJob,
            jobIndex,
            opts,
            resolved,
            progress: modelProgress
          })
          parsed = assertSummaryHasBody(parseSummary(observed.text, node), observed.text)
          break
        } catch (err) {
          if (!isEmptySummaryResponseError(err) || emptyRetryCount >= maxEmptyRetries) {
            emitProgress(opts, {
              phase: 'summary:model:error',
              execution: 'chat-work-queue',
              jobIndex,
              targetId: internalJob.targetId,
              error: err.message
            })
            return finishGeneratedJob(markSummaryError({
              node,
              internalJob,
              error: err,
              mode,
              resolved
            }))
          }
          emptyRetryCount += 1
          const backoffMs = emptyResponseBackoffMs(opts)
          emitProgress(opts, {
            phase: 'summary:model:retry',
            execution: 'chat-work-queue',
            jobIndex,
            targetId: internalJob.targetId,
            handle: internalJob.handle,
            attempt: emptyRetryCount,
            nextAttempt: emptyRetryCount + 1,
            maxAttempts: maxEmptyRetries + 1,
            backoffMs,
            retryAt: new Date(Date.now() + backoffMs).toISOString(),
            ...completionEstimate({
              startedAtMs: modelProgress.startedAtMs,
              completedCount: modelProgress.completedCount,
              totalCount: modelProgress.totalCount,
              backoffMs
            }),
            error: err.message
          })
          await sleep(backoffMs)
        }
      }
      applyParsedSummary({
        node,
        parsed,
        mode,
        resolved,
        internalJob
      })
      emitProgress(opts, {
        phase: 'summary:model:done',
        execution: 'chat-work-queue',
        jobIndex,
        targetId: internalJob.targetId,
        breadcrumb: parsed.breadcrumb || '',
        outputChars: (parsed.summary || observed.text || '').length,
        usage: observed.usage,
        completedModelJobCount: modelProgress.completedCount + 1,
        totalModelJobCount: modelProgress.totalCount,
        ...completionEstimate({
          startedAtMs: modelProgress.startedAtMs,
          completedCount: modelProgress.completedCount + 1,
          totalCount: modelProgress.totalCount
        })
      })
      return finishGeneratedJob(completePublicJob({
        internalJob,
        parsed,
        text: observed.text,
        usage: observed.usage
      }))
    }
  })
  jobs.push(...generatedJobs)

  const accounting = jobAccounting(jobs)
  const compactionLog = compactionLogForNodes({
    tree,
    nodes: candidateNodes,
    jobs
  })
  const budgetSuspended = ['over_budget', 'budget_limited'].includes(summaryBudget && summaryBudget.status)
  const currentResult = {
    summary: {
      mode,
      provider: resolved.providerName,
      model: resolved.model,
      modelSource: resolved.modelSource,
      modelCache: resolved.modelCache,
      reasoningEffort: resolved.reasoningEffort,
      strategy: SPAN_SUMMARY_STRATEGY,
      execution: 'chat-work-queue',
      concurrency: summaryConcurrency,
      status: budgetSuspended ? 'suspended-budget' : 'completed',
      generatedNodeCount: reservation.claimedJobs.length,
      reusedJobCount: reusedJobs.length + reservation.reusedJobs.length,
      skippedJobCount: reservation.skippedJobs.length,
      candidateNodeCount: candidateNodes.length,
      compactedSpanCount: prepared.compactedSpanCount,
      compactedInputTokenCount: prepared.compactedInputTokenCount,
      compactionLog,
      summaryBudget,
      ...accounting
    },
    jobs
  }
  const maintenanceDepth = Number(opts._summaryMaintenanceDepth || 0)
  const generatedCleanly = generatedJobs.length > 0 && generatedJobs.every(job =>
    job.status === 'completed' && !job.error)
  if (
    generatedCleanly &&
    !budgetSuspended &&
    !rootSummaryIsUsable(tree.root) &&
    maintenanceDepth < 64
  ) {
    const next = await summarizeTree(tree, {
      ...opts,
      previousSummaryJobs: mergeSummaryJobs(opts.previousSummaryJobs || [], jobs),
      maxSummaryNodes: Math.max(0, limit - reservation.claimedJobs.length),
      _summaryMaintenanceDepth: maintenanceDepth + 1
    })
    return combineSummaryPasses(currentResult, next)
  }
  return currentResult
}

module.exports = {
  applyBatchResults,
  applyStoredSummaryJobs,
  chooseCodexModel,
  DEFAULT_MAX_SUMMARY_NODES,
  DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET,
  DEFAULT_SUMMARY_MAX_BUDGET_USD,
  DEFAULT_SUMMARY_CONCURRENCY,
  DEFAULT_SUMMARY_MODE,
  DEFAULT_SUMMARY_PROVIDER,
  DEFAULT_SUMMARY_REASONING_EFFORT,
  jobAccounting,
  loadCodexModels,
  makePrompt,
  PARENT_SUMMARY_SYSTEM_PROMPT,
  PARENT_UPDATE_SYSTEM_PROMPT,
  prepareCompactedSummaryLayer,
  SUMMARY_SYSTEM_PROMPT,
  childRevisionHashesForNode,
  summaryPromptPlanForNode,
  summarySystemPromptForNode,
  summarizeTree,
  summaryProvider
}
