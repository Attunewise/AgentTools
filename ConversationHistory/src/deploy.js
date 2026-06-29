const fs = require('fs')
const os = require('os')
const path = require('path')
const { installRuntimeDependencies } = require('./runtimeDeps.js')
const { REPO_ROOT } = require('./paths.js')

const PLUGIN_NAME = 'conversation-history'
const CONVERSATION_HISTORY_SKILL_NAME = 'conversation_history'
const LOCAL_FILE_DEPENDENCIES = [{
  packageName: 'codex-session-tools',
  sourceDir: path.resolve(REPO_ROOT, '..', 'CodexSessionTools'),
  oldPackageLockKey: '../CodexSessionTools',
  vendorRelativeDir: path.join('vendor', 'CodexSessionTools'),
  deployedSpec: 'file:vendor/CodexSessionTools'
}]

const defaultCodexSkillDir = () => {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(codexHome, 'skills', CONVERSATION_HISTORY_SKILL_NAME)
}

const defaultPiSkillDir = () => {
  const piAgentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
  return path.join(piAgentDir, 'skills', CONVERSATION_HISTORY_SKILL_NAME)
}

const defaultCodexPluginDir = () => path.join(os.homedir(), 'plugins', PLUGIN_NAME)

const defaultPersonalMarketplacePath = () => path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json')

// Claude Code plugin install locations: a local marketplace directory under
// ~/.claude/plugins containing .claude-plugin/marketplace.json, with the plugin
// installed alongside it as ./conversation-history.
const defaultClaudePluginsRoot = () => path.join(os.homedir(), '.claude', 'plugins')

const defaultClaudePluginDir = () => path.join(defaultClaudePluginsRoot(), PLUGIN_NAME)

const defaultClaudeMarketplacePath = () => path.join(defaultClaudePluginsRoot(), '.claude-plugin', 'marketplace.json')

const ensureRootSkill = () => {
  const skillPath = path.join(REPO_ROOT, 'SKILL.md')
  if (!fs.existsSync(skillPath)) throw new Error(`missing root skill file: ${skillPath}`)
}

