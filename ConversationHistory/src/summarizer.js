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
  nodeTimeFields,
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

const SUMMARY_SYSTEM_PROMPT = [
  'You generate loss-minimizing transcript mip summaries for browse and search.',
  'Summaries route future agents to underlying records; they are navigation state, not evidence.',
  'Summarize only the supplied child records.',
  'Be recall-biased because omission is the dangerous failure mode. Remove filler and repetition, not concrete facts.',
  'Preserve user goals, constraints, decisions, current task state, file paths, ids, commands, errors, dates, model/provider choices, costs, resource usage, test results, and open questions when present.',
  'Tool call and tool result records with the same tool_call_id are one operation. Keep their facts associated and summarize the operation as a unit.',
  'For exact quoted phrases, secret markers, numeric codes, credentials, or identifiers, describe that the exact value exists in an underlying child record, but do not copy the exact value into the summary.',
  'Do not say details are missing, unavailable, not shown, not supplied, or absent unless a child record explicitly says that. If a span ends mid-task, summarize only what is present and omit completeness caveats.',
  'Do not include child handles, event numbers, or resource links in breadcrumb, summary, or topic text; the index stores those as structured fields.',
  'Return strict JSON with exactly three fields: {"breadcrumb":"one-or-two-words","summary":"one compact paragraph","topics":["natural-language browse/search topic"]}.',
  'Breadcrumbs must be lowercase, one or two words, and specific to the child span.',
  'Topics are the browse/search routing surface. Write natural phrases a user might search for, with concrete anchors and synonyms when useful.',
  'Do not write compressed tags, camelCase keys, one-word labels, or generic topics such as "implementation", "discussion", "cleanup", "tests", "errors", or "indexing".',
  'Each topic must name the concrete subject and why it matters in the child span, using enough detail to route navigation without opening the child.'
].join('\n')

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

const childRecord = (child, maxChildChars, opts = {}) => {
  const record = {
    label: child.breadcrumb || child.title || child.kind || 'child',
    kind: child.kind,
    title: child.title,
    ...nodeTimeFields(child),
    summary: child.head || '',
    topics: opts.includeRawSource ? [] : child.topics || [],
    child_count: modelVisibleChildren(child.children).length
  }
  if (child.meta && (child.meta.type === 'tool_call' || child.meta.type === 'tool_result')) {
    record.tool_role = child.meta.type === 'tool_call' ? 'call' : 'result'
    if (child.meta.toolName) record.tool_name = child.meta.toolName
    if (child.meta.callId) record.tool_call_id = child.meta.callId
  }
  if (opts.includeRawSource) {
    record.source_text = truncateSource(nodeRawText(child), opts.maxSourceChars || maxChildChars)
  } else if (!child.children.length) {
    record.source_excerpt = preview(child.raw, maxChildChars)
  }
  return record
}

