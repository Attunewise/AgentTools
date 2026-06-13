#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { ExpectTool } = require('../src/expectTool.js')

const usage = () => `
Usage:
  expect-tool run --cmd command (--script text|--script-file file) [--workdir dir]
  expect-tool parse --script text|--script-file file

Options:
  --cmd text              Command to spawn in a PTY.
  --script text           Expect script text.
  --script-file file      Expect script file path.
  --workdir dir           Working directory for the spawned command.
  --cols n                PTY columns. Defaults to 80.
  --rows n                PTY rows. Defaults to 24.
  --shell file            Shell executable. Defaults to SHELL or /bin/bash.
  --no-login              Do not pass -l to the shell on Unix.
  --keep-open             Do not kill the process after the script finishes.
  --log-file file         Write the full raw PTY transcript to this file.
  --log-append            Append to --log-file instead of replacing it.
  --max-output-chars n    Truncate returned transcript buffers. Defaults to 20000.
  --json file             Read run options from a JSON file. Use - for stdin.
`.trim()

const readStdin = () => fs.readFileSync(0, 'utf8')

const parseArgs = argv => {
  const opts = {
    command: argv[0] || 'help',
    login: true,
    kill_on_finish: true,
    cols: 80,
    rows: 24,
    max_output_chars: 20000
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--cmd') opts.cmd = next()
    else if (arg === '--script') opts.script = next()
    else if (arg === '--script-file') opts.scriptFile = path.resolve(next())
    else if (arg === '--workdir') opts.workdir = path.resolve(next())
    else if (arg === '--cols') opts.cols = Number(next())
    else if (arg === '--rows') opts.rows = Number(next())
    else if (arg === '--shell') opts.shell = next()
    else if (arg === '--no-login') opts.login = false
    else if (arg === '--keep-open') opts.kill_on_finish = false
    else if (arg === '--log-file') opts.log_path = path.resolve(next())
    else if (arg === '--log-append') opts.log_append = true
    else if (arg === '--max-output-chars') opts.max_output_chars = Number(next())
    else if (arg === '--json') opts.json = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

const materializeOptions = opts => {
  let merged = { ...opts }
  if (opts.json) {
    const text = opts.json === '-' ? readStdin() : fs.readFileSync(path.resolve(opts.json), 'utf8')
    merged = { ...merged, ...JSON.parse(text) }
  }
  if (merged.scriptFile) merged.script = fs.readFileSync(merged.scriptFile, 'utf8')
  return merged
}

const run = async opts => {
  if (opts.help || opts.command === 'help') return usage()
  const materialized = materializeOptions(opts)
  if (opts.command === 'run') {
    const tool = new ExpectTool()
    return await tool.run(materialized)
  }
  if (opts.command === 'parse') {
    const { parseExpectScript } = require('../src/hybridExpect.js')
    return {
      schema: 'agent-tools-expect.parse.v1',
      parsed: parseExpectScript(materialized.script)
    }
  }
  throw new Error(`unknown command: ${opts.command}`)
}

const main = async argv => {
  const result = await run(parseArgs(argv))
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  run
}
