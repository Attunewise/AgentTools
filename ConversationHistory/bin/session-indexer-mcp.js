#!/usr/bin/env node
require('../src/runtimeDeps.js').ensureRuntimeDependencies()

const { startStdioServer } = require('../src/mcpServer.js')

startStdioServer().catch(err => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
