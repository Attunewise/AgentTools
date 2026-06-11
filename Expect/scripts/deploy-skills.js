#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const SKILL_NAME = 'expect'

const usage = () => `
Usage:
  node scripts/deploy-skills.js [--target codex|pi|claude|all] [--mode copy|symlink] [--force] [--no-install]

Options:
  --target name   Destination harness. Defaults to all.
  --mode name     copy or symlink. Defaults to copy.
  --force         Replace existing destination.
  --no-install    Skip npm install in copied destinations.
`.trim()

const expandHome = value => {
  if (!value) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

const parseArgs = argv => {
  const opts = {
    target: 'all',
    mode: 'copy',
    force: false,
    install: true
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--target') opts.target = next()
    else if (arg === '--mode') opts.mode = next()
    else if (arg === '--force') opts.force = true
    else if (arg === '--no-install') opts.install = false
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['codex', 'pi', 'claude', 'all'].includes(opts.target)) throw new Error('--target must be codex, pi, claude, or all')
  if (!['copy', 'symlink'].includes(opts.mode)) throw new Error('--mode must be copy or symlink')
  return opts
}

const destinations = () => ({
  codex: path.join(expandHome(process.env.CODEX_HOME || '~/.codex'), 'skills', SKILL_NAME),
  pi: path.join(expandHome(process.env.PI_AGENT_DIR || '~/.pi/agent'), 'skills', SKILL_NAME),
  claude: path.join(expandHome(process.env.CLAUDE_HOME || '~/.claude'), 'skills', SKILL_NAME)
})

const rmIfAllowed = (target, force) => {
  if (!fs.existsSync(target)) return
  if (!force) throw new Error(`${target} already exists; pass --force to replace it`)
  fs.rmSync(target, { recursive: true, force: true })
}

const copyRepo = target => {
  fs.cpSync(REPO_ROOT, target, {
    recursive: true,
    filter: source => {
      const rel = path.relative(REPO_ROOT, source)
      if (!rel) return true
      return !['.git', 'node_modules', 'coverage', 'tmp'].some(name => rel === name || rel.startsWith(`${name}${path.sep}`))
    }
  })
}

const installDeps = target => {
  childProcess.execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
    cwd: target,
    stdio: 'inherit'
  })
  fs.chmodSync(path.join(target, 'bin', 'expect-tool.js'), 0o755)
}

const deployOne = ({ name, target, mode, force, install }) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  rmIfAllowed(target, force)
  if (mode === 'symlink') {
    fs.symlinkSync(REPO_ROOT, target, 'dir')
  } else {
    copyRepo(target)
  }
  if (mode === 'copy' && install) installDeps(target)
  return {
    target: name,
    mode,
    source: REPO_ROOT,
    dest: target,
    skillFile: path.join(target, 'SKILL.md'),
    dependenciesInstalled: mode === 'copy' && install
  }
}

const run = opts => {
  if (opts.help) return usage()
  const all = destinations()
  const targets = opts.target === 'all' ? Object.keys(all) : [opts.target]
  return {
    schema: 'agent-tools-expect.deploy-skills.v1',
    deployed: targets.map(name => deployOne({
      name,
      target: all[name],
      mode: opts.mode,
      force: opts.force,
      install: opts.install
    }))
  }
}

const main = argv => {
  const result = run(parseArgs(argv))
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err.stack || err.message)
    process.exit(1)
  }
}

module.exports = {
  parseArgs,
  run,
  destinations
}
