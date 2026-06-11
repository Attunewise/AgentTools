const { AnthropicAws } = require('@anthropic-ai/aws-sdk')
const { hashString } = require('../util.js')

const DEFAULT_MODEL = process.env.SESSION_INDEXER_SUMMARY_MODEL || 'claude-haiku-4-5'
const DEFAULT_REGION = process.env.ANTHROPIC_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || ''
const DEFAULT_POLL_MS = Number(process.env.SESSION_INDEXER_SUMMARY_BATCH_POLL_MS || 5000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const safeCustomId = value => `sum_${hashString(value).slice(0, 28)}`

const messageText = message => (message && Array.isArray(message.content)
  ? message.content
      .filter(block => block && block.type === 'text')
      .map(block => block.text || '')
      .join('\n')
  : '')

const requestForJob = ({ job, model, maxTokens, systemPrompt, cacheSystemPrompt = true }) => ({
  custom_id: job.customId,
  params: {
    model,
    max_tokens: maxTokens,
    system: cacheSystemPrompt
      ? [{
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }]
      : systemPrompt,
    messages: [{
      role: 'user',
      content: job.prompt
    }]
  }
})

const batchMeta = batch => batch
  ? {
      batchId: batch.id,
      processingStatus: batch.processing_status,
      requestCounts: batch.request_counts,
      createdAt: batch.created_at,
      endedAt: batch.ended_at || null,
      expiresAt: batch.expires_at || null,
      resultsAvailable: Boolean(batch.results_url)
    }
  : {}

class ClaudePlatformAwsBatchProvider {
  constructor (options = {}) {
    this.model = options.model || DEFAULT_MODEL
    this.region = options.region || DEFAULT_REGION
    this.workspaceId = options.workspaceId || process.env.ANTHROPIC_AWS_WORKSPACE_ID || ''
    this.client = options.client || new AnthropicAws({
      awsRegion: this.region || undefined,
      workspaceId: this.workspaceId || undefined,
      awsProfile: options.awsProfile || process.env.AWS_PROFILE || undefined,
      apiKey: options.apiKey || process.env.ANTHROPIC_AWS_API_KEY || undefined,
      timeout: options.timeout
    })
  }

  async ready () {
    if (this.client.ready) await this.client.ready
  }

  async createBatch ({ jobs, systemPrompt, maxTokens, cacheSystemPrompt = true }) {
    await this.ready()
    const requests = makeBatchRequests({
      jobs,
      model: this.model,
      maxTokens,
      systemPrompt,
      cacheSystemPrompt
    })
    return this.client.messages.batches.create({ requests })
  }

  async retrieveBatch (batchId) {
    await this.ready()
    return this.client.messages.batches.retrieve(batchId)
  }

  async waitForBatch ({ batchId, timeoutMs = 0, pollMs = DEFAULT_POLL_MS }) {
    await this.ready()
    const deadline = Date.now() + Math.max(0, timeoutMs)
    let batch = await this.retrieveBatch(batchId)
    while (batch && batch.processing_status !== 'ended' && timeoutMs > 0 && Date.now() < deadline) {
      await sleep(Math.max(250, pollMs))
      batch = await this.retrieveBatch(batchId)
    }
    return batch
  }

  async results (batchId) {
    await this.ready()
    const decoder = await this.client.messages.batches.results(batchId)
    const out = []
    for await (const item of decoder) out.push(item)
    return out
  }
}

const makeBatchRequests = ({ jobs, model, maxTokens = 320, systemPrompt, cacheSystemPrompt = true }) => {
  return jobs.map(job => requestForJob({
    job,
    model,
    maxTokens,
    systemPrompt,
    cacheSystemPrompt
  }))
}

module.exports = {
  ClaudePlatformAwsBatchProvider,
  DEFAULT_MODEL,
  DEFAULT_POLL_MS,
  batchMeta,
  makeBatchRequests,
  messageText,
  safeCustomId
}
