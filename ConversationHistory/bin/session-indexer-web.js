#!/usr/bin/env node

require('../src/runtimeDeps.js').ensureRuntimeDependencies()

const path = require('path')
const { DEFAULT_INDEX_DIR } = require('../src/store.js')
const { DEFAULT_TYPESENSE_API_KEY, DEFAULT_TYPESENSE_COLLECTION } = require('../src/typesense.js')
const { DEFAULT_MANAGED_TYPESENSE_VERSION } = require('../src/typesenseManaged.js')
const { startWebServer } = require('../src/webServer.js')

const expandHome = value => {
  const text = String(value || '')
  if (!text.startsWith('~')) return text
  return path.join(process.env.HOME || '', text.slice(1))
}

const usage = () => `
Usage: session-indexer-web [options]

Options:
  --host host                 Bind host. Defaults to 127.0.0.1.
  --port n                    Bind port. Defaults to 8787.
  --index-dir dir             ConversationHistory index dir. Defaults to shared state.
  --typesense-collection name Typesense collection. Defaults to ${DEFAULT_TYPESENSE_COLLECTION}.
  --typesense-api-key key     Typesense API key. Defaults to managed key.
  --typesense-version version Managed Typesense version. Defaults to ${DEFAULT_MANAGED_TYPESENSE_VERSION}.
  --help                      Show this help.
`.trim()

const parseArgs = argv => {
  const opts = {
    host: process.env.SESSION_INDEXER_WEB_HOST || '127.0.0.1',
    port: Number(process.env.SESSION_INDEXER_WEB_PORT || 8787),
    indexDir: DEFAULT_INDEX_DIR,
    typesenseApiKey: DEFAULT_TYPESENSE_API_KEY,
    typesenseCollection: DEFAULT_TYPESENSE_COLLECTION,
    typesenseVersion: DEFAULT_MANAGED_TYPESENSE_VERSION
  }
  const next = (index, name) => {
    if (index + 1 >= argv.length) throw new Error(`${name} requires a value`)
    return argv[index + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--host') {
      opts.host = next(i++, arg)
    } else if (arg === '--port') {
      opts.port = Number(next(i++, arg))
    } else if (arg === '--index-dir') {
      opts.indexDir = path.resolve(expandHome(next(i++, arg)))
    } else if (arg === '--typesense-api-key') {
      opts.typesenseApiKey = next(i++, arg)
    } else if (arg === '--typesense-collection') {
      opts.typesenseCollection = next(i++, arg)
    } else if (arg === '--typesense-version') {
      opts.typesenseVersion = next(i++, arg)
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535')
  }
  return opts
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(usage())
    return
  }
  const started = await startWebServer(opts)
  console.log(`ConversationHistory web UI: ${started.url}`)
  console.log(`Index dir: ${opts.indexDir}`)
}

main().catch(err => {
  console.error(err.stack || err.message)
  process.exit(1)
})
