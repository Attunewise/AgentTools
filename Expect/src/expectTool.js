const path = require('path')
const { HybridExpectStream, runExpectScript } = require('./hybridExpect.js')

let ptyModule = null

const getPty = () => {
  if (ptyModule) return ptyModule
  const candidates = [
    '@lydell/node-pty',
    path.join(__dirname, '..', 'node_modules', '@lydell', 'node-pty')
  ]
  const errors = []
  for (const candidate of candidates) {
    try {
      ptyModule = require(candidate)
      return ptyModule
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`)
    }
  }
  throw new Error(`Unable to load @lydell/node-pty for Expect.\n${errors.join('\n')}`)
}

const resolveShell = shellOverride => {
  if (shellOverride) return shellOverride
  if (process.platform === 'win32') return 'cmd.exe'
  return process.env.SHELL || '/bin/bash'
}

class ExpectTool {
  constructor() {
    this.sessions = new Map()
    this.nextSessionId = 1
  }

  async spawn({
    cmd,
    workdir,
    cols = 80,
    rows = 24,
    login = true,
    shell: shellOverride
  } = {}) {
    if (!cmd) throw new Error('cmd is required')

    const shell = resolveShell(shellOverride)
    const args = []
    if (process.platform !== 'win32' && login) args.push('-l')
    args.push(process.platform === 'win32' ? '/c' : '-c', cmd)

    const pty = getPty()
    const child = pty.spawn(shell, args, {
      name: process.env.TERM || 'xterm-256color',
      cols,
      rows,
      cwd: workdir || process.cwd(),
      env: { ...process.env }
    })

    const stream = new HybridExpectStream({
      write: text => child.write(text),
      kill: () => child.kill()
    })
    const session = {
      id: this.nextSessionId++,
      cmd,
      child,
      stream,
      exited: false,
      exitCode: null
    }
    child.onData(data => stream.append(data))
    child.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
      stream.end()
    })
    this.sessions.set(session.id, session)

    return {
      session_id: session.id,
      process_running: true
    }
  }

  async eval({
    session_id,
    script,
    max_output_chars = 20000
  } = {}, context = {}) {
    if (session_id == null) throw new Error('session_id is required')
    if (!script) throw new Error('script is required')

    const session = this.sessions.get(session_id)
    if (!session) throw new Error(`Expect session ${session_id} not found`)

    const result = await runExpectScript({
      script,
      stream: session.stream,
      context,
      console
    })

    return {
      ...result,
      transcript: this.truncate(result.transcript, max_output_chars),
      remainingBuffer: this.truncate(result.remainingBuffer, max_output_chars),
      process_exited: session.exited,
      process_exit_code: session.exitCode
    }
  }

  async close({ session_id } = {}) {
    if (session_id == null) throw new Error('session_id is required')
    const session = this.sessions.get(session_id)
    if (!session) return { closed: false, reason: 'not_found' }
    try {
      session.child.kill()
    } catch (_err) {
      // node-pty kill can throw after process exit.
    }
    this.sessions.delete(session_id)
    return { closed: true }
  }

  async run({
    cmd,
    script,
    workdir,
    cols = 80,
    rows = 24,
    login = true,
    shell,
    kill_on_finish = true,
    max_output_chars = 20000
  } = {}, context = {}) {
    const spawned = await this.spawn({ cmd, workdir, cols, rows, login, shell })
    try {
      return await this.eval({
        session_id: spawned.session_id,
        script,
        max_output_chars
      }, context)
    } finally {
      if (kill_on_finish) await this.close({ session_id: spawned.session_id })
    }
  }

  truncate(value, maxChars) {
    const text = String(value || '')
    const limit = Number(maxChars)
    if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text
    return text.slice(text.length - limit)
  }
}

module.exports = {
  ExpectTool,
  getPty,
  resolveShell
}