const ensureRootPlugin = () => {
  ensureRootSkill()
  const manifestPath = path.join(REPO_ROOT, '.codex-plugin', 'plugin.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`missing plugin manifest: ${manifestPath}`)
  ensureConversationHistorySkill()
}

const ensureRootClaudePlugin = () => {
  ensureRootSkill()
  const manifestPath = path.join(REPO_ROOT, '.claude-plugin', 'plugin.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`missing plugin manifest: ${manifestPath}`)
}

const rmIfAllowed = (target, force) => {
  if (!fs.existsSync(target)) {
    try {
      fs.lstatSync(target)
    } catch (_err) {
      return
    }
  }
  if (!force) throw new Error(`${target} already exists; pass --force to replace it`)
  fs.rmSync(target, { recursive: true, force: true })
}

const ensureConversationHistorySkill = () => {
  const skillPath = path.join(REPO_ROOT, 'skills', CONVERSATION_HISTORY_SKILL_NAME, 'SKILL.md')
  if (!fs.existsSync(skillPath)) throw new Error(`missing conversation history skill file: ${skillPath}`)
}

const copyRepo = (dest) => {
  fs.cpSync(REPO_ROOT, dest, {
    recursive: true,
    filter: source => {
      const rel = path.relative(REPO_ROOT, source)
      if (!rel) return true
      const base = path.basename(source)
      if (base === '.DS_Store' || /^#.*#$/.test(base) || /^\.\#/.test(base)) return false
      return ![
        '.git',
        'node_modules',
        '.session-indexer',
        'coverage',
        'tmp'
      ].some(name => rel === name || rel.startsWith(`${name}${path.sep}`))
    }
  })
}

const copyPackageDir = (sourceRoot, dest) => {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(sourceRoot, dest, {
    recursive: true,
    filter: source => {
      const rel = path.relative(sourceRoot, source)
      if (!rel) return true
      const base = path.basename(source)
      if (base === '.DS_Store' || /^#.*#$/.test(base) || /^\.\#/.test(base)) return false
      return ![
        '.git',
        'node_modules',
        'coverage',
        'tmp'
      ].some(name => rel === name || rel.startsWith(`${name}${path.sep}`))
    }
  })
}

const readJsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const writeJsonFile = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const rewritePackageJsonLocalDependencies = (target, dependency) => {
  const packageJsonPath = path.join(target, 'package.json')
  const packageJson = readJsonFile(packageJsonPath)
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (packageJson[field] && packageJson[field][dependency.packageName]) {
      packageJson[field][dependency.packageName] = dependency.deployedSpec
    }
  }
  writeJsonFile(packageJsonPath, packageJson)
}

const rewritePackageLockLocalDependencies = (target, dependency) => {
  const packageLockPath = path.join(target, 'package-lock.json')
  if (!fs.existsSync(packageLockPath)) return
  const packageLock = readJsonFile(packageLockPath)
  const packages = packageLock.packages || {}
  if (packages[''] && packages[''].dependencies && packages[''].dependencies[dependency.packageName]) {
    packages[''].dependencies[dependency.packageName] = dependency.deployedSpec
  }
  const vendorKey = dependency.vendorRelativeDir.replace(/\\/g, '/')
  if (packages[dependency.oldPackageLockKey] && !packages[vendorKey]) {
    packages[vendorKey] = packages[dependency.oldPackageLockKey]
  }
  delete packages[dependency.oldPackageLockKey]
  const nodeModuleKey = `node_modules/${dependency.packageName}`
  if (packages[nodeModuleKey]) {
    packages[nodeModuleKey].resolved = vendorKey
    packages[nodeModuleKey].link = true
  }
  writeJsonFile(packageLockPath, packageLock)
}

const materializeLocalFileDependencies = target => {
  for (const dependency of LOCAL_FILE_DEPENDENCIES) {
    const source = dependency.sourceDir
    if (!fs.existsSync(path.join(source, 'package.json'))) {
      throw new Error(`missing local dependency package: ${source}`)
    }
    const vendorDest = path.join(target, dependency.vendorRelativeDir)
    copyPackageDir(source, vendorDest)
    rewritePackageJsonLocalDependencies(target, dependency)
    rewritePackageLockLocalDependencies(target, dependency)
  }
}

const maybeInstallRuntimeDependencies = ({ target, mode, installDependencies }) => {
  if (installDependencies === false || mode === 'symlink') return false
  installRuntimeDependencies({ cwd: target, stdio: 'inherit' })
  return true
}

const deployCodex = ({ dest, mode = 'copy', force = false, installDependencies = true } = {}) => {
  ensureRootSkill()
  const target = dest || defaultCodexSkillDir()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  rmIfAllowed(target, force)
  if (mode === 'symlink') {
    fs.symlinkSync(REPO_ROOT, target, 'dir')
  } else if (mode === 'copy') {
    copyRepo(target)
    materializeLocalFileDependencies(target)
  } else {
    throw new Error('--mode must be symlink or copy')
  }
  return {
    target: 'codex',
    mode,
    source: REPO_ROOT,
    dest: target,
    skillFile: path.join(target, 'SKILL.md'),
    dependenciesInstalled: maybeInstallRuntimeDependencies({ target, mode, installDependencies })
  }
}

const deployPi = ({ dest, mode = 'copy', force = false, installDependencies = true, piAgentDir } = {}) => {
  ensureRootSkill()
  const target = dest || (piAgentDir ? path.join(piAgentDir, 'skills', CONVERSATION_HISTORY_SKILL_NAME) : defaultPiSkillDir())
  fs.mkdirSync(path.dirname(target), { recursive: true })
  rmIfAllowed(target, force)
  if (mode === 'symlink') {
    fs.symlinkSync(REPO_ROOT, target, 'dir')
  } else if (mode === 'copy') {
    copyRepo(target)
    materializeLocalFileDependencies(target)
  } else {
    throw new Error('--mode must be symlink or copy')
  }
  return {
    target: 'pi',
    mode,
    source: REPO_ROOT,
    dest: target,
    skillFile: path.join(target, 'SKILL.md'),
    dependenciesInstalled: maybeInstallRuntimeDependencies({ target, mode, installDependencies })
  }
}

const installRepoAt = ({ target, mode, force }) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  rmIfAllowed(target, force)
  if (mode === 'symlink') {
    fs.symlinkSync(REPO_ROOT, target, 'dir')
  } else if (mode === 'copy') {
    copyRepo(target)
    materializeLocalFileDependencies(target)
  } else {
    throw new Error('--mode must be symlink or copy')
  }
}

const readMarketplace = marketplacePath => {
  try {
    return JSON.parse(fs.readFileSync(marketplacePath, 'utf8'))
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

const writeMarketplaceEntry = ({ marketplacePath, force = false }) => {
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true })
  const marketplace = readMarketplace(marketplacePath)
  marketplace.name = marketplace.name || 'personal'
  marketplace.interface = marketplace.interface || { displayName: 'Personal' }
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  const entry = {
    name: PLUGIN_NAME,
    source: {
      source: 'local',
      path: `./plugins/${PLUGIN_NAME}`
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL'
    },
    category: 'Productivity'
  }
  const existingIndex = marketplace.plugins.findIndex(plugin => plugin && plugin.name === PLUGIN_NAME)
  if (existingIndex === -1) {
    marketplace.plugins.push(entry)
  } else if (force) {
    marketplace.plugins[existingIndex] = entry
  } else {
    marketplace.plugins[existingIndex] = {
      ...marketplace.plugins[existingIndex],
      ...entry
    }
  }
  fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
  return {
    path: marketplacePath,
    plugin: entry
  }
}

const deployCodexPlugin = ({
  dest,
  mode = 'copy',
  force = false,
  marketplace = true,
  marketplacePath,
  installDependencies = true
} = {}) => {
  ensureRootPlugin()
  const target = dest || defaultCodexPluginDir()
  installRepoAt({ target, mode, force })
  const dependenciesInstalled = maybeInstallRuntimeDependencies({ target, mode, installDependencies })
  const out = {
    target: 'codex-plugin',
    mode,
    source: REPO_ROOT,
    dest: target,
    pluginManifest: path.join(target, '.codex-plugin', 'plugin.json'),
    dependenciesInstalled
  }
  if (marketplace) {
    out.marketplace = writeMarketplaceEntry({
      marketplacePath: marketplacePath || defaultPersonalMarketplacePath(),
      force
    })
  }
  return out
}

const readClaudeMarketplace = marketplacePath => {
  try {
    return JSON.parse(fs.readFileSync(marketplacePath, 'utf8'))
  } catch (_err) {
    return {
      name: 'personal',
      owner: { name: 'Personal' },
      plugins: []
    }
  }
}

const writeClaudeMarketplaceEntry = ({ marketplacePath, pluginDir, force = false }) => {
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true })
  const marketplace = readClaudeMarketplace(marketplacePath)
  marketplace.name = marketplace.name || 'personal'
  marketplace.owner = marketplace.owner || { name: 'Personal' }
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  // Plugin sources are resolved relative to the marketplace root directory, which
  // is the parent of the .claude-plugin/ folder holding marketplace.json.
  const marketplaceRoot = path.dirname(path.dirname(marketplacePath))
  const relative = path.relative(marketplaceRoot, pluginDir) || '.'
  const entry = {
    name: PLUGIN_NAME,
    source: `./${relative}`.replace(/\\/g, '/'),
    description: 'Recover prior conversation context from a hierarchical, paged, lossless transcript index.',
    category: 'Productivity'
  }
  const existingIndex = marketplace.plugins.findIndex(plugin => plugin && plugin.name === PLUGIN_NAME)
  if (existingIndex === -1) {
    marketplace.plugins.push(entry)
  } else if (force) {
    marketplace.plugins[existingIndex] = entry
  } else {
    marketplace.plugins[existingIndex] = {
      ...marketplace.plugins[existingIndex],
      ...entry
    }
  }
  fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
  return {
    path: marketplacePath,
    marketplaceRoot,
    marketplaceName: marketplace.name,
    plugin: entry
  }
}

