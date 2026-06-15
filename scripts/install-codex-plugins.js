#!/usr/bin/env node

const childProcess = require('child_process')
const os = require('os')
const path = require('path')
const readline = require('readline')

const { PLUGINS } = require('./deploy-codex-plugins.js')

const DEFAULT_MARKETPLACE_PATH = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json')

const usage = () => `
Usage:
  node scripts/install-codex-plugins.js [--only name[,name...]] [--marketplace-path file] [--codex path] [--skip-upgrade] [--no-reload]

Installs AgentTools plugins through codex app-server, then reloads MCP server config and prints status.
Run scripts/deploy-codex-plugins.js first, or pass --deploy to do both.
`.trim()

const expandHome = value => {
  if (!value) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

const parseArgs = argv => {
  const opts = {
    only: null,
    marketplacePath: DEFAULT_MARKETPLACE_PATH,
    codex: process.env.CODEX_CLI || 'codex',
    upgrade: true,
    reload: true,
    deploy: false
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
    else if (arg === '--marketplace-path') opts.marketplacePath = path.resolve(expandHome(next()))
    else if (arg === '--codex') opts.codex = next()
    else if (arg === '--skip-upgrade') opts.upgrade = false
    else if (arg === '--no-reload') opts.reload = false
    else if (arg === '--deploy') opts.deploy = true
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

class AppServerClient {
  constructor({ command }) {
    this.command = command
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.notifications = []
    this.initialized = false
  }

  start() {
    if (this.proc) return
    this.proc = childProcess.spawn(this.command, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8000)
    })
    readline.createInterface({ input: this.proc.stdout })
      .on('line', line => this.handleLine(line))
    this.proc.on('exit', code => {
      const err = new Error(`codex app-server exited with code ${code}; stderr=${this.stderr}`)
      for (const pending of this.pending.values()) pending.reject(err)
      this.pending.clear()
    })
  }

  handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (_err) {
      this.notifications.push({ method: 'invalid_json', line: line.slice(0, 240) })
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    this.notifications.push(message)
    this.notifications = this.notifications.slice(-100)
  }

  notify(method, params) {
    this.start()
    const message = params === undefined ? { method } : { method, params }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params, timeoutMs = 120000) {
    this.start()
    const id = this.nextId++
    const message = params === undefined ? { method, id } : { method, id, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`app-server request timed out: ${method}; stderr=${this.stderr}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  async initialize() {
    if (this.initialized) return
    await this.request('initialize', {
      clientInfo: {
        name: 'agenttools-plugin-installer',
        title: 'AgentTools Plugin Installer',
        version: '0.1.0'
      }
    })
    this.notify('initialized')
    this.initialized = true
  }

  async stop() {
    if (!this.proc) return
    const proc = this.proc
    this.proc = null
    proc.stdin.end()
    proc.kill('SIGTERM')
    await new Promise(resolve => proc.once('exit', resolve))
  }
}

const deployFirst = opts => {
  const deploy = require('./deploy-codex-plugins.js')
  const args = []
  if (opts.only) args.push('--only', [...opts.only].join(','))
  return deploy.run(deploy.parseArgs(args))
}

const summarizeMcpStatus = status => {
  const servers = status && Array.isArray(status.data)
    ? status.data
    : status && Array.isArray(status.servers)
      ? status.servers
      : []
  return servers.map(server => ({
    name: server.name,
    status: server.status || server.startupStatus,
    toolCount: Array.isArray(server.tools)
      ? server.tools.length
      : server.tools && typeof server.tools === 'object'
        ? Object.keys(server.tools).length
        : undefined,
    auth: server.authStatus || server.auth
  }))
}

const hasMcpStatusData = status =>
  Boolean(status && (
    Array.isArray(status.data) && status.data.length ||
    Array.isArray(status.servers) && status.servers.length
  ))

const readFreshMcpStatus = async codex => {
  const fresh = new AppServerClient({ command: codex })
  try {
    await fresh.initialize()
    return await fresh.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' })
  } finally {
    await fresh.stop()
  }
}

const run = async opts => {
  if (opts.help) return usage()
  const plugins = selectedPlugins(opts)
  const deployed = opts.deploy ? deployFirst(opts) : null
  const client = new AppServerClient({ command: opts.codex })
  try {
    await client.initialize()
    let upgrade = null
    if (opts.upgrade) {
      try {
        upgrade = await client.request('marketplace/upgrade', { marketplaceName: 'personal' })
      } catch (err) {
        if (!/not configured as a Git marketplace/i.test(err.message || '')) throw err
        upgrade = {
          skipped: true,
          reason: 'local_marketplace'
        }
      }
    }
    const installResults = []
    for (const plugin of plugins) {
      const result = await client.request('plugin/install', {
        marketplacePath: opts.marketplacePath,
        pluginName: plugin.name
      })
      installResults.push({
        pluginName: plugin.name,
        authPolicy: result.authPolicy,
        appsNeedingAuth: result.appsNeedingAuth || []
      })
    }
    let status = null
    if (opts.reload) {
      await client.request('config/mcpServer/reload')
      status = await client.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' })
      if (!hasMcpStatusData(status)) {
        await client.stop()
        status = await readFreshMcpStatus(opts.codex)
      }
    }
    return {
      schema: 'agenttools.codex-plugin-install.v1',
      deployed,
      marketplacePath: opts.marketplacePath,
      upgrade,
      installed: installResults,
      mcpStatus: summarizeMcpStatus(status)
    }
  } finally {
    await client.stop()
  }
}

const main = async () => {
  const result = await run(parseArgs(process.argv.slice(2)))
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = {
  AppServerClient,
  parseArgs,
  run
}
