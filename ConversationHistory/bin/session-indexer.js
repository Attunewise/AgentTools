#!/usr/bin/env node

require('../src/runtimeDeps.js').ensureRuntimeDependencies()

require('../src/cli.js').main(process.argv.slice(2)).catch(err => {
  console.error(err.stack || err.message)
  process.exit(1)
})
