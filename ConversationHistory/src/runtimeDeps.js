const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')

const requiredRuntimeModules = [
  '@modelcontextprotocol/sdk/server/mcp.js',
  'chokidar'
]

const runtimeDependenciesPresent = () => {
  try {
    for (const specifier of requiredRuntimeModules) require.resolve(specifier, { paths: [repoRoot] })
    return true
  } catch (_err) {
    return false
  }
}

const waitForLock = lockDir => {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 120000
  while (fs.existsSync(lockDir)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for runtime dependency install lock: ${lockDir}`)
    Atomics.wait(wait, 0, 0, 500)
  }
}

const installRuntimeDependencies = ({ cwd = repoRoot, stdio = 'pipe' } = {}) => {
  const packageLock = path.join(cwd, 'package-lock.json')
  const args = fs.existsSync(packageLock)
    ? ['ci', '--omit=dev', '--ignore-scripts']
    : ['install', '--omit=dev', '--ignore-scripts']
  const env = {
    ...process.env,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false'
  }
  if (stdio === 'inherit') {
    childProcess.execFileSync('npm', args, { cwd, env, stdio: 'inherit' })
    return
  }
  try {
    childProcess.execFileSync('npm', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (err.stdout) process.stderr.write(err.stdout)
    if (err.stderr) process.stderr.write(err.stderr)
    throw err
  }
}

const ensureRuntimeDependencies = () => {
  if (runtimeDependenciesPresent()) return
  const lockDir = path.join(repoRoot, '.runtime-deps-install.lock')
  let locked = false
  try {
    try {
      fs.mkdirSync(lockDir)
      locked = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      waitForLock(lockDir)
      if (runtimeDependenciesPresent()) return
      fs.mkdirSync(lockDir)
      locked = true
    }
    if (!runtimeDependenciesPresent()) installRuntimeDependencies({ cwd: repoRoot })
  } finally {
    if (locked) fs.rmSync(lockDir, { recursive: true, force: true })
  }
  if (!runtimeDependenciesPresent()) throw new Error('runtime dependency installation completed but required packages are still missing')
}

module.exports = {
  ensureRuntimeDependencies,
  installRuntimeDependencies,
  runtimeDependenciesPresent
}
