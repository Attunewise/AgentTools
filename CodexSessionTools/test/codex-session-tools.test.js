const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')

const {
  analyzeCodexSessionFile,
  buildCodexExecArgs,
  CodexAppServerClient,
  DiagnosticsStore,
  findCodexSessionsContainingMarker,
  fileContainsLiteral,
  fileLatestPatternMatch,
  latestCodexSessionFile,
  reconcileThreadRecord,
  renderForTool,
  resolveCodexSessionForMarker,
  walkJsonlFiles
} = require('../src/index.js')
const { createMcpServer } = require('../src/mcpServer.js')
const { CodexSessionServerState } = require('../src/server.js')

const writeJsonl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
}

test('discovers Codex sessions and extracts session ids plus path events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-'))
  try {
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    const file = path.join(root, '2026', '06', '13', 'rollout-test.jsonl')
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 'codex-1', cwd: repo } },
      { type: 'turn_context', payload: { cwd: repo, workspace_roots: [repo] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git status', workdir: repo }) } }
    ])

    assert.equal(latestCodexSessionFile(root), file)
    assert.equal(walkJsonlFiles(root).length, 1)
    const analyzed = analyzeCodexSessionFile(file)
    assert.equal(analyzed.codex_session_id, 'codex-1')
    assert.equal(analyzed.current_path.path, repo)
    assert.equal(analyzed.tool_calls[0].workdir, repo)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('compact renderers keep model-facing output small and fixed', () => {
  const text = renderForTool('codex_session_resolve_current', {
    status: 'resolved',
    codex_session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    file: `/tmp/${'x'.repeat(200)}/rollout.jsonl`,
    reason: 'session_marker_match'
  })
  assert.match(text, /^ok thread=aaaaaaaa file=/)
  assert.ok(text.length < 160)

  assert.equal(renderForTool('codex_session_resolve_current', {
    ok: false,
    status: 'blocked',
    reason: 'ambiguous_fork',
    evidence: 'this must not render'
  }), 'blocked reason=ambiguous_fork')

  const markerHint = renderForTool('codex_session_latest_marker', {
    schema: 'codex-session-tools.latest-marker.v1',
    status: 'hint',
    marker: 'codex-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    file: `/tmp/${'x'.repeat(200)}/rollout.jsonl`,
    binding_proof: false,
    current_session_proof: false,
    warning: 'not_current_session_binding'
  })
  assert.match(markerHint, /^hint proof=0 marker=codex-session-/)
  assert.doesNotMatch(markerHint, /^ok/)
  assert.doesNotMatch(markerHint, /thread=/)
})

