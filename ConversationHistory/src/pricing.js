const fs = require('fs')
const path = require('path')
const { normalizeUsage } = require('./ir.js')
const { LOCAL_STATE_DIR } = require('./paths.js')

const MODELS_DEV_API_URL = 'https://models.dev/api.json'
const DEFAULT_PRICING_CACHE_DIR = path.join(LOCAL_STATE_DIR, 'pricing')
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const USD_PER_TOKEN_UNIT = 1_000_000

const pricingCachePath = (root = DEFAULT_PRICING_CACHE_DIR) => path.join(root, 'models-dev-api.json')

const readJsonIfFresh = (file, ttlMs) => {
  try {
    const stat = fs.statSync(file)
    if (ttlMs !== Infinity && Date.now() - stat.mtimeMs > ttlMs) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_err) {
    return null
  }
}

const fetchJson = async url => {
  if (typeof fetch !== 'function') throw new Error('global fetch is not available in this Node.js runtime')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to fetch ${url}: HTTP ${response.status}`)
  return response.json()
}

const loadModelsDevCatalog = async (opts = {}) => {
  if (opts.catalog) return opts.catalog
  const cacheDir = opts.cacheDir || DEFAULT_PRICING_CACHE_DIR
  const cachePath = pricingCachePath(cacheDir)
  const ttlMs = opts.cacheTtlMs === undefined ? DEFAULT_CACHE_TTL_MS : opts.cacheTtlMs
  if (!opts.refresh) {
    const cached = readJsonIfFresh(cachePath, ttlMs)
    if (cached) return cached
  }
  const catalog = await fetchJson(opts.url || MODELS_DEV_API_URL)
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(cachePath, `${JSON.stringify(catalog, null, 2)}\n`)
  return catalog
}

const modelRecords = catalog => Object.entries(catalog || {}).flatMap(([providerId, provider]) => {
  const models = provider && provider.models || {}
  return Object.entries(models).map(([modelId, model]) => ({
    providerId,
    providerName: provider.name || providerId,
    modelId,
    id: model.id || modelId,
    name: model.name || modelId,
    family: model.family,
    cost: model.cost || {},
    limit: model.limit || {},
    modalities: model.modalities || {},
    status: model.status,
    raw: model
  }))
})

const normalizeModelKey = value => String(value || '').trim().toLowerCase()

const splitModelId = value => {
  const text = String(value || '').trim()
  const slash = text.match(/^([^/:]+)\/(.+)$/)
  if (slash) return { providerId: slash[1], modelId: slash[2] }
  const colon = text.match(/^([^/:]+):(.+)$/)
  if (colon) return { providerId: colon[1], modelId: colon[2] }
  return { modelId: text }
}

const listModels = ({ catalog, filter = '', provider, limit = 25 } = {}) => {
  const needle = normalizeModelKey(filter)
  const providerNeedle = normalizeModelKey(provider)
  return modelRecords(catalog)
    .filter(record => !providerNeedle || normalizeModelKey(record.providerId) === providerNeedle)
    .filter(record => {
      if (!needle) return true
      return [
        record.providerId,
        record.providerName,
        record.modelId,
        record.id,
        record.name,
        record.family,
        record.status,
        JSON.stringify(record.cost)
      ].filter(Boolean).some(value => normalizeModelKey(value).includes(needle))
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId))
    .slice(0, limit)
    .map(record => ({
      provider: record.providerId,
      providerName: record.providerName,
      model_id: record.modelId,
      id: record.id,
      name: record.name,
      family: record.family,
      status: record.status,
      cost: record.cost,
      limit: record.limit,
      modalities: record.modalities
    }))
}

const resolvePricing = ({ catalog, model_id, provider } = {}) => {
  const requested = splitModelId(model_id)
  const providerId = provider || requested.providerId
  const modelId = requested.modelId
  const modelNeedle = normalizeModelKey(modelId)
  const providerNeedle = normalizeModelKey(providerId)
  if (!modelNeedle) throw new Error('model_id is required')

  const candidates = modelRecords(catalog).filter(record => {
    if (providerNeedle && normalizeModelKey(record.providerId) !== providerNeedle) return false
    return [
      record.modelId,
      record.id,
      `${record.providerId}/${record.modelId}`,
      `${record.providerId}:${record.modelId}`
    ].some(value => normalizeModelKey(value) === modelNeedle || normalizeModelKey(value) === normalizeModelKey(model_id))
  })

  if (!candidates.length) {
    const fuzzy = listModels({ catalog, filter: model_id, provider, limit: 8 })
    const suffix = fuzzy.length ? ` Similar matches: ${fuzzy.map(item => `${item.provider}/${item.model_id}`).join(', ')}` : ''
    throw new Error(`unknown model_id: ${model_id}.${suffix}`)
  }
  if (candidates.length > 1 && !providerNeedle) {
    throw new Error(`ambiguous model_id: ${model_id}. Use provider/model_id. Matches: ${candidates.map(item => `${item.providerId}/${item.modelId}`).join(', ')}`)
  }
  const record = candidates[0]
  return {
    provider: record.providerId,
    providerName: record.providerName,
    model_id: record.modelId,
    id: record.id,
    name: record.name,
    family: record.family,
    status: record.status,
    cost: {
      input: Number(record.cost.input || 0),
      output: Number(record.cost.output || 0),
      cache_read: Number(record.cost.cache_read || 0),
      cache_write: Number(record.cost.cache_write || 0),
      reasoning: Number(record.cost.reasoning || 0)
    },
    limit: record.limit,
    modalities: record.modalities,
    rawCost: record.cost
  }
}

const charge = (tokens, pricePerMillion) => tokens * pricePerMillion / USD_PER_TOKEN_UNIT

const estimateCost = ({ pricing, usage }) => {
  const normalizedUsage = normalizeUsage(usage)
  const cost = pricing.cost || pricing
  const inputBaseTokens = Math.max(0, normalizedUsage.input - normalizedUsage.cache_read - normalizedUsage.cache_write)
  const cacheReadRate = cost.cache_read || cost.input || 0
  const cacheWriteRate = cost.cache_write || cost.input || 0
  const hasReasoningRate = Boolean(cost.reasoning)
  const outputBaseTokens = hasReasoningRate
    ? Math.max(0, normalizedUsage.output - normalizedUsage.reasoning)
    : normalizedUsage.output

  const breakdown = {
    input: {
      tokens: inputBaseTokens,
      rate_per_million_usd: cost.input || 0,
      cost_usd: charge(inputBaseTokens, cost.input || 0)
    },
    cache_read: {
      tokens: normalizedUsage.cache_read,
      rate_per_million_usd: cacheReadRate,
      cost_usd: charge(normalizedUsage.cache_read, cacheReadRate)
    },
    cache_write: {
      tokens: normalizedUsage.cache_write,
      rate_per_million_usd: cacheWriteRate,
      cost_usd: charge(normalizedUsage.cache_write, cacheWriteRate)
    },
    output: {
      tokens: outputBaseTokens,
      rate_per_million_usd: cost.output || 0,
      cost_usd: charge(outputBaseTokens, cost.output || 0)
    },
    reasoning: {
      tokens: normalizedUsage.reasoning,
      rate_per_million_usd: hasReasoningRate ? cost.reasoning : 0,
      cost_usd: hasReasoningRate ? charge(normalizedUsage.reasoning, cost.reasoning) : 0
    }
  }
  const totalCost = Object.values(breakdown).reduce((sum, item) => sum + item.cost_usd, 0)
  const assumptions = []
  if (!cost.cache_read && normalizedUsage.cache_read) assumptions.push('cache_read tokens billed at input rate because the model has no cache_read price')
  if (!cost.cache_write && normalizedUsage.cache_write) assumptions.push('cache_write tokens billed at input rate because the model has no cache_write price')
  if (!hasReasoningRate && normalizedUsage.reasoning) assumptions.push('reasoning is treated as included in output because the model has no separate reasoning price')
  return {
    usage: normalizedUsage,
    pricing,
    breakdown,
    total_cost_usd: totalCost,
    assumptions
  }
}

const compactNumber = value => {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const assignNumber = (target, key, value) => {
  const number = compactNumber(value)
  if (number !== undefined) target[key] = number
}

const compactCostBreakdown = breakdown => {
  const out = {}
  for (const [key, item] of Object.entries(breakdown || {})) {
    if (!item || typeof item !== 'object') continue
    const compact = {}
    assignNumber(compact, 'tokens', item.tokens)
    assignNumber(compact, 'rate_per_million_usd', item.rate_per_million_usd)
    assignNumber(compact, 'cost_usd', item.cost_usd)
    const hasValue = Boolean(compact.tokens || compact.cost_usd)
    if (hasValue) out[key] = compact
  }
  return out
}

const compactRates = pricing => {
  const cost = pricing && (pricing.cost || pricing.rates_per_million_usd || pricing.ratesPerMillionUsd)
  const out = {}
  for (const key of ['input', 'output', 'cache_read', 'cache_write', 'reasoning']) {
    const number = cost && Object.hasOwn(cost, key) ? compactNumber(cost[key]) : undefined
    if (number) out[key] = number
  }
  return out
}

const compactSummaryBudget = budget => {
  if (!budget || typeof budget !== 'object') return budget
  const out = {}
  for (const key of ['status', 'provider', 'model']) {
    if (budget[key] !== undefined && budget[key] !== null && budget[key] !== '') out[key] = budget[key]
  }
  for (const key of [
    'maxBudgetUsd',
    'neededBudgetUsd',
    'additionalBudgetUsd',
    'targetCount',
    'estimatedCostUsd',
    'spentBudgetUsd',
    'remainingBudgetUsd',
    'selectedBudgetUsd',
    'deferredBudgetUsd',
    'selectedTargetCount',
    'deferredTargetCount',
    'pendingTargetCount'
  ]) {
    assignNumber(out, key, budget[key])
  }
  if (budget.usage) out.usage = normalizeUsage(budget.usage)
  const rates = compactRates(budget.pricing || budget)
  if (Object.keys(rates).length) out.rates_per_million_usd = rates
  const breakdown = compactCostBreakdown(budget.breakdown)
  if (Object.keys(breakdown).length) out.breakdown = breakdown
  assignNumber(out, 'total_cost_usd', budget.total_cost_usd === undefined ? budget.neededBudgetUsd : budget.total_cost_usd)
  if (Array.isArray(budget.assumptions) && budget.assumptions.length) {
    out.assumptions = budget.assumptions.map(item => String(item)).filter(Boolean)
  }
  return out
}

module.exports = {
  DEFAULT_PRICING_CACHE_DIR,
  compactSummaryBudget,
  listModels,
  loadModelsDevCatalog,
  MODELS_DEV_API_URL,
  pricingCachePath,
  resolvePricing,
  estimateCost
}
