const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_LOG_BYTES = 256 * 1024

const logDir = () => process.env.AGENTTOOLS_MCP_LOG_DIR ||
  path.join(os.homedir(), '.local', 'share', 'agenttools', 'mcp-logs')

const safeName = name => String(name || 'mcp-server').replace(/[^a-zA-Z0-9_.-]+/g, '-')

const serializeError = err => ({
  name: err && err.name || 'Error',
  message: err && err.message ? String(err.message).slice(0, 1000) : String(err || '').slice(0, 1000),
  stack: err && err.stack ? String(err.stack).slice(0, 4000) : undefined
})

const rotateIfNeeded = file => {
  try {
    if (fs.statSync(file).size <= MAX_LOG_BYTES) return
    fs.renameSync(file, `${file}.1`)
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      // Logging must never bring down the MCP server.
    }
  }
}

const createMcpLogger = server => {
  const file = path.join(logDir(), `${safeName(server)}.jsonl`)
  const write = (event, fields = {}) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      rotateIfNeeded(file)
      fs.appendFileSync(file, `${JSON.stringify({
        at: new Date().toISOString(),
        server,
        pid: process.pid,
        event,
        ...fields
      })}\n`)
    } catch (_err) {
      // Deliberately silent: stderr is MCP transport-sensitive.
    }
  }
  return {
    file,
    info: write,
    error: (event, err, fields = {}) => write(event, { ...fields, error: serializeError(err) })
  }
}

const installMcpProcessLogging = logger => {
  if (!logger || process.__agenttoolsMcpLoggingInstalled) return
  process.__agenttoolsMcpLoggingInstalled = true
  process.once('uncaughtException', err => {
    logger.error('uncaught_exception', err)
    throw err
  })
  process.once('unhandledRejection', reason => {
    logger.error('unhandled_rejection', reason)
  })
  process.once('exit', code => logger.info('exit', { code }))
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => logger.info('signal', { signal }))
  }
  process.stdin.once('end', () => logger.info('stdin_end'))
  process.stdin.once('close', () => logger.info('stdin_close'))
}

module.exports = {
  createMcpLogger,
  installMcpProcessLogging
}
