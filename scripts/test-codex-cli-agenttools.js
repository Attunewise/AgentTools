#!/usr/bin/env node

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')

const { ExpectTool } = require('../Expect/src/expectTool.js')
const {
  analyzeCodexSessionFile,
  walkJsonlFiles
} = require('../CodexSessionTools/src/index.js')
const { createSessionIR, textBlock } = require('../ConversationHistory/src/ir.js')
const { writeSessionIndex } = require('../ConversationHistory/src/store.js')

const REPO_ROOT = path.resolve(__dirname, '..')
const CODEX_TIMEOUT_MS = Number(process.env.AGENTTOOLS_CODEX_TIMEOUT_MS || 10 * 60 * 1000)
const CODEX_SESSION_ROOT = path.join(os.homedir(), '.codex', 'sessions')
const ARTIFACT_ROOT = path.join(REPO_ROOT, 'artifacts', 'model-sessions')
const mcpRequire = createRequire(path.join(REPO_ROOT, 'CodexSessionTools', 'package.json'))
const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js')

const run = (cmd, args, cwd, options = {}) => childProcess.execFileSync(cmd, args, {
  cwd,
  encoding: options.encoding || 'utf8',
  stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ...(options.env || {})
  }
})

const write = (root, rel, text, mode) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, mode ? { mode } : undefined)
  if (mode) fs.chmodSync(file, mode)
  return file
}

const jsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const makeFixtureRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-codex-cli-'))
  run('git', ['init'], root)
  run('git', ['config', 'user.email', 'agenttools@example.test'], root)
  run('git', ['config', 'user.name', 'AgentTools Test'], root)
  write(root, 'README.md', '# AgentTools interactive fixture\n')
  write(root, 'Tooling.md', `# Tooling

- [Runtime entry points](Tooling.doc/runtime-entrypoints.md)
`)
  write(root, 'Tooling.doc/runtime-entrypoints.md', `---
id: tooling.runtime-entrypoints
title: Runtime entry points
scope:
  paths:
    - src/tooling.js
---

# Runtime Entry Points

The fixture records compact runtime entry-point checks.
`)
  write(root, 'src/tooling.js', 'module.exports = { ok: true }\n')
  run('git', ['add', '.'], root)
  run('git', ['commit', '-m', 'initial fixture'], root)
  fs.writeFileSync(path.join(root, 'src/tooling.js'), 'module.exports = { ok: true, changed: true }\n')
  run('git', ['add', 'src/tooling.js'], root)
  return root
}

const makeConversationIndex = root => {
  const indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-conversation-index-'))
  const ir = createSessionIR({
    source: { kind: 'test', path: path.join(root, 'conversation.jsonl') },
    session: {
      id: 'agenttools-interactive-session',
      agent: 'codex',
      title: 'AgentTools interactive conversation',
      updatedAt: '2026-06-13T00:00:00.000Z'
    },
    events: [
      { type: 'message', role: 'user', content: [textBlock('Check all AgentTools entry-point MCP tools.')] },
      { type: 'message', role: 'assistant', content: [textBlock('Use compact handles instead of evidence dumps.')] }
    ]
  })
  writeSessionIndex({ root: indexRoot, ir })
  return indexRoot
}

const makeWrapper = ({ root, name, env = {}, modulePath }) => {
  const envLines = Object.entries(env)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)}\n`)
    .join('')
  return write(root, `.mcp/${name}.js`, `#!/usr/bin/env node
