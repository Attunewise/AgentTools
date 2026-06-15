#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_MARKETPLACE_PATH = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json')
const DEFAULT_PLUGINS_ROOT = path.join(os.homedir(), 'plugins')

const PLUGINS = [
  { name: 'conversation-history', source: 'ConversationHistory' },
  { name: 'agentdoc', source: 'AgentDoc' },
  { name: 'codex-session-tools', source: 'CodexSessionTools' },
  { name: 'worktree-tools', source: 'WorktreeTools' },
  { name: 'expect', source: 'Expect' }
]

const usage = () => `
Usage:
  node scripts/deploy-codex-plugins.js [--only name[,name...]] [--plugins-root dir] [--marketplace-path file] [--cachebuster token|--no-cachebuster] [--dry-run]

Copies AgentTools Codex plugins to a local personal marketplace layout and updates marketplace.json.

Defaults:
  plugins root:      ${DEFAULT_PLUGINS_ROOT}
  marketplace path: ${DEFAULT_MARKETPLACE_PATH}
`.trim()

const expandHome = value => {
  if (!value) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

const timestampCachebuster = () => {
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '')
  return `local-${stamp}`
}

const parseArgs = argv => {
  const opts = {
    only: null,
    pluginsRoot: DEFAULT_PLUGINS_ROOT,
    marketplacePath: DEFAULT_MARKETPLACE_PATH,
    cachebuster: timestampCachebuster(),
    dryRun: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--only') opts.only = new Set(next().split(',').map(item => item.trim()).filter(Boolean))
    else if (arg === '--plugins-root') opts.pluginsRoot = path.resolve(expandHome(next()))
    else if (arg === '--marketplace-path') opts.marketplacePath = path.resolve(expandHome(next()))
    else if (arg === '--cachebuster') opts.cachebuster = next()
    else if (arg === '--no-cachebuster') opts.cachebuster = ''
    else if (arg === '--dry-run') opts.dryRun = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

const selectedPlugins = opts => {
  const plugins = opts.only
    ? PLUGINS.filter(plugin => opts.only.has(plugin.name))
    : PLUGINS
  const known = new Set(PLUGINS.map(plugin => plugin.name))
  for (const name of opts.only || []) {
    if (!known.has(name)) throw new Error(`unknown plugin in --only: ${name}`)
  }
  return plugins
}

const shouldCopy = source => {
  const rel = path.relative(REPO_ROOT, source)
  if (!rel) return true
  const base = path.basename(source)
  if (base === '.DS_Store' || /^#.*#$/.test(base) || /^\.\#/.test(base)) return false
  return ![
    '.git',
    '.session-indexer',
    'coverage',
    'tmp'
  ].some(name => rel === name || rel.startsWith(`${name}${path.sep}`))
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const updateVersionCachebuster = (pluginRoot, cachebuster) => {
  if (!cachebuster) return null
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json')
  const manifest = readJson(manifestPath)
  const before = manifest.version
  const base = String(before || '0.1.0').split('+')[0]
  manifest.version = `${base}+codex.${cachebuster}`
  writeJson(manifestPath, manifest)
  return { before, after: manifest.version }
}

const chmodBins = pluginRoot => {
  const packagePath = path.join(pluginRoot, 'package.json')
  if (!fs.existsSync(packagePath)) return []
  const pkg = readJson(packagePath)
  const bins = typeof pkg.bin === 'string'
    ? [pkg.bin]
    : Object.values(pkg.bin || {})
  const changed = []
  for (const rel of bins) {
    const file = path.join(pluginRoot, rel)
    if (!fs.existsSync(file)) continue
    fs.chmodSync(file, 0o755)
    changed.push(file)
  }
  return changed
}

const validatePluginShape = pluginRoot => {
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`missing plugin manifest: ${manifestPath}`)
  const manifest = readJson(manifestPath)
  if (!manifest.name) throw new Error(`plugin manifest missing name: ${manifestPath}`)
  if (manifest.mcpServers && !fs.existsSync(path.join(pluginRoot, '.mcp.json'))) {
    throw new Error(`plugin manifest references missing .mcp.json: ${pluginRoot}`)
  }
  if (manifest.skills && !fs.existsSync(path.join(pluginRoot, 'skills'))) {
    throw new Error(`plugin manifest references missing skills directory: ${pluginRoot}`)
  }
  return manifest
}

const marketplaceEntry = plugin => ({
  name: plugin.name,
  source: {
    source: 'local',
    path: `./plugins/${plugin.name}`
  },
  policy: {
    installation: 'AVAILABLE',
    authentication: 'ON_INSTALL'
  },
  category: 'Productivity'
})

const readMarketplace = marketplacePath => {
  try {
    return readJson(marketplacePath)
  } catch (_err) {
    return {
      name: 'personal',
      interface: {
        displayName: 'Personal'
      },
      plugins: []
    }
  }
}

const updateMarketplace = (marketplacePath, plugins, dryRun) => {
  const marketplace = readMarketplace(marketplacePath)
  marketplace.name = marketplace.name || 'personal'
  marketplace.interface = marketplace.interface || { displayName: 'Personal' }
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  for (const plugin of plugins) {
    const next = marketplaceEntry(plugin)
    const index = marketplace.plugins.findIndex(item => item && item.name === plugin.name)
    if (index === -1) marketplace.plugins.push(next)
    else marketplace.plugins[index] = { ...marketplace.plugins[index], ...next }
  }
  if (!dryRun) writeJson(marketplacePath, marketplace)
  return {
    path: marketplacePath,
    name: marketplace.name,
    pluginCount: marketplace.plugins.length
  }
}

const deployPlugin = (plugin, opts) => {
  const source = path.join(REPO_ROOT, plugin.source)
  const dest = path.join(opts.pluginsRoot, plugin.name)
  validatePluginShape(source)
  if (opts.dryRun) {
    return { name: plugin.name, source, dest, dryRun: true }
  }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(source, dest, {
    recursive: true,
    dereference: true,
    filter: shouldCopy
  })
  const manifest = validatePluginShape(dest)
  return {
    name: plugin.name,
    source,
    dest,
    version: updateVersionCachebuster(dest, opts.cachebuster),
    manifestName: manifest.name,
    bins: chmodBins(dest)
  }
}

const run = opts => {
  if (opts.help) return usage()
  const plugins = selectedPlugins(opts)
  const deployed = plugins.map(plugin => deployPlugin(plugin, opts))
  const marketplace = updateMarketplace(opts.marketplacePath, plugins, opts.dryRun)
  return {
    schema: 'agenttools.codex-plugin-deploy.v1',
    pluginsRoot: opts.pluginsRoot,
    marketplace,
    cachebuster: opts.cachebuster || null,
    deployed
  }
}

const main = () => {
  const result = run(parseArgs(process.argv.slice(2)))
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error(err.stack || err.message)
    process.exit(1)
  }
}

module.exports = {
  PLUGINS,
  parseArgs,
  run
}