const makePrompt = ({ node, maxChildChars, inputTokenBudget }) => {
  const includeRawSource = node.meta && node.meta.summaryLevel === 1
  const maxSourceChars = Math.max(maxChildChars, (inputTokenBudget || DEFAULT_SUMMARY_INPUT_TOKEN_BUDGET) * 4)
  const childLines = modelVisibleChildren(node.children).map(child => JSON.stringify(childRecord(child, maxChildChars, {
    includeRawSource,
    maxSourceChars
  })))
  return [
  `Node title: ${node.title}`,
  `Node kind: ${node.kind}`,
  '',
  'Child records (JSONL):',
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
  const summaryNodes = []
  for (const span of compactedSpans) {
    const spanChildren = modelVisibleChildren(span.children)
    if (!spanChildren.length) continue
    const sourceSpanHash = sourceHashForChildren(spanChildren)
    for (const group of groupByInputTokenBudget(spanChildren, inputTokenBudget)) {
      const sourceGroupHash = sourceHashForChildren(group.children)
      const node = createSummaryNode({
        tree,
        level: 1,
        index: summaryNodes.length,
        children: group.children,
        meta: {
          source: 'compacted-transcript',
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
    compactedInputTokenCount: compactedSpans.reduce((sum, span) => sum +
      modelVisibleChildren(span.children).reduce((childSum, child) => childSum + Number(child.fullTokenCount || 0), 0), 0)
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

const summaryTargetMaterial = ({ node, childHash, resolved, maxChildChars, inputTokenBudget, strategy }) => ({
  schema: SUMMARY_TARGET_SCHEMA,
  strategy,
  nodeHandle: node.handle,
  sourceGroupHash: node.kind === 'session' ? sourceHashForChildren(node.children) : node.meta && node.meta.sourceGroupHash,
  promptHash: hashString(SUMMARY_SYSTEM_PROMPT),
  childHash,
  provider: resolved.providerName,
  model: resolved.model,
  reasoningEffort: resolved.reasoningEffort || '',
  maxChildChars,
  inputTokenBudget,
  maxOutputTokens: resolved.callOptions && (resolved.callOptions.maxTokens || resolved.callOptions.max_tokens || resolved.callOptions.max_output_tokens)
})

const parseSummary = text => {
  const raw = String(text || '').trim()
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      return {
        breadcrumb: compactText(parsed.breadcrumb || ''),
        summary: compactText(parsed.summary || ''),
        topics: normalizeTopics(parsed.topics, { max: 8, maxChars: 220 })
      }
    } catch (_err) {}
  }
  return { breadcrumb: '', summary: compactText(raw), topics: [] }
}

const assertSummaryHasBody = (parsed, text) => {
  if (parsed && compactText(parsed.summary)) return parsed
  const fallback = compactText(text || '')
  if (fallback) {
    return {
      ...(parsed || {}),
      summary: fallback
    }
  }
  throw new Error('summary model returned an empty response')
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
      promptHash: hashString(SUMMARY_SYSTEM_PROMPT),
      childHash: internalJob.childHash,
      customId: internalJob.customId,
      targetId: internalJob.targetId,
      targetMaterialHash: internalJob.targetMaterialHash,
      strategy: internalJob.strategy || SPAN_SUMMARY_STRATEGY,
      summaryLevel: node.meta && node.meta.summaryLevel,
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

const nodeJobs = ({ nodes, maxChildChars, inputTokenBudget, resolved }) => nodes.map(node => {
  const prompt = makePrompt({ node, maxChildChars, inputTokenBudget })
  const childHash = hashString(prompt)
  const strategy = summaryStrategyForNode(node)
  const targetMaterial = summaryTargetMaterial({
    node,
    childHash,
    resolved,
    maxChildChars,
    inputTokenBudget,
    strategy
  })
  return {
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
    strategy,
    node
  }
})

const publicJob = job => {
  const {
    prompt,
    node,
    ...out
  } = job
  return out
}

const summaryRecordFromJob = job => ({
  breadcrumb: compactText(job && job.breadcrumb || ''),
  summary: compactText(job && (job.summary || job.resultSummary || job.head) || ''),
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
    promptHash: hashString(SUMMARY_SYSTEM_PROMPT),
    childHash: internalJob.childHash,
    customId: internalJob.customId,
    targetId: internalJob.targetId,
    targetMaterialHash: internalJob.targetMaterialHash,
    strategy: internalJob.strategy || SPAN_SUMMARY_STRATEGY,
    summaryLevel: node.meta && node.meta.summaryLevel,
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
      parsed = assertSummaryHasBody(parseSummary(text), text)
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
      promptHash: hashString(SUMMARY_SYSTEM_PROMPT),
      childHash: job.childHash,
      customId: job.customId,
      strategy: job.strategy || SPAN_SUMMARY_STRATEGY,
      summaryLevel: job.node.meta && job.node.meta.summaryLevel,
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
  for (const job of jobs || []) {
    if (!hasReusableSummary(job)) continue
    const node = tree.byHandle.get(job.handle)
    if (!node) continue
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
      strategy: job.strategy || SPAN_SUMMARY_STRATEGY,
      inputTokenBudget: job.inputTokenBudget,
      inputTokenCount: job.inputTokenCount,
      status: 'completed',
      reused: true,
      generatedAt: job.completedAt || job.generatedAt
    }
    applied += 1
  }
  rebuildTreeIndex(tree)
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
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: internalJob.prompt }
      ], {
        ...resolved.callOptions,
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
  const candidateJobs = nodeJobs({ nodes: candidateNodes, maxChildChars, inputTokenBudget, resolved })
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
      batch = await resolved.provider.createBatch({
        jobs: modelJobs,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
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

const summarizeTree = async (tree, opts = {}) => {
  const mode = opts.summaryMode || DEFAULT_SUMMARY_MODE
  if (mode === 'off' || mode === 'none') return markSummaryDisabled(tree, { summaryMode: mode })
  if (mode !== 'model') throw new Error(`unsupported summary mode: ${mode}`)

  const resolved = summaryProvider({
    ...opts,
    promptCacheKey: `session-indexer-summary:${hashString(SUMMARY_SYSTEM_PROMPT)}`,
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
    return summarizeTreeBatch({
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
  }

  const candidateJobs = nodeJobs({ nodes: candidateNodes, maxChildChars, inputTokenBudget, resolved })
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
          parsed = assertSummaryHasBody(parseSummary(observed.text), observed.text)
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
  return {
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
  loadCodexModels,
  makePrompt,
  prepareCompactedSummaryLayer,
  SUMMARY_SYSTEM_PROMPT,
  summarizeTree,
  summaryProvider
}
