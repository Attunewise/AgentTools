const childProcess = require('node:child_process')
const readline = require('node:readline')

class CodexAppServerClient {
  constructor(options = {}) {
    this.command = options.command || 'codex'
    this.args = options.args || ['app-server', '--listen', 'stdio://']
    this.cwd = options.cwd || process.cwd()
    this.env = options.env || {}
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.stderr = ''
    this.initialized = false
    this.clientInfo = options.clientInfo || {
      name: 'agent_tools',
      title: 'AgentTools',
      version: '0.1.0'
    }
    this.requestTimeoutMs = options.requestTimeoutMs || 10000
  }

  start() {
    if (this.proc) return this
    this.proc = childProcess.spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    const rl = readline.createInterface({ input: this.proc.stdout })
    rl.on('line', line => this.handleLine(line))
    this.proc.on('exit', code => {
      const err = new Error(`codex app-server exited with code ${code}`)
      for (const pending of this.pending.values()) pending.reject(err)
      this.pending.clear()
    })
    return this
  }

  handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (_) {
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

  sendNotification(method, params = {}) {
    this.start()
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  request(method, params = {}, options = {}) {
    this.start()
    const id = this.nextId++
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex app-server request timed out: ${method}; stderr=${this.stderr}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    })
  }

  async initialize() {
    if (this.initialized) return this.initializeResult
    const result = await this.request('initialize', { clientInfo: this.clientInfo })
    this.sendNotification('initialized')
    this.initialized = true
    this.initializeResult = result
    return result
  }

  async threadList(params = {}) {
    await this.initialize()
    return this.request('thread/list', params)
  }

  async threadRead(threadId, params = {}) {
    await this.initialize()
    return this.request('thread/read', { ...params, threadId })
  }

  async stop() {
    if (!this.proc) return
    const proc = this.proc
    this.proc = null
    try {
      proc.stdin.end()
    } catch (_) {
      // Already closed.
    }
    proc.kill('SIGTERM')
    await new Promise(resolve => proc.once('exit', resolve))
  }
}

module.exports = {
  CodexAppServerClient
}
