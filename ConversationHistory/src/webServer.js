const fs = require('fs')
const http = require('http')
const path = require('path')

const {
  DEFAULT_INDEX_DIR,
  browseIndexWithBackend,
  browseSessionCatalog,
  indexStatus,
  openLinkWithBackend,
  searchIndexWithBackend
} = require('./store.js')
const {
  DEFAULT_TYPESENSE_API_KEY,
  DEFAULT_TYPESENSE_COLLECTION
} = require('./typesense.js')
const {
  DEFAULT_MANAGED_TYPESENSE_VERSION,
  managedTypesenseStatus
} = require('./typesenseManaged.js')

const WEB_ROOT = path.join(__dirname, '..', 'web')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

const toInt = (value, fallback, { min = 0, max = 100 } = {}) => {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

const optionalText = value => {
  const text = String(value || '').trim()
  return text || undefined
}

const routeAgent = params => {
  const agent = optionalText(params.get('agent')) || 'codex'
  return agent === 'all' ? undefined : agent
}

const sessionLink = ({ indexId, sessionId, handle }) => {
  const params = new URLSearchParams()
  if (indexId) params.set('indexId', indexId)
  else if (sessionId) params.set('sessionId', sessionId)
  params.set('handle', handle)
  return `tool:conversation_history://open?${params.toString()}`
}

const recentTime = session => {
  const raw = session.last_modified_at || session.indexed_at
  const time = Date.parse(raw)
  return Number.isFinite(time) ? time : 0
}

const indexedRecentSessions = catalog => ({
  ...catalog,
  sessions: (catalog.sessions || [])
    .filter(session => session && session.session_id && session.index_id)
    .sort((a, b) => recentTime(b) - recentTime(a) || String(a.session_id).localeCompare(String(b.session_id)))
})

const jsonResponse = (res, status, value) => {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

const errorResponse = (res, status, err) => jsonResponse(res, status, {
  error: err && err.message ? err.message : String(err || 'request failed')
})

const safeStaticPath = pathname => {
  const requested = pathname === '/' ? '/index.html' : pathname
  const resolved = path.resolve(WEB_ROOT, `.${decodeURIComponent(requested)}`)
  if (resolved !== WEB_ROOT && !resolved.startsWith(`${WEB_ROOT}${path.sep}`)) return null
  return resolved
}

const sendStatic = (req, res) => {
  const file = safeStaticPath(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!file) return errorResponse(res, 403, new Error('forbidden'))
  fs.readFile(file, (err, body) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return errorResponse(res, 404, new Error('not found'))
      return errorResponse(res, 500, err)
    }
    res.writeHead(200, {
      'content-type': contentTypes[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': body.length
    })
    res.end(body)
  })
}

const backendOpts = opts => ({
  root: opts.indexDir,
  indexDir: opts.indexDir,
  typesenseApiKey: opts.typesenseApiKey,
  typesenseCollection: opts.typesenseCollection,
  typesenseVersion: opts.typesenseVersion
})

const handleApi = async (url, opts) => {
  const params = url.searchParams
  if (url.pathname === '/api/health') {
    let managed = null
    try {
      managed = await managedTypesenseStatus({
        root: opts.indexDir,
        version: opts.typesenseVersion,
        apiKey: opts.typesenseApiKey
      })
    } catch (err) {
      managed = { error: err.message }
    }
    return {
      schema: 'session-indexer.web.health.v1',
      indexDir: opts.indexDir,
      typesenseCollection: opts.typesenseCollection,
      checkedAt: new Date().toISOString(),
      managed
    }
  }
  if (url.pathname === '/api/sessions') {
    const start = toInt(params.get('start'), 0, { min: 0, max: 1000000 })
    const limit = toInt(params.get('limit'), 30, { min: 1, max: 100 })
    const catalog = browseSessionCatalog({
      root: opts.indexDir,
      agent: routeAgent(params),
      query: optionalText(params.get('q')),
      start,
      limit
    })
    return indexedRecentSessions(catalog)
  }
  if (url.pathname === '/api/status') {
    return {
      schema: 'session-indexer.web.status.v1',
      ...indexStatus({
        root: opts.indexDir,
        sessionId: optionalText(params.get('session_id')),
        startAt: toInt(params.get('start_at'), 0, { min: 0, max: 1000000 }),
        limit: toInt(params.get('limit'), 10, { min: 1, max: 100 })
      })
    }
  }
  if (url.pathname === '/api/search') {
    const filter = {}
    const role = optionalText(params.get('role'))
    const mipLevel = optionalText(params.get('mip_level'))
    if (role) filter.role = role
    if (mipLevel) filter.mipLevel = mipLevel
    const mip = params.get('mip')
    if (mip !== null && mip !== '') filter.mip = toInt(mip, 0, { min: 0, max: 100 })
    const result = await searchIndexWithBackend({
      query: optionalText(params.get('q')),
      indexId: optionalText(params.get('index_id')),
      sessionId: optionalText(params.get('session_id')),
      agent: routeAgent(params),
      within: optionalText(params.get('within')),
      filter,
      startAt: toInt(params.get('start_at'), 0, { min: 0, max: 1000000 }),
      limit: toInt(params.get('limit'), 20, { min: 1, max: 100 }),
      ...backendOpts(opts)
    })
    return {
      schema: 'session-indexer.web.search.v1',
      query: optionalText(params.get('q')),
      hits: result.hits
    }
  }
  if (url.pathname === '/api/browse') {
    const result = await browseIndexWithBackend({
      indexId: optionalText(params.get('index_id')),
      sessionId: optionalText(params.get('session_id')),
      agent: routeAgent(params),
      handle: optionalText(params.get('handle')),
      zoom: optionalText(params.get('zoom')),
      start: toInt(params.get('start'), 0, { min: 0, max: 1000000 }),
      limit: toInt(params.get('limit'), 50, { min: 1, max: 200 }),
      ...backendOpts(opts)
    })
    return {
      schema: 'session-indexer.web.browse.v1',
      ...result.result
    }
  }
  if (url.pathname === '/api/open') {
    const handle = optionalText(params.get('handle'))
    if (!handle) throw new Error('open requires handle')
    const indexId = optionalText(params.get('index_id'))
    const sessionId = optionalText(params.get('session_id'))
    const link = sessionLink({ indexId, sessionId, handle })
    const result = await openLinkWithBackend({
      link,
      indexId,
      sessionId,
      agent: routeAgent(params),
      budgetTokens: toInt(params.get('budget_tokens'), 1200, { min: 1, max: 200000 }),
      ...backendOpts(opts)
    })
    return {
      schema: 'session-indexer.web.open.v1',
      ...result.result
    }
  }
  const err = new Error('not found')
  err.statusCode = 404
  throw err
}

const createWebServer = (options = {}) => {
  const opts = {
    indexDir: options.indexDir || DEFAULT_INDEX_DIR,
    typesenseApiKey: options.typesenseApiKey || DEFAULT_TYPESENSE_API_KEY,
    typesenseCollection: options.typesenseCollection || DEFAULT_TYPESENSE_COLLECTION,
    typesenseVersion: options.typesenseVersion || DEFAULT_MANAGED_TYPESENSE_VERSION
  }
  return http.createServer((req, res) => {
    if (req.method !== 'GET') return errorResponse(res, 405, new Error('method not allowed'))
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    if (!url.pathname.startsWith('/api/')) return sendStatic(req, res)
    handleApi(url, opts)
      .then(result => jsonResponse(res, 200, result))
      .catch(err => errorResponse(res, err.statusCode || 500, err))
  })
}

const listen = (server, { host, port }) => new Promise((resolve, reject) => {
  const onError = err => {
    server.off('listening', onListening)
    reject(err)
  }
  const onListening = () => {
    server.off('error', onError)
    resolve()
  }
  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port, host)
})

const startWebServer = async (options = {}) => {
  const host = options.host || DEFAULT_HOST
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port)
  const server = createWebServer(options)
  await listen(server, { host, port })
  const address = server.address()
  const actualPort = address && address.port || port
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/`
  }
}

module.exports = {
  createWebServer,
  startWebServer
}