${envLines}require(${JSON.stringify(modulePath)})
`, 0o755)
}

const mcpScripts = ({ root, conversationIndexRoot }) => ({
  agentdoc: makeWrapper({
    root,
    name: 'agentdoc-mcp',
    env: { AGENTTOOLS_MCP_LOG_DIR: path.join(root, '.mcp-logs') },
    modulePath: path.join(REPO_ROOT, 'AgentDoc', 'bin', 'agentdoc-mcp.js')
  }),
  conversation_history: makeWrapper({
    root,
    name: 'conversation-history-mcp',
    env: {
      AGENTTOOLS_MCP_LOG_DIR: path.join(root, '.mcp-logs'),
      SESSION_INDEXER_STATE_DIR: conversationIndexRoot
    },
    modulePath: path.join(REPO_ROOT, 'ConversationHistory', 'bin', 'session-indexer-mcp.js')
  }),
  codex_session: makeWrapper({
    root,
    name: 'codex-session-mcp',
    env: { AGENTTOOLS_MCP_LOG_DIR: path.join(root, '.mcp-logs') },
    modulePath: path.join(REPO_ROOT, 'CodexSessionTools', 'bin', 'codex-session-mcp.js')
  }),
  worktree: makeWrapper({
    root,
    name: 'worktree-mcp',
    env: { AGENTTOOLS_MCP_LOG_DIR: path.join(root, '.mcp-logs') },
    modulePath: path.join(REPO_ROOT, 'WorktreeTools', 'bin', 'worktree-mcp.js')
  })
})

const EXPECTED_MCP_TOOLS = {
  agentdoc: ['agentdoc_start_session', 'agentdoc_status'],
  conversation_history: ['conversation_browse'],
  codex_session: [
    'codex_session_start_binding',
    'codex_session_status',
    'codex_session_resolve_marker',
    'codex_session_app_server_status'
  ],
  worktree: ['worktree_status']
}

const preflightMcpTools = async ({ root, conversationIndexRoot }) => {
  for (const [name, script] of Object.entries(mcpScripts({ root, conversationIndexRoot }))) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [script],
      cwd: root,
      env: {
        ...process.env,
        AGENTTOOLS_MCP_LOG_DIR: path.join(root, '.mcp-logs')
      },
      stderr: 'pipe'
    })
    const client = new Client({ name: `agenttools-preflight-${name}`, version: '0.1.0' })
    await client.connect(transport)
    try {
      const listed = await client.listTools()
      const toolNames = new Set(listed.tools.map(tool => tool.name))
      for (const expected of EXPECTED_MCP_TOOLS[name]) {
        assert.ok(toolNames.has(expected), `expected ${name} to list ${expected}`)
      }
    } finally {
      await client.close()
    }
  }
}

const codexCommand = ({ root, conversationIndexRoot }) => {
  const wrappers = mcpScripts({ root, conversationIndexRoot })
  const report = path.join(root, 'agenttools-interactive-report.json')
  const prompt = `
You are running an AgentTools interactive integration test in this temporary git repository.

Required MCP calls:
1. Call codex_session_start_binding, remember codex_session_marker, then call codex_session_status, codex_session_resolve_marker with that marker, and codex_session_app_server_status.
2. Call worktree_status for this repository.
3. Call conversation_browse with no index_id and limit 5.
4. Call agentdoc_start_session, then agentdoc_status.

If a required MCP tool is not exposed, or a required MCP call returns an MCP/tool error, do not write the report.

