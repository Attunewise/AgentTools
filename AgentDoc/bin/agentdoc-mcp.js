#!/usr/bin/env node

const { startStdioServer } = require('../src/mcpServer.js')

startStdioServer().catch(err => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})

