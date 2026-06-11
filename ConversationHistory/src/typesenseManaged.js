const childProcess = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const { LOCAL_STATE_DIR } = require('./paths.js')

const DEFAULT_MANAGED_TYPESENSE_VERSION = process.env.SESSION_INDEXER_TYPESENSE_VERSION || '30.2'
const DEFAULT_MANAGED_TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'xyz'

const platformName = () => {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'linux') return 'linux'
  throw new Error(`unsupported Typesense platform: ${process.platform}`)
}

const archName = () => {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'amd64'
  throw new Error(`unsupported Typesense architecture: ${process.arch}`)
}

const managedTypesenseRoot = (root = LOCAL_STATE_DIR) => path.join(root, 'typesense')
const managedTypesenseUrl = ({ port } = {}) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('managed Typesense port is not allocated')
  return `http://127.0.0.1:${port}`
}

const managedTypesensePaths = ({
  root = LOCAL_STATE_DIR,
  version = DEFAULT_MANAGED_TYPESENSE_VERSION
} = {}) => {
  const base = managedTypesenseRoot(root)
  const platform = platformName()
  const arch = archName()
  return {
    root: base,
    version,
    platform,
    arch,
    installDir: path.join(base, 'install', version, `${platform}-${arch}`),
    binary: path.join(base, 'install', version, `${platform}-${arch}`, 'typesense-server'),
    downloadsDir: path.join(base, 'downloads'),
    runtimeDir: path.join(base, 'runtime'),
    runtimeStateFile: path.join(base, 'runtime', 'runtime.json'),
    dataDir: path.join(base, 'runtime', 'data'),
    logDir: path.join(base, 'runtime', 'logs'),
    pidFile: path.join(base, 'runtime', 'typesense.pid'),
    stdoutLog: path.join(base, 'runtime', 'logs', 'typesense.out.log'),
    stderrLog: path.join(base, 'runtime', 'logs', 'typesense.err.log')
  }
}

const managedTypesenseLogs = paths => ({
  stdout: paths.stdoutLog,
  stderr: paths.stderrLog
})

const readRuntimeState = paths => {
  if (!fs.existsSync(paths.runtimeStateFile)) return null
  const state = JSON.parse(fs.readFileSync(paths.runtimeStateFile, 'utf8'))
  if (!state || state.schema !== 'session-indexer.managed-typesense-runtime.v1') {
    throw new Error(`invalid managed Typesense runtime state: ${paths.runtimeStateFile}`)
  }
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) {
    throw new Error(`invalid managed Typesense port in ${paths.runtimeStateFile}`)
  }
  if (state.peeringPort !== undefined && (!Number.isInteger(state.peeringPort) || state.peeringPort < 1 || state.peeringPort > 65535)) {
    throw new Error(`invalid managed Typesense peering port in ${paths.runtimeStateFile}`)
  }
  return state
}

const writeRuntimeState = (paths, state) => {
  fs.mkdirSync(paths.runtimeDir, { recursive: true })
  fs.writeFileSync(paths.runtimeStateFile, `${JSON.stringify({
    schema: 'session-indexer.managed-typesense-runtime.v1',
    ...state
  }, null, 2)}\n`)
}

const allocateLocalPort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = address && address.port
    server.close(err => {
      if (err) return reject(err)
      if (!Number.isInteger(port)) return reject(new Error('failed to allocate managed Typesense port'))
      resolve(port)
    })
  })
})

const allocateLocalPortExcept = async excludedPorts => {
  const excluded = new Set(excludedPorts || [])
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await allocateLocalPort()
    if (!excluded.has(port)) return port
  }
  throw new Error('failed to allocate distinct managed Typesense port')
}

const runtimeInfoFromState = (paths, state) => ({
  ...state,
  url: managedTypesenseUrl({ port: state.port }),
  logs: managedTypesenseLogs(paths),
  runtimeStateFile: paths.runtimeStateFile
})