After all required MCP calls have succeeded, write ${JSON.stringify(report)} as JSON with keys:
codex_session_tools, worktree_tools, conversation_history, agentdoc, and done:true.
Each tool key should contain a short string describing what you observed. Do not include raw transcript text or raw git diffs.
Finish only after the JSON file exists.
`.trim()

  const args = [
    'env',
    'TERM=xterm-256color',
    `AGENTTOOLS_MCP_LOG_DIR=${path.join(root, '.mcp-logs')}`,
    'codex',
    '--no-alt-screen',
    '--cd', root,
    '--sandbox', 'danger-full-access',
    '--ask-for-approval', 'never',
    '-c', `projects.${JSON.stringify(root)}.trust_level="trusted"`
  ]
  for (const [name, script] of Object.entries(wrappers)) {
    args.push('-c', `mcp_servers.${name}.command="node"`)
    args.push('-c', `mcp_servers.${name}.args=[${JSON.stringify(script)}]`)
  }
  args.push(prompt)
  return {
    args,
    report
  }
}

const reportIsComplete = file => {
  try {
    const report = jsonFile(file)
    return Boolean(
      report.done &&
      report.codex_session_tools &&
      report.worktree_tools &&
      report.conversation_history &&
      report.agentdoc
    )
  } catch (_) {
    return false
  }
}

const runCodexWithExpect = async ({ root, conversationIndexRoot }) => {
  const { args, report } = codexCommand({ root, conversationIndexRoot })
  const [command, ...rest] = args
  const shellCmd = [command, ...rest.map(arg => JSON.stringify(arg))].join(' ')
  const logDir = path.join(ARTIFACT_ROOT, 'agenttools-codex-cli-latest')
  fs.mkdirSync(logDir, { recursive: true })
  const logPath = path.join(logDir, `${path.basename(root)}.pty.log`)
  const tool = new ExpectTool()
  const spawned = await tool.spawn({
    cmd: shellCmd,
    workdir: root,
    cols: 120,
    rows: 40,
    log_path: logPath
  })
  const deadline = Date.now() + CODEX_TIMEOUT_MS
  let lastResult = null
  try {
    while (Date.now() < deadline) {
      lastResult = await tool.eval({
        session_id: spawned.session_id,
        max_output_chars: 120000,
        script: `
set timeout 5
expect {
  -re {Do[\\s\\S]*trust[\\s\\S]*directory} {
    js {
      if (!context.acceptedTrust) {
        context.acceptedTrust = true
        send("\\r")
      }
    }
    exp_continue
  }
  -re {Continue anyway\\? \\[y/N\\]:} {
    js {
      send("y\\r")
    }
    exp_continue
  }
  eof {
    js {
      return { ok: false, eof: true }
    }
  }
  timeout {
    js {
      return { ok: false, timeout: true }
    }
  }
}
`
      })
      if (reportIsComplete(report)) {
        return { ok: true, report, logPath }
      }
      if (lastResult.result && lastResult.result.eof) break
    }
    throw new Error(`Timed out waiting for AgentTools interactive report. Last buffer:\n${lastResult ? lastResult.remainingBuffer : ''}`)
  } finally {
    await tool.close({ session_id: spawned.session_id })
  }
}

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const copySessionArtifacts = ({ root, logPath }) => {
  const realRoot = fs.realpathSync(root)
  const outRoot = path.join(ARTIFACT_ROOT, `agenttools-codex-cli-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(outRoot, { recursive: true })
  const sessions = walkJsonlFiles(CODEX_SESSION_ROOT)
    .slice(0, 200)
    .map(item => ({ item, analyzed: analyzeCodexSessionFile(item.file, { matchTerm: ['codex_session_', 'worktree_status', 'conversation_browse', 'agentdoc_'] }) }))
    .filter(({ analyzed }) => analyzed && (analyzed.path_events || []).some(event => {
      try {
        return event.path && fs.existsSync(event.path) && fs.realpathSync(event.path) === realRoot
      } catch (_) {
        return false
      }
    }))
    .filter(({ analyzed }) => (analyzed.tool_calls || []).some(call =>
      /^(codex_session_|worktree_|conversation_|agentdoc_)/.test(call.name || '')
    ))

  const copied = []
  for (const { item, analyzed } of sessions) {
    const dest = path.join(outRoot, path.basename(item.file))
    fs.copyFileSync(item.file, dest)
    copied.push({
      source: item.file,
      artifact: path.relative(REPO_ROOT, dest),
      bytes: fs.statSync(dest).size,
      sha256: sha256File(dest),
      tool_calls: (analyzed.tool_calls || [])
        .map(call => call.name)
        .filter(name => /^(codex_session_|worktree_|conversation_|agentdoc_)/.test(name || ''))
    })
  }
  const ptyLogs = []
  if (logPath && fs.existsSync(logPath)) {
    const dest = path.join(outRoot, path.basename(logPath))
    fs.copyFileSync(logPath, dest)
    ptyLogs.push({
      source: logPath,
      artifact: path.relative(REPO_ROOT, dest),
      bytes: fs.statSync(dest).size,
      sha256: sha256File(dest)
    })
  }
  const manifest = {
    schema: 'agenttools.model-session-artifacts.v1',
    created_at: new Date().toISOString(),
    description: 'Codex CLI model sessions captured from the all-tools interactive MCP integration test.',
    fixture_root: root,
    sessions: copied,
    pty_logs: ptyLogs
  }
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(outRoot, 'README.md'), `# AgentTools Codex CLI Model Sessions

These local-only artifacts are ignored by git. See \`manifest.json\` for source paths, hashes, and tool-call summaries.
`)
  return {
    outRoot,
    sessionCount: copied.length,
    ptyLogCount: ptyLogs.length
  }
}

