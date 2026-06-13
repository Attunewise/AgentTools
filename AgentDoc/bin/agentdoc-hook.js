#!/usr/bin/env node

const { verifyGate } = require('../src/agentdoc.js')

try {
  verifyGate({ workdir: process.cwd() })
} catch (err) {
  const message = err && err.shortMessage ? err.shortMessage : (err && err.message ? err.message : String(err))
  console.error(message.split(/\r?\n/)[0])
  process.exit(1)
}