const managedRuntimeInfo = async ({ root = LOCAL_STATE_DIR, version = DEFAULT_MANAGED_TYPESENSE_VERSION } = {}) => {
  const paths = managedTypesensePaths({ root, version })
  const existing = readRuntimeState(paths)
  if (existing) {
    if (!existing.peeringPort) {
      const migrated = {
        ...existing,
        peeringPort: await allocateLocalPortExcept([existing.port]),
        updatedAt: new Date().toISOString()
      }
      writeRuntimeState(paths, migrated)
      return runtimeInfoFromState(paths, migrated)
    }
    return runtimeInfoFromState(paths, existing)
  }
  const port = await allocateLocalPort()
  const peeringPort = await allocateLocalPortExcept([port])
  const state = {
    version,
    port,
    peeringPort,
    allocatedAt: new Date().toISOString()
  }
  writeRuntimeState(paths, state)
  return runtimeInfoFromState(paths, state)
}

const managedRuntimeInfoIfPresent = ({ root = LOCAL_STATE_DIR, version = DEFAULT_MANAGED_TYPESENSE_VERSION } = {}) => {
  const paths = managedTypesensePaths({ root, version })
  const state = readRuntimeState(paths)
  if (!state) return null
  return runtimeInfoFromState(paths, state)
}

const typesenseArchiveName = ({
  version = DEFAULT_MANAGED_TYPESENSE_VERSION,
  platform = platformName(),
  arch = archName()
} = {}) => `typesense-server-${version}-${platform}-${arch}.tar.gz`

const typesenseDownloadUrl = opts => {
  const version = opts && opts.version || DEFAULT_MANAGED_TYPESENSE_VERSION
  return `https://dl.typesense.org/releases/${version}/${typesenseArchiveName(opts)}`
}

const requestModule = url => url.startsWith('https:') ? https : http

const downloadFile = (url, dest, redirects = 0) => new Promise((resolve, reject) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const request = requestModule(url).get(url, response => {
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.resume()
      if (redirects > 5) return reject(new Error(`too many redirects downloading ${url}`))
      const next = new URL(response.headers.location, url).toString()
      return resolve(downloadFile(next, dest, redirects + 1))
    }
    if (response.statusCode !== 200) {
      response.resume()
      return reject(new Error(`download failed ${response.statusCode}: ${url}`))
    }
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
    const out = fs.createWriteStream(tmp)
    response.pipe(out)
    out.on('finish', () => {
      out.close(() => {
        fs.renameSync(tmp, dest)
        resolve(dest)
      })
    })
    out.on('error', err => {
      try {
        fs.unlinkSync(tmp)
      } catch (_unlinkErr) {}
      reject(err)
    })
  })
  request.on('error', reject)
})

const installManagedTypesense = async ({
  root = LOCAL_STATE_DIR,
  version = DEFAULT_MANAGED_TYPESENSE_VERSION,
  force = false,
  downloadUrl
} = {}) => {
  const paths = managedTypesensePaths({ root, version })
  const url = downloadUrl || typesenseDownloadUrl({ version, platform: paths.platform, arch: paths.arch })
  if (!force && fs.existsSync(paths.binary)) {
    return {
      installed: true,
      reused: true,
      version,
      url,
      binary: paths.binary
    }
  }
  fs.mkdirSync(paths.downloadsDir, { recursive: true })
  fs.mkdirSync(paths.installDir, { recursive: true })
  const archive = path.join(paths.downloadsDir, path.basename(url))
  await downloadFile(url, archive)
  const extractDir = `${paths.installDir}.extract-${process.pid}-${Date.now()}`
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  childProcess.execFileSync('tar', ['-xzf', archive, '-C', extractDir], { stdio: 'pipe' })
  const candidates = []
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name === 'typesense-server') candidates.push(file)
    }
  }
  visit(extractDir)
  if (!candidates.length) throw new Error(`download did not contain typesense-server: ${url}`)
  fs.rmSync(paths.installDir, { recursive: true, force: true })
  fs.mkdirSync(paths.installDir, { recursive: true })
  fs.copyFileSync(candidates[0], paths.binary)
  fs.chmodSync(paths.binary, 0o755)
  fs.rmSync(extractDir, { recursive: true, force: true })
  return {
    installed: true,
    reused: false,
    version,
    url,
    binary: paths.binary
  }
}

