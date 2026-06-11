const fs = require('fs')
const os = require('os')
const path = require('path')
const { ChatProducer } = require('./ChatProducer.js')

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const DEFAULT_MODEL = 'gpt-5.5'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

class OpenAICodexResponsesProvider {
  constructor (options = {}) {
    this.model = options.model || DEFAULT_MODEL
    this.baseUrl = options.baseUrl || DEFAULT_CODEX_BASE_URL
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    this.originator = options.originator || 'physics-compiler'
    this.producer = new ChatProducer('openai-codex-responses', {
      options: options.producerOptions || {}
    })
  }

  async chat (messages, options = {}) {
    const produced = this.producer.produce(messages, {
      model: options.model || this.model,
      sessionId: options.sessionId,
      prompt_cache_key: options.prompt_cache_key,
      temperature: options.temperature,
      tools: options.tools,
      tool_choice: options.tool_choice,
      reasoning: options.reasoning,
      text: options.text,
      textVerbosity: options.textVerbosity,
      service_tier: options.service_tier,
      include: options.include,
      stream: true
    })

    const auth = loadCodexAuth(this.codexHome)
    const response = await fetch(resolveCodexUrl(options.baseUrl || this.baseUrl), {
      method: 'POST',
      headers: codexHeaders({
        token: auth.accessToken,
        accountId: auth.accountId,
        originator: options.originator || this.originator,
        headers: options.headers
      }),
      body: JSON.stringify(produced.request),
      signal: options.signal
    })

    if (!response.ok) {
      const text = await response.text()
      const err = new Error(formatCodexError(response.status, text))
      err.status = response.status
      err.retryAfterMs = retryAfterMs(response.headers && response.headers.get && response.headers.get('retry-after'))
      throw err
    }

    return {
      body: response.body,
      request: produced,
      response
    }
  }
}

function loadCodexAuth (codexHome = path.join(os.homedir(), '.codex')) {
  const authPath = path.join(codexHome, 'auth.json')
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
  const accessToken = auth.tokens && auth.tokens.access_token
  if (!accessToken) {
    throw new Error(`No Codex OAuth access token found at ${authPath}; run codex login.`)
  }

  const payload = decodeJwtPayload(accessToken)
  const exp = payload && payload.exp
  if (typeof exp === 'number' && Date.now() > (exp - 60) * 1000) {
    throw new Error('Codex OAuth access token is expired or near expiry; run codex login status or codex login to refresh it.')
  }

  const accountId =
    payload &&
    payload[JWT_CLAIM_PATH] &&
    payload[JWT_CLAIM_PATH].chatgpt_account_id
      ? payload[JWT_CLAIM_PATH].chatgpt_account_id
      : auth.tokens.account_id

  if (!accountId) {
    throw new Error('Codex OAuth token did not expose a ChatGPT account id.')
  }

  return { accessToken, accountId, payload }
}

function codexHeaders ({ token, accountId, originator, headers = {} }) {
  return {
    ...headers,
    authorization: `Bearer ${token}`,
    'chatgpt-account-id': accountId,
    originator,
    'OpenAI-Beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'User-Agent': `${originator} (node ${process.version}; ${process.platform} ${process.arch})`
  }
}

function resolveCodexUrl (baseUrl = DEFAULT_CODEX_BASE_URL) {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/codex/responses')) return normalized
  if (normalized.endsWith('/codex')) return `${normalized}/responses`
  return `${normalized}/codex/responses`
}

function decodeJwtPayload (token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Codex OAuth access token is not a JWT.')
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
}

function formatCodexError (status, text) {
  try {
    const parsed = JSON.parse(text)
    const message = parsed.error && parsed.error.message ? parsed.error.message : text
    return `Codex Responses request failed (${status}): ${message}`
  } catch {
    return `Codex Responses request failed (${status}): ${text}`
  }
}

function retryAfterMs (header) {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const dateMs = Date.parse(header)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

module.exports = {
  OpenAICodexResponsesProvider,
  loadCodexAuth,
  resolveCodexUrl
}
