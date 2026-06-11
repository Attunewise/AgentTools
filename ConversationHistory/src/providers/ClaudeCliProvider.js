const { spawn } = require('child_process')

const DEFAULT_COMMAND = process.env.CLAUDE_CLI_PATH || 'claude'
// Use a concrete, models.dev-resolvable model id (not the bare `haiku` CLI alias):
// the `claude -p --model` flag accepts full ids, and the summarizer's pre-flight
// cost estimate looks the model up in the models.dev pricing catalog, which only
// knows full ids like `claude-haiku-4-5` — a bare alias throws "unknown model_id".
const DEFAULT_MODEL = process.env.SESSION_INDEXER_SUMMARY_MODEL || process.env.CLAUDE_CLI_MODEL || 'claude-haiku-4-5'
const DEFAULT_TIMEOUT_MS = Number(process.env.SESSION_INDEXER_CLAUDE_CLI_TIMEOUT_MS || 120000)
const DEFAULT_MAX_BUFFER = Number(process.env.SESSION_INDEXER_CLAUDE_CLI_MAX_BUFFER || 10 * 1024 * 1024)

const textFromContent = content => {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part.text === 'string') return part.text
      return part ? JSON.stringify(part) : ''
    }).join('\n')
  }
  return JSON.stringify(content)
}

const splitMessages = messages => {
  const system = []
  const prompt = []
  for (const message of messages || []) {
    const text = textFromContent(message.content)
    if (!text) continue
    if (message.role === 'system') {
      system.push(text)
    } else {
      prompt.push(`${String(message.role || 'user').toUpperCase()}:\n${text}`)
    }
  }
  return {
    systemPrompt: system.join('\n\n'),
    prompt: prompt.join('\n\n')
  }
}

const buildClaudeCliArgs = ({
  model = DEFAULT_MODEL,
  systemPrompt = '',
  maxBudgetUsd,
  extraArgs = []
} = {}) => {
  const args = [
    '-p',
    // --bare strips Claude Code's full agent system context. Without it every
    // summary call pays ~30s+ of harness startup and ~32k cache-creation tokens
    // (Claude Code loads its own large system prompt/tooling per invocation); with
    // it, calls are plain LLM completions — ~15x faster and far cheaper, which is
    // what a bulk summarizer wants. The --output-format json envelope is preserved.
    '--bare',
    '--output-format', 'json',
    '--model', model,
    '--no-session-persistence',
    '--tools', ''
  ]
  if (systemPrompt) args.push('--system-prompt', systemPrompt)
  if (maxBudgetUsd !== undefined && maxBudgetUsd !== null && maxBudgetUsd !== '') {
    args.push('--max-budget-usd', String(maxBudgetUsd))
  }
  return args.concat(extraArgs)
}

const parseClaudeCliResult = (stdout, stderr = '') => {
  const text = String(stdout || '').trim()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Claude CLI returned non-JSON output: ${error.message}: ${preview(text || stderr)}`)
  }

  if (parsed.is_error) {
    const detail = Array.isArray(parsed.errors) && parsed.errors.length
      ? parsed.errors.join('; ')
      : [parsed.subtype, parsed.stop_reason, parsed.result].filter(Boolean).join(' / ') || stderr || 'unknown error'
    const err = new Error(`Claude CLI returned an error result: ${detail}`)
    err.claudeCliErrorResult = true
    throw err
  }

  return {
    content: typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result || ''),
    usage: parsed.usage,
    raw: parsed
  }
}

const runClaudeCli = ({
  command,
  args,
  input,
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER
}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stdout = []
  const stderr = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let timedOut = false
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)
    : null

  const collect = (chunks, label) => chunk => {
    const buffer = Buffer.from(chunk)
    if (label === 'stdout') stdoutBytes += buffer.length
    else stderrBytes += buffer.length
    if (stdoutBytes + stderrBytes > maxBuffer) {
      child.kill('SIGTERM')
      reject(new Error(`Claude CLI output exceeded ${maxBuffer} bytes`))
      return
    }
    chunks.push(buffer)
  }

  child.stdout.on('data', collect(stdout, 'stdout'))
  child.stderr.on('data', collect(stderr, 'stderr'))
  child.on('error', error => {
    if (timer) clearTimeout(timer)
    reject(error)
  })
  child.on('close', code => {
    if (timer) clearTimeout(timer)
    const out = Buffer.concat(stdout).toString('utf8')
    const err = Buffer.concat(stderr).toString('utf8')
    if (timedOut) {
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`))
    } else if (code !== 0 && !out.trim()) {
      reject(new Error(`Claude CLI exited ${code}: ${preview(err)}`))
    } else {
      resolve({ code, stdout: out, stderr: err })
    }
  })
  child.stdin.end(input || '')
})