const readPid = pidFile => {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim()
    if (!raw) throw new Error(`managed Typesense pid file is empty: ${pidFile}`)
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`managed Typesense pid file is invalid: ${pidFile}`)
    return pid
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return null
  }
}

const processIsAlive = pid => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (_err) {
    return false
  }
}

const healthCheck = ({ url, apiKey = DEFAULT_MANAGED_TYPESENSE_API_KEY, timeoutMs = 2000 } = {}) => new Promise(resolve => {
  if (!url) return resolve({ ok: false, error: 'managed Typesense URL is not allocated' })
  const request = requestModule(url).request(`${String(url).replace(/\/+$/, '')}/health`, {
    method: 'GET',
    timeout: timeoutMs,
    headers: {
      'X-TYPESENSE-API-KEY': apiKey
    }
  }, response => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', chunk => {
      body += chunk
    })
    response.on('end', () => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        try {
          return resolve({ ok: true, statusCode: response.statusCode, body: body ? JSON.parse(body) : null })
        } catch (_err) {
          return resolve({ ok: true, statusCode: response.statusCode, body })
        }
      }
      resolve({ ok: false, statusCode: response.statusCode, body })
    })
  })
  request.on('timeout', () => {
    request.destroy(new Error('health check timed out'))
  })
  request.on('error', err => resolve({ ok: false, error: err.message }))
  request.end()
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const managedTypesenseServerArgs = ({
  dataDir,
  apiKey = DEFAULT_MANAGED_TYPESENSE_API_KEY,
  port,
  peeringPort
} = {}) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('managed Typesense port is not allocated')
  if (!Number.isInteger(peeringPort) || peeringPort < 1 || peeringPort > 65535) throw new Error('managed Typesense peering port is not allocated')
  return [
    `--data-dir=${dataDir}`,
    `--api-key=${apiKey}`,
    '--api-address=127.0.0.1',
    `--api-port=${port}`,
    '--peering-address=127.0.0.1',
    `--peering-port=${peeringPort}`,
    '--enable-cors=true',
    '--enable-search-analytics=false'
  ]
}

const managedTypesenseStatus = async ({
  root = LOCAL_STATE_DIR,
  version = DEFAULT_MANAGED_TYPESENSE_VERSION,
  apiKey = DEFAULT_MANAGED_TYPESENSE_API_KEY
} = {}) => {
  const paths = managedTypesensePaths({ root, version })
  const runtime = managedRuntimeInfoIfPresent({ root, version })
  const pid = readPid(paths.pidFile)
  const health = runtime ? await healthCheck({ url: runtime.url, apiKey }) : { ok: false, error: 'managed Typesense runtime has not been allocated' }
  const pidAlive = Boolean(pid && processIsAlive(pid))
  return {
    installed: fs.existsSync(paths.binary),
    running: Boolean(pidAlive || health.ok),
    pid: pidAlive ? pid : null,
    stalePid: pid && !pidAlive ? pid : undefined,
    url: runtime ? runtime.url : null,
    port: runtime ? runtime.port : null,
    peeringPort: runtime ? runtime.peeringPort || null : null,
    version,
    binary: paths.binary,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    logs: managedTypesenseLogs(paths),
    runtimeStateFile: paths.runtimeStateFile,
    health
  }
}