test('diagnostics store pages compact events without exposing full evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-diagnostics-'))
  try {
    const store = new DiagnosticsStore({ dir: root })
    store.append('events', {
      code: 'repair_attempt',
      status: 'succeeded',
      evidence: 'x'.repeat(1000),
      thread_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const page = store.page('events', { limit: 1 })
    assert.equal(page.events.length, 1)
    assert.equal(page.events[0].code, 'repair_attempt')
    assert.equal(Object.hasOwn(page.events[0], 'evidence'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('app-server stdio client initializes and lists threads against a fake server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-fake-'))
  const fake = path.join(root, 'fake-app-server.js')
  try {
    fs.writeFileSync(fake, `#!/usr/bin/env node
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    console.log(JSON.stringify({ id: msg.id, result: { userAgent: 'fake', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } }))
  } else if (msg.method === 'thread/list') {
    console.log(JSON.stringify({ id: msg.id, result: { data: [{ id: 'thread-1', path: '/tmp/rollout.jsonl' }], nextCursor: null, backwardsCursor: null } }))
  } else if (msg.method === 'thread/read') {
    console.log(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params.threadId, path: '/tmp/rollout.jsonl' } } }))
  }
})
`)
    fs.chmodSync(fake, 0o755)
    const client = new CodexAppServerClient({
      command: fake,
      args: [],
      requestTimeoutMs: 1000
    })
    const init = await client.initialize()
    assert.equal(init.userAgent, 'fake')
    const listed = await client.threadList({ limit: 1, useStateDbOnly: true })
    assert.equal(listed.data[0].id, 'thread-1')
    const read = await client.threadRead('thread-1')
    assert.equal(read.thread.id, 'thread-1')
    await client.stop()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reconcile repairs missing rollout paths through app-server before blocking', async () => {
  const repaired = await reconcileThreadRecord({
    id: 'thread-1',
    rollout_path: '/tmp/does-not-exist.jsonl'
  }, {
    appServer: {
      threadRead: async threadId => ({ thread: { id: threadId, path: '/tmp/recovered.jsonl' } })
    }
  })
  assert.equal(repaired.ok, true)
  assert.equal(repaired.status, 'degraded')
  assert.equal(repaired.warning, 'repaired_missing_rollout_via_app_server')

  const blocked = await reconcileThreadRecord({
    id: 'thread-2',
    rollout_path: '/tmp/does-not-exist.jsonl'
  }, {
    appServer: {
      threadRead: async () => { throw new Error('not found') }
    }
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.reason, 'rollout_missing_after_repair')
})

test('builds codex exec create and resume arguments without shell interpolation', () => {
  assert.deepEqual(buildCodexExecArgs({
    cwd: '/tmp/repo',
    model: 'gpt-5.4',
    sandbox: 'workspace-write',
    config: {
      'features.example': true
    },
    prompt: 'update docs'
  }), [
    'exec',
    '--json',
    '--cd', '/tmp/repo',
    '--model', 'gpt-5.4',
    '--sandbox', 'workspace-write',
    '--config', 'features.example=true',
    'update docs'
  ])

  assert.deepEqual(buildCodexExecArgs({
    resume_session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    all: true,
    prompt: 'continue'
  }), [
    'exec',
    '--json',
    'resume',
    '--all',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'continue'
  ])
})

test('server runs codex exec through Codex and refreshes shared state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-server-exec-'))
  const argvFile = path.join(root, 'argv.json')
  const fakeCodex = path.join(root, 'codex-fake.js')
  try {
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.CODEX_SESSION_TEST_ROOT
fs.writeFileSync(process.env.CODEX_SESSION_TEST_ARGV, JSON.stringify(process.argv.slice(2)))
const rollout = path.join(root, 'exec-session.jsonl')
fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: root } }) + '\\n')
console.log(JSON.stringify({ type: 'session_started', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
console.log(JSON.stringify({ type: 'done' }))
`)
    fs.chmodSync(fakeCodex, 0o755)
    const state = new CodexSessionServerState({
      sessionRoot: root,
      watch: false,
      execCommand: fakeCodex,
      execEnv: {
        CODEX_SESSION_TEST_ROOT: root,
        CODEX_SESSION_TEST_ARGV: argvFile
      }
    })
    state.start()
    const result = await state.runExec({
      cwd: root,
      prompt: 'record session'
    })

    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), [
      'exec',
      '--json',
      '--cd', root,
      'record session'
    ])
    assert.equal(result.json_events.length, 2)
    assert.equal(result.detected_ids[0], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    assert.equal(result.server_status.session_count, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('finds sessions by bounded marker scan and raw match previews', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-marker-'))
  try {
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    const marker = 'agentdoc-session-00000000-0000-4000-8000-000000000001'
    const file = path.join(root, '2026', '06', '13', 'rollout-marker.jsonl')
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 'codex-marker', cwd: repo } },
      { type: 'response_item', payload: { type: 'function_call_output', output: `started ${marker}` } },
      { type: 'response_item', payload: { type: 'function_call', name: 'agentdoc_record_check', arguments: '{}' } }
    ])

    const matches = findCodexSessionsContainingMarker(root, marker, {
      matchTerm: ['agentdoc_', 'AgentDoc']
    })
    assert.equal(matches.length, 1)
    assert.equal(matches[0].codex_session_id, 'codex-marker')
    assert.equal(matches[0].raw_matches.length, 1)
    assert.match(matches[0].raw_matches[0].preview, /agentdoc_record_check/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('literal marker scan walks backward by JSONL line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-literal-'))
  try {
    const file = path.join(root, 'session.jsonl')
    const marker = 'conversation_history-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    fs.writeFileSync(file, `${marker}\n${'x'.repeat(512 * 1024)}\n`)

    const match = fileContainsLiteral({
      file,
      literal: marker,
      chunkBytes: 128
    })
    assert.equal(match.scan, 'backward_line')
    assert.equal(match.byteOffset, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('latest marker scan walks backward by JSONL line before large tails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-latest-marker-'))
  try {
    const file = path.join(root, 'session.jsonl')
    const marker = 'codex-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 'latest-marker-thread', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: `started ${marker}` } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(512 * 1024) } }
    ])

    const match = fileLatestPatternMatch({
      file,
      pattern: /codex-session-[0-9a-fA-F-]{36}/g,
      chunkBytes: 128
    })
    assert.equal(match.marker, marker)
    assert.equal(match.scan, 'backward_line')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('server latest marker uses backward-line scan before large tails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-latest-state-'))
  try {
    const file = path.join(root, 'session.jsonl')
    const marker = 'codex-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 'latest-state-thread', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: `started ${marker}` } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(512 * 1024) } }
    ])
    const state = new CodexSessionServerState({
      sessionRoot: root,
      watch: false
    })
    state.sessions = walkJsonlFiles(root)

    const latest = state.latestMarker({
      pattern: /codex-session-[0-9a-fA-F-]{36}/g
    })
    assert.equal(latest.marker, marker)
    assert.equal(latest.scan, 'backward_line')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolves duplicate marker matches to a fork descendant when thread edges identify one leaf', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-fork-'))
  try {
    const marker = 'conversation_history-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const parent = path.join(root, 'parent.jsonl')
    const child = path.join(root, 'child.jsonl')
    writeJsonl(parent, [
      { type: 'session_meta', payload: { id: 'parent-thread', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: marker } }
    ])
    writeJsonl(child, [
      { type: 'session_meta', payload: { id: 'child-thread', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: marker } }
    ])

    const resolved = resolveCodexSessionForMarker(root, marker, {
      threadSpawnEdges: [{
        parentThreadId: 'parent-thread',
        childThreadId: 'child-thread'
      }]
    })
    assert.equal(resolved.file, child)
    assert.equal(resolved.reason, 'session_marker_match_fork_descendant')
    assert.equal(resolved.signals.forkResolution.selectedThreadId, 'child-thread')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shared marker resolver finds markers before large output tails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-large-tail-'))
  try {
    const marker = 'conversation_history-session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const file = path.join(root, 'session.jsonl')
    writeJsonl(file, [
      { type: 'session_meta', payload: { id: 'large-tail-thread', cwd: root } },
      { type: 'event_msg', payload: { type: 'user_message', message: marker } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(512 * 1024) } }
    ])

    const resolved = resolveCodexSessionForMarker(root, marker, {
      sessionMarkerScanBytes: 128
    })
    assert.equal(resolved.file, file)
    assert.equal(resolved.signals.sessionMarkerMatch.scan, 'backward_line')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('marker resolver caches verified matches and unchanged misses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-marker-cache-'))
  try {
    const marker = 'conversation_history-session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const matched = path.join(root, 'matched.jsonl')
    const missed = path.join(root, 'missed.jsonl')
    writeJsonl(matched, [
      { type: 'session_meta', payload: { id: 'matched-thread', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: marker } }
    ])
    writeJsonl(missed, [
      { type: 'session_meta', payload: { id: 'missed-thread', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'no marker here' } }
    ])

    const markerLookupCache = new Map()
    const first = resolveCodexSessionForMarker(root, marker, { markerLookupCache })
    assert.equal(first.file, matched)
    assert.equal(first.signals.sessionMarkerMatch.scan, 'backward_line')

    const second = resolveCodexSessionForMarker(root, marker, { markerLookupCache })
    assert.equal(second.file, matched)
    assert.equal(second.signals.sessionMarkerMatch.scan, 'cache_verified')

    fs.appendFileSync(missed, `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', output: marker }
    })}\n`)
    const fork = resolveCodexSessionForMarker(root, marker, {
      markerLookupCache,
      threadSpawnEdges: [{
        parentThreadId: 'matched-thread',
        childThreadId: 'missed-thread'
      }]
    })
    assert.equal(fork.file, missed)
    assert.equal(fork.reason, 'session_marker_match_fork_descendant')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('server state resolves markers from its shared snapshot and fork graph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-server-state-'))
  try {
    const marker = 'agentdoc-session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const parent = path.join(root, 'parent.jsonl')
    const child = path.join(root, 'child.jsonl')
    writeJsonl(parent, [
      { type: 'session_meta', payload: { id: 'server-parent', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: marker } }
    ])
    writeJsonl(child, [
      { type: 'session_meta', payload: { id: 'server-child', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call_output', output: marker } }
    ])
    const state = new CodexSessionServerState({
      sessionRoot: root,
      watch: false
    })
    state.threadSpawnEdges = [{
      parentThreadId: 'server-parent',
      childThreadId: 'server-child'
    }]
    state.sessions = walkJsonlFiles(root)

    const resolved = state.resolveMarker({ marker })
    assert.equal(resolved.file, child)
    assert.equal(resolved.reason, 'session_marker_match_fork_descendant')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('MCP tools expose compact session entry points without transcript evidence', async () => {
  const fakeClient = {
    status: async () => ({
      session_root: '/tmp/codex/sessions',
      session_count: 2,
      thread_spawn_edge_count: 1,
      app_server: { available: true, initialized: false },
      latest_session: { file: '/tmp/codex/sessions/latest.jsonl', mtimeMs: 1, size: 20 }
    }),
    refresh: async () => fakeClient.status(),
    resolveMarker: async () => ({
      status: 'resolved',
      reason: 'session_marker_match',
      codex_session_id: '019ebf51-aaaa-bbbb-cccc-111111111111',
      file: '/tmp/codex/sessions/latest.jsonl',
      signals: { rawTranscriptEvidence: 'must not leak' }
    }),
    latestMarker: async () => ({
      marker: 'codex-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      file: '/tmp/codex/sessions/latest.jsonl',
      byteOffset: 42,
      mtimeMs: 1
    }),
    appServerThreadList: async () => ({
      ok: true,
      status: 'resolved',
      result: { data: [{ id: 'thread-1', sensitivePayload: 'must not leak' }] }
    }),
    diagnostics: async () => ({
      events: [{ code: 'repair_attempt', status: 'succeeded' }]
    })
  }
  const server = createMcpServer({ clientFactory: async () => fakeClient })
  const client = new Client({ name: 'codex-session-tools-test', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ])
  try {
    const listed = await client.listTools()
    assert.ok(listed.tools.some(tool => tool.name === 'codex_session_start_binding'))
    assert.ok(listed.tools.some(tool => tool.name === 'codex_session_resolve_marker'))
    const latestTool = listed.tools.find(tool => tool.name === 'codex_session_latest_marker')
    assert.match(latestTool.description, /not evidence that the current model run is bound/)

    const bound = await client.callTool({
      name: 'codex_session_start_binding',
      arguments: {}
    })
    assert.match(bound.content[0].text, /^ok status=ok marker=codex-session-/)
    assert.match(bound.structuredContent.result.codex_session_marker, /^codex-session-/)

    const status = await client.callTool({
      name: 'codex_session_status',
      arguments: { refresh: true }
    })
    assert.equal(status.structuredContent.result.session_count, 2)
    assert.equal(Object.hasOwn(status.structuredContent.result, 'sessions'), false)

    const resolved = await client.callTool({
      name: 'codex_session_resolve_marker',
      arguments: { marker: bound.structuredContent.result.codex_session_marker }
    })
    assert.match(resolved.content[0].text, /^ok thread=019ebf51/)
    assert.equal(Object.hasOwn(resolved.structuredContent.result, 'signals'), false)
    assert.equal(Object.hasOwn(resolved.structuredContent.result, 'raw_matches'), false)

    const latestMarker = await client.callTool({
      name: 'codex_session_latest_marker',
      arguments: { marker_prefix: 'codex-session' }
    })
    assert.match(latestMarker.content[0].text, /^hint proof=0 /)
    assert.equal(latestMarker.structuredContent.result.status, 'hint')
    assert.equal(latestMarker.structuredContent.result.binding_proof, false)
    assert.equal(latestMarker.structuredContent.result.current_session_proof, false)
    assert.equal(Object.hasOwn(latestMarker.structuredContent.result, 'codex_session_id'), false)

    const appServer = await client.callTool({
      name: 'codex_session_app_server_status',
      arguments: {}
    })
    assert.equal(appServer.structuredContent.result.thread_count, 1)
    assert.equal(Object.hasOwn(appServer.structuredContent.result, 'result'), false)
  } finally {
    await client.close()
  }
})
