const childProcess = require('node:child_process')

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/

const pushFlag = (argv, flag, value) => {
  if (value === undefined || value === null || value === '') return
  argv.push(flag, String(value))
}

const pushBool = (argv, flag, value) => {
  if (value) argv.push(flag)
}

const pushRepeat = (argv, flag, values) => {
  if (!values) return
  for (const value of Array.isArray(values) ? values : [values]) pushFlag(argv, flag, value)
}

const configPairs = config => {
  if (!config) return []
  if (Array.isArray(config)) return config
  return Object.entries(config).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

const buildCodexExecArgs = (args = {}) => {
  const argv = ['exec']
  const json = args.json !== false
  pushBool(argv, '--json', json)
  pushFlag(argv, '--cd', args.cwd || args.workdir)
  pushFlag(argv, '--model', args.model)
  pushFlag(argv, '--profile', args.profile)
  pushFlag(argv, '--sandbox', args.sandbox)
  pushFlag(argv, '--output-schema', args.outputSchema || args.output_schema)
  pushFlag(argv, '--output-last-message', args.outputLastMessage || args.output_last_message)
  pushRepeat(argv, '--image', args.image || args.images)
  for (const pair of configPairs(args.config)) pushFlag(argv, '--config', pair)
  pushBool(argv, '--skip-git-repo-check', args.skipGitRepoCheck || args.skip_git_repo_check)
  pushBool(argv, '--ignore-user-config', args.ignoreUserConfig || args.ignore_user_config)
  pushBool(argv, '--ignore-rules', args.ignoreRules || args.ignore_rules)
  pushBool(argv, '--dangerously-bypass-approvals-and-sandbox', args.dangerouslyBypassApprovalsAndSandbox || args.dangerously_bypass_approvals_and_sandbox)
  pushBool(argv, '--dangerously-bypass-hook-trust', args.dangerouslyBypassHookTrust || args.dangerously_bypass_hook_trust)

  const resumeId = args.resumeSessionId || args.resume_session_id
  if (resumeId || args.resumeLast || args.resume_last) {
    argv.push('resume')
    pushBool(argv, '--last', args.resumeLast || args.resume_last)
    pushBool(argv, '--all', args.all)
    if (resumeId) argv.push(String(resumeId))
  }

  if (args.prompt !== undefined && args.prompt !== null) argv.push(String(args.prompt))
  else if (args.stdin !== undefined && args.stdin !== null) argv.push('-')
  return argv
}

const parseJsonl = text => {
  const events = []
  const invalid = []
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch (err) {
      invalid.push({
        line: i,
        message: err.message,
        preview: line.slice(0, 240)
      })
    }
  }
  return { events, invalid }
}

const collectIds = (value, ids = new Set()) => {
  if (!value) return ids
  if (typeof value === 'string') {
    const match = value.match(UUID_RE)
    if (match) ids.add(match[0])
    return ids
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, ids)
    return ids
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectIds(item, ids)
  }
  return ids
}

const runCodexExec = (args = {}, options = {}) => new Promise((resolve, reject) => {
  const command = options.command || 'codex'
  const argv = buildCodexExecArgs(args)
  const maxOutputBytes = options.maxOutputBytes || args.maxOutputBytes || args.max_output_bytes || DEFAULT_MAX_OUTPUT_BYTES
  const child = childProcess.spawn(command, argv, {
    cwd: args.cwd || args.workdir || options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...(options.env || {})
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stdout = []
  const stderr = []
  let outputBytes = 0
  let outputTooLarge = false
  let timedOut = false
  let settled = false
  const startedAt = Date.now()
  const timeoutMs = args.timeoutMs || args.timeout_ms || options.timeoutMs
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)
    : null

  const append = (chunks, chunk) => {
    outputBytes += chunk.length
    if (outputBytes > maxOutputBytes) {
      outputTooLarge = true
      child.kill('SIGTERM')
      return
    }
    chunks.push(chunk)
  }

  child.stdout.on('data', chunk => append(stdout, chunk))
  child.stderr.on('data', chunk => append(stderr, chunk))
  child.on('error', err => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    reject(err)
  })
  child.on('close', (code, signal) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    const stdoutText = Buffer.concat(stdout).toString('utf8')
    const stderrText = Buffer.concat(stderr).toString('utf8')
    if (timedOut) {
      const err = new Error(`codex exec timed out after ${timeoutMs}ms`)
      err.code = 'CODEX_EXEC_TIMEOUT'
      err.stdout = stdoutText
      err.stderr = stderrText
      reject(err)
      return
    }
    if (outputTooLarge) {
      const err = new Error(`codex exec exceeded output limit`)
      err.code = 'CODEX_EXEC_OUTPUT_LIMIT'
      err.stdout = stdoutText
      err.stderr = stderrText
      reject(err)
      return
    }
    if (code !== 0) {
      const err = new Error(`codex exec failed (${signal ? `signal ${signal}` : `exit ${code}`})`)
      err.code = 'CODEX_EXEC_FAILED'
      err.exitCode = code
      err.signal = signal
      err.stdout = stdoutText
      err.stderr = stderrText
      reject(err)
      return
    }
    const parsed = args.json === false ? { events: [], invalid: [] } : parseJsonl(stdoutText)
    resolve({
      schema: 'codex-session-tools.exec-result.v1',
      command,
      argv,
      cwd: args.cwd || args.workdir || options.cwd || process.cwd(),
      exit_code: code,
      signal,
      duration_ms: Date.now() - startedAt,
      stdout: stdoutText,
      stderr: stderrText,
      json_events: parsed.events,
      invalid_json_lines: parsed.invalid,
      detected_ids: Array.from(collectIds(parsed.events)).sort()
    })
  })
  if (args.stdin !== undefined && args.stdin !== null) child.stdin.end(String(args.stdin))
  else child.stdin.end()
})

module.exports = {
  buildCodexExecArgs,
  parseJsonl,
  runCodexExec
}