const preview = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500)

// A 429 / token-rate-limit error needs a full per-minute backoff, not a quick retry.
const isRateLimitError = error => /\b429\b|rate limit|exceed your organization|tokens per minute/i.test(String(error && error.message || ''))

class ClaudeCliProvider {
  constructor (options = {}) {
    this.command = options.command || DEFAULT_COMMAND
    this.model = options.model || DEFAULT_MODEL
    this.cwd = options.cwd || process.cwd()
    this.env = options.env || process.env
    this.runner = options.runner || runClaudeCli
    this.extraArgs = options.extraArgs || []
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
    this.maxBuffer = options.maxBuffer || DEFAULT_MAX_BUFFER
    this.maxBudgetUsd = options.maxBudgetUsd || process.env.SESSION_INDEXER_CLAUDE_CLI_MAX_BUDGET_USD || ''
    this.maxAttempts = Number(options.maxAttempts || process.env.SESSION_INDEXER_CLAUDE_CLI_ATTEMPTS || 5)
    this.retryBackoffMs = Number(options.retryBackoffMs || process.env.SESSION_INDEXER_CLAUDE_CLI_RETRY_BACKOFF_MS || 1500)
    this.rateLimitBackoffMs = Number(options.rateLimitBackoffMs || process.env.SESSION_INDEXER_CLAUDE_CLI_RATE_LIMIT_BACKOFF_MS || 60000)
  }

  async chat (messages, options = {}) {
    const split = splitMessages(messages)
    const model = options.model || this.model
    const maxBudgetUsd = options.maxBudgetUsd !== undefined ? options.maxBudgetUsd : this.maxBudgetUsd
    const args = buildClaudeCliArgs({
      model,
      systemPrompt: options.systemPrompt || split.systemPrompt,
      maxBudgetUsd,
      extraArgs: options.extraArgs || this.extraArgs
    })
    // `claude -p` calls fail transiently (overload, an `is_error` result envelope,
    // a spawn/timeout hiccup). The summary work queue aborts the whole index on the
    // first throw, so a single flaky call would otherwise kill a large reindex.
    // Retry a few times with linear backoff before surfacing the error.
    const maxAttempts = Math.max(1, Number(options.maxAttempts || this.maxAttempts || 3))
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.runner({
          command: options.command || this.command,
          args,
          input: split.prompt,
          cwd: options.cwd || this.cwd,
          env: options.env || this.env,
          timeoutMs: options.timeoutMs || this.timeoutMs,
          maxBuffer: options.maxBuffer || this.maxBuffer
        })
        const parsed = parseClaudeCliResult(result.stdout, result.stderr)
        return {
          message: {
            role: 'assistant',
            content: parsed.content
          },
          usage: parsed.usage,
          raw: parsed.raw,
          request: {
            provider: 'claude-cli',
            args,
            model,
            attempts: attempt
          }
        }
      } catch (error) {
        lastError = error
        if (attempt >= maxAttempts) break
        // A 429 is a per-minute token-rate limit — short backoff won't help, the
        // bucket only refills on the minute boundary. Wait a full window so the next
        // attempt has fresh budget; use a short linear backoff for other transients.
        const delay = isRateLimitError(error)
          ? (this.rateLimitBackoffMs || 60000)
          : attempt * (this.retryBackoffMs || 1500)
        if (typeof options.onRetry === 'function') {
          try {
            options.onRetry({
              attempt,
              nextAttempt: attempt + 1,
              maxAttempts,
              backoffMs: delay,
              retryAt: new Date(Date.now() + delay).toISOString(),
              rateLimited: isRateLimitError(error),
              error: error.message
            })
          } catch (_err) {}
        }
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    throw lastError
  }
}

module.exports = {
  ClaudeCliProvider,
  buildClaudeCliArgs,
  parseClaudeCliResult,
  runClaudeCli,
  splitMessages
}