const assertToolCalls = root => {
  const realRoot = fs.realpathSync(root)
  const sessions = walkJsonlFiles(CODEX_SESSION_ROOT)
    .slice(0, 200)
    .map(item => analyzeCodexSessionFile(item.file, { matchTerm: ['codex_session_', 'worktree_status', 'conversation_browse', 'agentdoc_'] }))
    .filter(Boolean)
    .filter(item => (item.path_events || []).some(event => {
      try {
        return event.path && fs.existsSync(event.path) && fs.realpathSync(event.path) === realRoot
      } catch (_) {
        return false
      }
    }))
  const names = new Set(sessions.flatMap(session => (session.tool_calls || []).map(call => call.name)))
  for (const prefix of ['codex_session_', 'worktree_', 'conversation_', 'agentdoc_']) {
    assert.ok([...names].some(name => String(name || '').startsWith(prefix)), `expected MCP tool call prefix ${prefix}`)
  }
  const mcpResults = []
  for (const session of sessions) {
    for (const line of fs.readFileSync(session.file, 'utf8').split('\n')) {
      if (!line.includes('mcp_tool_call_end')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch (_) {
        continue
      }
      const payload = event.payload || {}
      if (payload.type !== 'mcp_tool_call_end') continue
      const tool = payload.invocation && payload.invocation.tool
      if (!/^(codex_session_|worktree_|conversation_|agentdoc_)/.test(tool || '')) continue
      const ok = payload.result && payload.result.Ok
      mcpResults.push({
        tool,
        isError: Boolean(ok && ok.isError)
      })
    }
  }
  assert.ok(mcpResults.length >= 7, 'expected recorded MCP tool results for all required entry points')
  for (const result of mcpResults) {
    assert.equal(result.isError, false, `expected ${result.tool} MCP call not to return isError`)
  }
}

const main = async () => {
  run('codex', ['--version'], process.cwd())
  const root = makeFixtureRepo()
  const conversationIndexRoot = makeConversationIndex(root)
  let failed = false
  console.log(`AgentTools Codex CLI fixture: ${root}`)
  try {
    await preflightMcpTools({ root, conversationIndexRoot })
    const result = await runCodexWithExpect({ root, conversationIndexRoot })
    assert.equal(result.ok, true)
    const report = jsonFile(result.report)
    assert.equal(report.done, true)
    assertToolCalls(root)
    const artifacts = copySessionArtifacts({ root, logPath: result.logPath })
    console.log(`AgentTools Codex CLI report: ${result.report}`)
    console.log(`AgentTools Codex CLI artifacts: ${artifacts.outRoot}`)
    console.log('AgentTools Codex CLI integration passed')
  } catch (err) {
    failed = true
    console.error(`Fixture retained for debugging: ${root}`)
    throw err
  } finally {
    if (!failed && !process.env.AGENTTOOLS_KEEP_CODEX_FIXTURE) {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(conversationIndexRoot, { recursive: true, force: true })
    }
  }
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
