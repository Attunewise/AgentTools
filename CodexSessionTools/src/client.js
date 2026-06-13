const childProcess = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const {
  codexHomeForSessionsRoot,
  defaultCodexSessionRoot
} = require('./index.js')

const SERVER_BIN = path.resolve(__dirname, '..', 'bin', 'codex-session-server.js')
const DEFAULT_START_TIMEOUT_MS = 5000
const DEFAULT_REQUEST_TIMEOUT_MS = 3000
const DEFAULT_EXEC_REQUEST_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_LOCK_STALE_MS = 30000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const serverInfoPath = sessionRoot => path.join(
  path.basename(normalizeSessionRoot(sessionRoot)) === 'sessions'
    ? codexHomeForSessionsRoot(sessionRoot)
    : normalizeSessionRoot(sessionRoot),
  'codex-session-server.json'
)

const normalizeSessionRoot = root => path.resolve(root || defaultCodexSessionRoot())

const serverUrl = info => info && (info.url || (
  info.host && info.port ? `http://${info.host}:${info.port}` : null
))

const readServerInfo = statePath => {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch (_) {
    return null
  }
}

const writeServerInfo = (statePath, info) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`)
  fs.renameSync(tmp, statePath)
}

const removeServerInfo = (statePath, pid = null) => {
  const current = readServerInfo(statePath)
  if (pid && current && current.pid && current.pid !== pid) return
  try {
    fs.unlinkSync(statePath)
  } catch (_) {
    // Missing state is fine during concurrent shutdown.
  }
}

const requestJson = (info, method, route, body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const base = serverUrl(info)
  if (!base) return Promise.reject(new Error('Codex session server info is missing host/port'))
  const url = new URL(route, base)
  const payload = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      timeout: timeoutMs,
      headers: payload
        ? {
            'content-type': 'application/json',
            'content-length': payload.length
          }
        : {}
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        let parsed = null
        try {
          parsed = text ? JSON.parse(text) : null
        } catch (err) {
          reject(new Error(`Codex session server returned invalid JSON: ${err.message}`))
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(parsed && parsed.error ? parsed.error : `Codex session server HTTP ${res.statusCode}`)
          if (parsed && parsed.code) err.code = parsed.code
          reject(err)
          return
        }
        resolve(parsed)
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('Codex session server request timed out'))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

class CodexSessionServerClient {
  constructor(info, options = {}) {
    this.info = info
    this.statePath = options.statePath || null
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
  }

  status() {
    return requestJson(this.info, 'GET', '/status', null, this.requestTimeoutMs)
  }

  refresh(reason = 'client:refresh') {
    return requestJson(this.info, 'POST', '/refresh', { reason }, this.requestTimeoutMs)
  }

  resolveMarker(args = {}) {
    return requestJson(this.info, 'POST', '/resolve-marker', args, this.requestTimeoutMs)
  }

  latestMarker(args = {}) {
    return requestJson(this.info, 'POST', '/latest-marker', args, this.requestTimeoutMs)
  }

  exec(args = {}) {
    return requestJson(this.info, 'POST', '/exec', args, args.requestTimeoutMs || args.request_timeout_ms || DEFAULT_EXEC_REQUEST_TIMEOUT_MS)
  }

  appServerThreadList(args = {}) {
    return requestJson(this.info, 'POST', '/app-server/thread-list', args, args.requestTimeoutMs || args.request_timeout_ms || this.requestTimeoutMs)
  }

  appServerThreadRead(args = {}) {
    return requestJson(this.info, 'POST', '/app-server/thread-read', args, args.requestTimeoutMs || args.request_timeout_ms || this.requestTimeoutMs)
  }

  reconcileThread(args = {}) {
    return requestJson(this.info, 'POST', '/reconcile-thread', args, this.requestTimeoutMs)
  }

  diagnostics(args = {}) {
    return requestJson(this.info, 'POST', '/diagnostics', args, this.requestTimeoutMs)
  }

  stop() {
    // Shared clients do not own the source-of-truth server.
  }

  shutdown() {
    return requestJson(this.info, 'POST', '/shutdown', {}, this.requestTimeoutMs)
  }
}

const validateServerInfo = async (info, sessionRoot, options = {}) => {
  if (!info || !serverUrl(info)) return null
  try {
    const status = await requestJson(info, 'GET', '/status', null, options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)
    if (path.resolve(status.session_root) !== path.resolve(sessionRoot)) return null
    return new CodexSessionServerClient(info, options)
  } catch (_) {
    return null
  }
}

const acquireLock = (lockPath, staleMs = DEFAULT_LOCK_STALE_MS) => {
  try {
    fs.mkdirSync(lockPath)
    return true
  } catch (err) {
    if (err && err.code !== 'EEXIST') throw err
  }
  try {
    const stat = fs.statSync(lockPath)
    if (Date.now() - stat.mtimeMs > staleMs) {
      fs.rmSync(lockPath, { recursive: true, force: true })
      fs.mkdirSync(lockPath)
      return true
    }
  } catch (_) {
    // Another process may be changing the lock; caller will wait.
  }
  return false
}

const releaseLock = lockPath => {
  try {
    fs.rmdirSync(lockPath)
  } catch (_) {
    // Another process may have cleaned a stale lock.
  }
}

const waitForServerLine = (child, timeoutMs) => new Promise((resolve, reject) => {
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    reject(new Error('Codex session server did not announce readiness'))
  }, timeoutMs)

  const cleanup = () => {
    clearTimeout(timer)
    child.stdout.destroy()
    child.stderr.destroy()
  }

  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8')
    const newline = stdout.indexOf('\n')
    if (newline < 0) return
    const line = stdout.slice(0, newline).trim()
    try {
      const parsed = JSON.parse(line)
      cleanup()
      resolve(parsed)
    } catch (err) {
      cleanup()
      reject(new Error(`Codex session server readiness JSON was invalid: ${err.message}`))
    }
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8')
    stderr = stderr.slice(-4000)
  })
  child.on('error', err => {
    cleanup()
    reject(err)
  })
  child.on('exit', code => {
    cleanup()
    reject(new Error(`Codex session server exited before readiness with code ${code}; stderr: ${stderr.trim()}`))
  })
})

const startServerProcess = async options => {
  const argv = [
    SERVER_BIN,
    '--session-root', options.sessionRoot,
    '--state-path', options.statePath
  ]
  if (options.codexHome) argv.push('--codex-home', options.codexHome)
  if (options.execCommand) argv.push('--exec-command', options.execCommand)
  if (options.host) argv.push('--host', options.host)
  if (options.port !== undefined) argv.push('--port', String(options.port))
  if (options.watch === false) argv.push('--no-watch')
  const child = childProcess.spawn(process.execPath, argv, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })
  const announced = await waitForServerLine(child, options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS)
  child.unref()
  return {
    ...announced,
    pid: child.pid,
    started_by_pid: process.pid,
    url: `http://${announced.host}:${announced.port}`
  }
}