const startManagedTypesense = async ({
  root = LOCAL_STATE_DIR,
  version = DEFAULT_MANAGED_TYPESENSE_VERSION,
  apiKey = DEFAULT_MANAGED_TYPESENSE_API_KEY,
  install = true,
  forceRestart = false,
  timeoutMs = 15000,
  pollMs = 250
} = {}) => {
  const paths = managedTypesensePaths({ root, version })
  const runtime = await managedRuntimeInfo({ root, version })
  const { port, peeringPort, url } = runtime
  const existingHealth = await healthCheck({ url, apiKey })
  if (existingHealth.ok && !forceRestart) {
    const existingPid = readPid(paths.pidFile)
    const pidAlive = Boolean(existingPid && processIsAlive(existingPid))
    return {
      started: false,
      reused: true,
      pid: pidAlive ? existingPid : null,
      stalePid: existingPid && !pidAlive ? existingPid : undefined,
      url,
      port,
      peeringPort,
      version,
      binary: paths.binary,
      logs: managedTypesenseLogs(paths),
      runtimeStateFile: paths.runtimeStateFile,
      health: existingHealth
    }
  }
  const existingPid = readPid(paths.pidFile)
  if (existingPid && !processIsAlive(existingPid)) {
    try {
      fs.unlinkSync(paths.pidFile)
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
    }
  }
  if (forceRestart && processIsAlive(existingPid)) {
    try {
      process.kill(existingPid, 'SIGTERM')
    } catch (err) {
      if (!err || err.code !== 'ESRCH') throw err
    }
  }
  if (!fs.existsSync(paths.binary)) {
    if (!install) throw new Error(`managed Typesense is not installed: ${paths.binary}`)
    await installManagedTypesense({ root, version })
  }
  fs.mkdirSync(paths.dataDir, { recursive: true })
  fs.mkdirSync(paths.logDir, { recursive: true })
  const out = fs.openSync(paths.stdoutLog, 'a')
  const err = fs.openSync(paths.stderrLog, 'a')
  const child = childProcess.spawn(paths.binary, managedTypesenseServerArgs({
    dataDir: paths.dataDir,
    apiKey,
    port,
    peeringPort
  }), {
    detached: true,
    stdio: ['ignore', out, err]
  })
  child.unref()
  fs.closeSync(out)
  fs.closeSync(err)
  fs.writeFileSync(paths.pidFile, `${child.pid}\n`)
  const deadline = Date.now() + timeoutMs
  let health = await healthCheck({ url, apiKey })
  while (!health.ok && Date.now() < deadline) {
    await sleep(pollMs)
    health = await healthCheck({ url, apiKey })
  }
  if (!health.ok) {
    let cleanupError = null
    if (!processIsAlive(child.pid)) {
      try {
        fs.unlinkSync(paths.pidFile)
      } catch (err) {
        if (!err || err.code !== 'ENOENT') cleanupError = err
      }
    }
    const cleanup = cleanupError ? `; cleanupError=${cleanupError.message}` : ''
    const err = new Error(`managed Typesense did not become healthy within ${timeoutMs}ms; stdout=${paths.stdoutLog}; stderr=${paths.stderrLog}; health=${JSON.stringify(health)}${cleanup}`)
    err.health = health
    err.logs = managedTypesenseLogs(paths)
    err.url = url
    err.port = port
    err.peeringPort = peeringPort
    if (cleanupError) err.cleanupError = cleanupError
    throw err
  }
  return {
    started: true,
    reused: false,
    pid: child.pid,
    url,
    port,
    peeringPort,
    version,
    binary: paths.binary,
    health,
    logs: managedTypesenseLogs(paths),
    runtimeStateFile: paths.runtimeStateFile
  }
}

const stopManagedTypesense = async ({
  root = LOCAL_STATE_DIR,
  version = DEFAULT_MANAGED_TYPESENSE_VERSION,
  timeoutMs = 5000,
  pollMs = 100
} = {}) => {
  const paths = managedTypesensePaths({ root, version })
  const pid = readPid(paths.pidFile)
  if (!pid || !processIsAlive(pid)) {
    return {
      stopped: false,
      pid,
      running: false
    }
  }
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + timeoutMs
  while (processIsAlive(pid) && Date.now() < deadline) await sleep(pollMs)
  const running = processIsAlive(pid)
  if (!running) {
    try {
      fs.unlinkSync(paths.pidFile)
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
    }
  }
  return {
    stopped: !running,
    pid,
    running
  }
}

module.exports = {
  DEFAULT_MANAGED_TYPESENSE_API_KEY,
  DEFAULT_MANAGED_TYPESENSE_VERSION,
  healthCheck,
  installManagedTypesense,
  managedRuntimeInfo,
  managedRuntimeInfoIfPresent,
  managedTypesensePaths,
  managedTypesenseServerArgs,
  managedTypesenseStatus,
  managedTypesenseUrl,
  startManagedTypesense,
  stopManagedTypesense,
  typesenseArchiveName,
  typesenseDownloadUrl
}