const deployClaudePlugin = ({
  dest,
  mode = 'copy',
  force = false,
  marketplace = true,
  marketplacePath,
  installDependencies = true
} = {}) => {
  ensureRootClaudePlugin()
  const target = dest || defaultClaudePluginDir()
  installRepoAt({ target, mode, force })
  const dependenciesInstalled = maybeInstallRuntimeDependencies({ target, mode, installDependencies })
  const out = {
    target: 'claude-plugin',
    mode,
    source: REPO_ROOT,
    dest: target,
    pluginManifest: path.join(target, '.claude-plugin', 'plugin.json'),
    dependenciesInstalled
  }
  if (marketplace) {
    out.marketplace = writeClaudeMarketplaceEntry({
      marketplacePath: marketplacePath || defaultClaudeMarketplacePath(),
      pluginDir: target,
      force
    })
    out.hint = {
      marketplaceAdd: `claude plugin marketplace add ${out.marketplace.marketplaceRoot}`,
      install: `claude plugin install ${PLUGIN_NAME}@${out.marketplace.marketplaceName}`
    }
  }
  return out
}

const deploySkill = opts => {
  const target = opts.target || 'codex'
  if (target === 'codex') return deployCodex(opts)
  if (target === 'pi') return deployPi(opts)
  if (target === 'codex-plugin') return deployCodexPlugin(opts)
  if (target === 'claude-plugin') return deployClaudePlugin(opts)
  throw new Error(`unsupported deploy target: ${target}`)
}

module.exports = {
  defaultCodexSkillDir,
  defaultPiSkillDir,
  defaultCodexPluginDir,
  defaultClaudePluginDir,
  defaultClaudeMarketplacePath,
  defaultPersonalMarketplacePath,
  deploySkill,
  REPO_ROOT,
  CONVERSATION_HISTORY_SKILL_NAME,
  PLUGIN_NAME
}