const connectOrStartCodexSessionServer = async (options = {}) => {
  const sessionRoot = normalizeSessionRoot(options.sessionRoot)
  const statePath = options.statePath || serverInfoPath(sessionRoot)
  const lockPath = options.lockPath || `${statePath}.lock`
  const existing = await validateServerInfo(readServerInfo(statePath), sessionRoot, {
    statePath,
    requestTimeoutMs: options.requestTimeoutMs
  })
  if (existing) return existing

  const start = Date.now()
  let locked = acquireLock(lockPath, options.lockStaleMs)
  while (!locked && Date.now() - start < (options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS)) {
    await sleep(100)
    const client = await validateServerInfo(readServerInfo(statePath), sessionRoot, {
      statePath,
      requestTimeoutMs: options.requestTimeoutMs
    })
    if (client) return client
    locked = acquireLock(lockPath, options.lockStaleMs)
  }
  if (!locked) throw new Error(`Could not acquire Codex session server lock: ${lockPath}`)

  try {
    const afterLock = await validateServerInfo(readServerInfo(statePath), sessionRoot, {
      statePath,
      requestTimeoutMs: options.requestTimeoutMs
    })
    if (afterLock) return afterLock
    const info = await startServerProcess({
      ...options,
      sessionRoot,
      statePath
    })
    writeServerInfo(statePath, info)
    return new CodexSessionServerClient(info, {
      statePath,
      requestTimeoutMs: options.requestTimeoutMs
    })
  } finally {
    releaseLock(lockPath)
  }
}

module.exports = {
  CodexSessionServerClient,
  connectOrStartCodexSessionServer,
  readServerInfo,
  removeServerInfo,
  requestJson,
  serverInfoPath,
  serverUrl,
  validateServerInfo,
  writeServerInfo
}
