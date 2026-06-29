#!/usr/bin/env node

const http = require('node:http')

const { CodexSessionServerState } = require('../src/server.js')
const {
  removeServerInfo,
  serverInfoPath,
  writeServerInfo
} = require('../src/client.js')

const readJson = req => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return resolve({})
    try {
      resolve(JSON.parse(text))
    } catch (err) {
      reject(err)
    }
  })
  req.on('error', reject)
})

const send = (res, status, data) => {
  const body = `${JSON.stringify(data)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

const parseArgs = argv => {
  const opts = {
    host: '127.0.0.1',
    port: 0,
    watch: true
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--host') opts.host = next()
    else if (arg === '--port') opts.port = Number(next())
    else if (arg === '--session-root') opts.sessionRoot = next()
    else if (arg === '--codex-home') opts.codexHome = next()
    else if (arg === '--exec-command') opts.execCommand = next()
    else if (arg === '--state-path') opts.statePath = next()
    else if (arg === '--no-watch') opts.watch = false
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

const main = async argv => {
  const opts = parseArgs(argv)
  const state = new CodexSessionServerState(opts).start()
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/status') return send(res, 200, state.status())
      if (req.method === 'POST' && req.url === '/refresh') return send(res, 200, state.refresh('http:refresh'))
      if (req.method === 'POST' && req.url === '/resolve-marker') return send(res, 200, state.resolveMarker(await readJson(req)))
      if (req.method === 'POST' && req.url === '/latest-marker') return send(res, 200, state.latestMarker(await readJson(req)))
      if (req.method === 'POST' && req.url === '/exec') return send(res, 200, await state.runExec(await readJson(req)))
      if (req.method === 'POST' && req.url === '/app-server/thread-list') return send(res, 200, await state.appServerThreadList(await readJson(req)))
      if (req.method === 'POST' && req.url === '/app-server/thread-read') return send(res, 200, await state.appServerThreadRead(await readJson(req)))
      if (req.method === 'POST' && req.url === '/reconcile-thread') return send(res, 200, await state.reconcileThread(await readJson(req)))
      if (req.method === 'POST' && req.url === '/diagnostics') return send(res, 200, state.diagnosticsPage(await readJson(req)))
      if (req.method === 'POST' && req.url === '/shutdown') {
        send(res, 200, { ok: true })
        setImmediate(stop)
        return
      }
      return send(res, 404, { error: 'not_found' })
    } catch (err) {
      return send(res, 500, {
        error: err && err.message ? err.message : String(err),
        code: err && err.code
      })
    }
  })
  await new Promise(resolve => server.listen(opts.port, opts.host, resolve))
  const address = server.address()
  const statePath = opts.statePath || serverInfoPath(state.sessionRoot)
  const info = {
    schema: 'codex-session-tools.server-listening.v1',
    host: address.address,
    port: address.port,
    url: `http://${address.address}:${address.port}`,
    pid: process.pid,
    session_root: state.sessionRoot,
    state_path: statePath
  }
  writeServerInfo(statePath, info)
  process.stdout.write(`${JSON.stringify(info)}\n`)
  const stop = () => {
    state.stop()
    removeServerInfo(statePath, process.pid)
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main(process.argv.slice(2)).catch(err => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
