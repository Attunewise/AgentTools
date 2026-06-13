const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { CodexSessionServerState } = require('codex-session-tools/src/server.js')

const { codexSessionFingerprint, importCodexJsonl, resolveCurrentCodexSessionFile } = require('../src/adapters/codex.js')
const { importClaudeJsonl, resolveCurrentClaudeSessionFile } = require('../src/adapters/claude.js')
const { deploySkill } = require('../src/deploy.js')
const { createSessionIR, textBlock } = require('../src/ir.js')
const {
  buildMipTree,
  collectIndexDocuments,
  compactedRetrievalHandles,
  hydrateMipTree,
  indexIdForIR,
  openLink,
  sessionLink
} = require('../src/mip.js')
const { estimateCost, listModels, resolvePricing } = require('../src/pricing.js')
const {
  commitSummaryJobs,
  completedSummaryJobs,
  browseIndexWithBackend,
  browseSessionCatalog,
  indexStatus,
  readSessionTree,
  reserveSummaryJobs,
  resetSessionIndex,
  resetSessionIndexWithBackend,
  searchIndexWithBackend,
  writeSessionIndexWithBackend,
  writeSessionIndex
} = require('../src/store.js')
const {
  applyBatchResults,
  makePrompt,
  prepareCompactedSummaryLayer,
  SUMMARY_SYSTEM_PROMPT,
  summarizeTree,
  summaryProvider
} = require('../src/summarizer.js')
const { OpenAICodexResponsesProvider } = require('../src/providers/OpenAICodexResponsesProvider.js')
const { makeBatchRequests } = require('../src/providers/ClaudePlatformAwsBatchProvider.js')
const {
  ClaudeCliProvider,
  buildClaudeCliArgs,
  parseClaudeCliResult
} = require('../src/providers/ClaudeCliProvider.js')
const { runRetrievalEvaluation } = require('../src/retrievalEval.js')
const { parseArgs, runCommand } = require('../src/cli.js')
const { isPidRunning, stopIndexingJobs, waitForJob, writeJobState } = require('../src/indexing.js')
const { piEntriesFromIr } = require('../src/pi.js')
const { LOCAL_STATE_DIR, REPO_ROOT } = require('../src/paths.js')
const { collectionSchema, docForTypesense, importDocuments } = require('../src/typesense.js')
const {
  managedRuntimeInfo,
  managedTypesenseServerArgs,
  managedTypesenseStatus,
  stopManagedTypesense
} = require('../src/typesenseManaged.js')
const { normalizeConcurrency, runWorkQueue } = require('../src/workQueue.js')

const testTempRoots = []
const originalMkdtempSync = fs.mkdtempSync.bind(fs)
fs.mkdtempSync = (...args) => {
  const dir = originalMkdtempSync(...args)
  testTempRoots.push(dir)
  return dir
}

const cleanupTestTempRoots = async () => {
  const roots = Array.from(new Set(testTempRoots)).sort((a, b) => b.length - a.length)
  for (const root of roots) {
    try {
      const pidFile = path.join(root, 'typesense', 'runtime', 'typesense.pid')
      let pid = null
      try {
        pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err
      }
      if (pid && (pid === process.pid || pid === process.ppid)) continue
      const stopped = await stopManagedTypesense({ root, timeoutMs: 1000, pollMs: 50 })
      if (stopped.running && stopped.pid) {
        if (stopped.pid === process.pid || stopped.pid === process.ppid) continue
        try {
          process.kill(stopped.pid, 'SIGKILL')
        } catch (err) {
          if (!err || err.code !== 'ESRCH') throw err
        }
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
    }
  }
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  testTempRoots.length = 0
  return roots
}

test.after(cleanupTestTempRoots)

const fixture = path.join(__dirname, 'fixtures', 'codex-mini.jsonl')
const claudeFixture = path.join(__dirname, 'fixtures', 'claude-mini.jsonl')

const writeJsonl = (file, rows) => fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
const appendJsonl = (file, rows) => fs.appendFileSync(file, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (fn, { timeoutMs = 10000, pollMs = 100, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await sleepMs(pollMs)
  }
  const suffix = lastError ? `: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${label}${suffix}`)
}

const readProgressEvents = file => {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch (_err) {
          return null
        }
      })
      .filter(event => event && event.event === 'index_progress')
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

const piMessagesFromEntries = entries => entries
  .filter(entry => entry.type === 'message')
  .map(entry => entry.message)

const collectOrphanPiToolResults = messages => {
  const seenCalls = new Set()
  const orphans = []
  for (const [index, message] of messages.entries()) {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (block && block.type === 'toolCall') seenCalls.add(block.id)
    }
    if (message.role === 'toolResult' && !seenCalls.has(message.toolCallId)) {
      orphans.push({ index, toolCallId: message.toolCallId, toolName: message.toolName })
    }
  }
  return orphans
}

const pricingCatalog = {
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-test': {
        id: 'gpt-test',
        name: 'GPT Test',
        family: 'gpt',
        cost: {
          input: 1,
          output: 10,
          cache_read: 0.1,
          cache_write: 1.25,
          reasoning: 15
        },
        limit: { context: 1000, output: 100 }
      }
    }
  }
}

test('Codex adapter emits tool-independent coding session IR', () => {
  const ir = importCodexJsonl(fixture)
  assert.equal(ir.schema, 'session-indexer.coding-session-ir.v1')
  assert.equal(ir.session.id, 'mini-session')
  assert.equal(ir.session.agent, 'codex')
  assert.ok(ir.events.some(event => event.type === 'tool_call' && event.call.name === 'exec_command'))
  assert.ok(ir.events.some(event => event.type === 'tool_result' && event.callId === 'call_todo'))

  const reasoning = ir.events.find(event => event.type === 'reasoning')
  assert.ok(reasoning)
  assert.equal(reasoning.reasoning[0].modelFamily, 'openai')
  assert.equal(reasoning.reasoning[0].encrypted, 'encrypted-openai-reasoning')

  const usage = ir.events.find(event => event.type === 'usage')
  assert.ok(usage)
  assert.deepEqual(usage.usage, {
    input: 100,
    output: 20,
    cache_read: 70,
    cache_write: 0,
    reasoning: 5,
    total: 120
  })
  assert.equal(ir.session.usage.total, 120)
  assert.equal(ir.source.fingerprint.compactionCount, 1)
  assert.deepEqual(ir.source.fingerprint, codexSessionFingerprint(fixture))
})

test('Codex sessions convert to Pi v3 JSONL entries', async () => {
  const ir = importCodexJsonl(fixture)
  const converted = piEntriesFromIr(ir)

  assert.equal(converted.cwd, '/tmp/project')
  assert.equal(converted.entries[0].type, 'session')
  assert.equal(converted.entries[0].version, 3)
  assert.equal(converted.entries[0].cwd, '/tmp/project')
  assert.ok(converted.entries.some(entry => entry.type === 'session_info' && /Imported Codex/.test(entry.name)))
  assert.ok(converted.entries.some(entry =>
    entry.type === 'message' &&
    entry.message.role === 'user' &&
    /inspect the todo sync output/.test(entry.message.content)
  ))
  assert.ok(converted.entries.some(entry =>
    entry.type === 'message' &&
    entry.message.role === 'assistant' &&
    entry.message.content.some(block => block.type === 'toolCall' && block.id === 'call_todo')
  ))
  assert.ok(converted.entries.some(entry =>
    entry.type === 'message' &&
    entry.message.role === 'toolResult' &&
    entry.message.toolCallId === 'call_todo' &&
    /clientRevision 7/.test(entry.message.content[0].text)
  ))
  const compaction = converted.entries.find(entry => entry.type === 'compaction')
  assert.ok(compaction)
  assert.equal(compaction.summary, 'Compacted earlier todo sync discussion.')
  assert.ok(compaction.firstKeptEntryId)
  assert.ok(compaction.tokensBefore > 0)
  assert.equal(compaction.details.summarySource, 'codex.payload.message')
  assert.deepEqual(compaction.details.replacementHistory, [{ role: 'user', content: 'summary' }])

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-pi-import-'))
  const result = await runCommand(parseArgs([
    'import_codex_session_to_pi',
    '--session', fixture,
    '--pi-agent-dir', root
  ]))
  assert.equal(result.importedCount, 1)
  assert.equal(result.sessions[0].entryCount, converted.entries.length)
  assert.equal(result.sessions[0].compactionCount, 1)
  assert.match(result.sessions[0].path, /--tmp-project--/)
  const written = fs.readFileSync(result.sessions[0].path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(written[0], converted.entries[0])
  assert.equal(written.at(-1).parentId, written.at(-2).id)
})

test('Pi import normalizes Codex web search pairs for OpenAI tool protocol', () => {
  const ir = createSessionIR({
    source: { path: '/tmp/web-search.jsonl' },
    session: {
      id: 'web-search-session',
      cwd: '/tmp/project',
      startedAt: '2026-06-05T00:00:00.000Z',
      agent: 'codex',
      model: 'codex-test',
      modelFamily: 'openai'
    },
    events: [
      {
        type: 'compaction',
        role: 'system',
        at: '2026-06-05T00:00:01.000Z',
        content: { message: 'Earlier search work was compacted.', replacementHistory: [] }
      },
      {
        type: 'tool_result',
        role: 'tool',
        at: '2026-06-05T00:00:02.000Z',
        toolName: 'web_search',
        callId: 'ws_result_first',
        output: JSON.stringify({ query: 'alpha', action: { type: 'search', query: 'alpha' } })
      },
      {
        type: 'tool_call',
        role: 'assistant',
        at: '2026-06-05T00:00:03.000Z',
        call: {
          id: 'web_search_synthetic_after_result',
          name: 'web_search',
          arguments: { type: 'search', query: 'alpha' }
        }
      },
      {
        type: 'tool_call',
        role: 'assistant',
        at: '2026-06-05T00:00:04.000Z',
        call: {
          id: 'web_search_synthetic_before_result',
          name: 'web_search',
          arguments: { type: 'open_page', url: 'https://example.com' }
        }
      },
      {
        type: 'tool_result',
        role: 'tool',
        at: '2026-06-05T00:00:05.000Z',
        toolName: 'web_search',
        callId: 'ws_call_first',
        output: JSON.stringify({ query: 'https://example.com', action: { type: 'open_page', url: 'https://example.com' } })
      }
    ]
  })

  const converted = piEntriesFromIr(ir)
  const messages = piMessagesFromEntries(converted.entries)
  assert.deepEqual(collectOrphanPiToolResults(messages), [])

  const webCalls = messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block && block.type === 'toolCall' && block.name === 'web_search')
    : [])
  const webResults = messages.filter(message => message.role === 'toolResult' && message.toolName === 'web_search')
  assert.deepEqual(webCalls.map(call => call.id), ['ws_result_first', 'ws_call_first'])
  assert.deepEqual(webResults.map(message => message.toolCallId), ['ws_result_first', 'ws_call_first'])
})

test('Codex source fingerprint ignores live tail changes after the same compaction boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-source-fingerprint-'))
  const session = path.join(root, 'session.jsonl')
  fs.copyFileSync(fixture, session)
  const before = codexSessionFingerprint(session)
  fs.appendFileSync(session, `${JSON.stringify({
    timestamp: '2026-06-05T00:00:09.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'live tail after compaction' }
  })}\n`)
  const after = codexSessionFingerprint(session)
  assert.deepEqual(after, before)
})

test('Claude adapter emits tool-independent coding session IR', () => {
  const ir = importClaudeJsonl(claudeFixture)
  assert.equal(ir.schema, 'session-indexer.coding-session-ir.v1')
  assert.equal(ir.session.id, 'claude-mini')
  assert.equal(ir.session.agent, 'claude')
  assert.equal(ir.session.title, 'Mini Claude session')
  assert.equal(ir.session.cwd, '/tmp/project')
  assert.equal(ir.session.model, 'claude-opus-4-8')
  assert.equal(ir.session.modelFamily, 'anthropic')

  // user string content -> user message
  const user = ir.events.find(event => event.type === 'message' && event.role === 'user')
  assert.match(user.content[0].text, /run the tests/)

  // assistant text/thinking/tool_use blocks all become events
  assert.ok(ir.events.some(event => event.type === 'message' && event.role === 'assistant'))
  const reasoning = ir.events.find(event => event.type === 'reasoning')
  assert.ok(reasoning)
  assert.equal(reasoning.reasoning[0].modelFamily, 'anthropic')
  assert.equal(reasoning.reasoning[0].signature, 'sig-abc')

  // tool_use <-> tool_result pairing
  const toolCall = ir.events.find(event => event.type === 'tool_call')
  assert.equal(toolCall.call.name, 'Bash')
  assert.equal(toolCall.call.id, 'toolu_1')
  const toolResult = ir.events.find(event => event.type === 'tool_result')
  assert.equal(toolResult.toolCallId, 'toolu_1')
  assert.match(toolResult.output, /12 passing/)

  // anthropic usage cache fields normalize
  const usage = ir.events.find(event => event.type === 'usage')
  assert.deepEqual(usage.usage, {
    input: 100,
    output: 20,
    cache_read: 70,
    cache_write: 40,
    reasoning: 0,
    total: 120
  })

  // sidechain rows stay in the IR but are annotated
  assert.ok(ir.events.some(event => event.meta && event.meta.sidechain))
  // noisy diagnostic system rows are dropped
  assert.ok(!ir.events.some(event => event.title === 'system turn_duration'))
})

test('Claude adapter resolves the current session by session marker across project dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-claude-resolve-'))
  const olderDir = path.join(root, '-proj-a')
  const newerDir = path.join(root, '-proj-b')
  fs.mkdirSync(olderDir, { recursive: true })
  fs.mkdirSync(newerDir, { recursive: true })
  const older = path.join(olderDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')
  const newer = path.join(newerDir, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl')
  const marker = 'conversation_history-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  writeJsonl(older, [
    { type: 'user', message: { role: 'user', content: 'older session work' }, uuid: 'o-1', timestamp: '2026-06-01T00:00:00.000Z', cwd: '/tmp/a', sessionId: 'older' }
  ])
  writeJsonl(newer, [
    { type: 'user', message: { role: 'user', content: 'please start_indexing_session for session-indexer' }, uuid: 'n-1', timestamp: '2026-06-06T00:00:00.000Z', cwd: '/tmp/b', sessionId: 'newer' },
    { type: 'assistant', message: { model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'start_indexing_session', input: { session_marker: marker } }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: 'n-2', timestamp: '2026-06-06T00:00:01.000Z', cwd: '/tmp/b', sessionId: 'newer' }
  ])
  const resolved = resolveCurrentClaudeSessionFile({ root, command: 'start_indexing_session', sessionMarker: marker })
  assert.equal(resolved.file, newer)
  assert.equal(resolved.reason, 'session_marker_match')
  assert.equal(resolved.signals.sessionMarkerMatch.marker, marker)
})

test('Claude adapter detects real compact_boundary records, not resume summaries', () => {
  const tmp = path.join(os.tmpdir(), `session-indexer-claude-compact-${Date.now()}.jsonl`)
  writeJsonl(tmp, [
    { type: 'user', message: { role: 'user', content: 'do the thing' }, uuid: 'u-1', timestamp: '2026-06-06T00:00:00.000Z', cwd: '/tmp/p', sessionId: 'c-mini' },
    // Real Claude Code compaction boundary (verified against v2.1.x + docs).
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 167219, postTokens: 4210, preservedMessages: 3 }, parentUuid: null, logicalParentUuid: 'u-1', timestamp: '2026-06-06T00:00:01.000Z', uuid: 's-1', sessionId: 'c-mini', cwd: '/tmp/p' },
    // Synthesized post-compaction summary message.
    { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, parentUuid: 's-1', message: { role: 'user', content: 'This session is being continued from a previous conversation...' }, uuid: 'u-2', timestamp: '2026-06-06T00:00:02.000Z', cwd: '/tmp/p', sessionId: 'c-mini' },
    // Resume/title pointer — must NOT be treated as compaction.
    { type: 'summary', summary: 'Session title', leafUuid: 'u-2' }
  ])
  const ir = importClaudeJsonl(tmp)
  const compactions = ir.events.filter(event => event.type === 'compaction')
  assert.equal(compactions.length, 1)
  assert.equal(compactions[0].meta.trigger, 'auto')
  assert.equal(compactions[0].meta.preTokens, 167219)
  assert.equal(compactions[0].meta.postTokens, 4210)
  assert.equal(compactions[0].meta.preservedMessages, 3)
  assert.equal(compactions[0].meta.hasPreservedSegment, true)
  assert.equal(compactions[0].meta.logicalParentUuid, 'u-1')
  // the summary message is flagged, not original input
  const summaryMsg = ir.events.find(event => event.meta && event.meta.isCompactSummary)
  assert.ok(summaryMsg)
  assert.equal(summaryMsg.title, 'compaction summary')
  // the resume `type:"summary"` record produced no event
  assert.ok(!ir.events.some(event => event.content && JSON.stringify(event.content).includes('Session title')))
  fs.unlinkSync(tmp)
})

test('Codex adapter streams session JSONL without whole-file reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-stream-jsonl-'))
  const session = path.join(root, 'session.jsonl')
  writeJsonl(session, [
    {
      timestamp: '2026-06-05T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'stream-session', cwd: '/tmp/project', model_provider: 'openai', cli_version: 'test' }
    },
    {
      timestamp: '2026-06-05T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', client_id: 'stream-user', message: 'stream this jsonl' }
    },
    {
      timestamp: '2026-06-05T00:00:02.000Z',
      type: 'compacted',
      payload: { message: 'Compacted stream fixture.', replacement_history: [] }
    }
  ])

  const originalReadFileSync = fs.readFileSync
  fs.readFileSync = function guardedReadFileSync(file, ...args) {
    if (path.resolve(file) === path.resolve(session)) {
      throw new Error('session JSONL must not be read as one whole file')
    }
    return originalReadFileSync.call(this, file, ...args)
  }
  try {
    const ir = importCodexJsonl(session)
    assert.equal(ir.session.id, 'stream-session')
    assert.ok(ir.events.some(event =>
      event.type === 'message' &&
      event.content.some(block => block.type === 'text' && block.text === 'stream this jsonl')
    ))
    assert.equal(codexSessionFingerprint(session).compactionCount, 1)
  } finally {
    fs.readFileSync = originalReadFileSync
  }
})

test('MIP search links tool calls and results through openLink', () => {
  const ir = importCodexJsonl(fixture)
  const tree = buildMipTree(ir)
  assert.deepEqual(tree.root.usage, {
    input: 100,
    output: 20,
    cache_read: 70,
    cache_write: 0,
    reasoning: 5,
    total: 120
  })
  const resultNode = [...tree.byHandle.values()].find(node => /clientRevision 7/.test(node.raw))
  assert.ok(resultNode)
  const link = resultNode.resourceLinks.find(item => item.startsWith('tool:conversation_history://open?'))
  assert.ok(link)

  const opened = openLink(tree, link, { budgetTokens: 2000 })
  assert.equal(opened.isVerbatim, true)
  assert.match(opened.content, /clientRevision 7/)
})

test('openLink caps resource links on large nodes', () => {
  const events = Array.from({ length: 12 }, (_item, index) => ({
    type: 'message',
    role: 'user',
    content: [textBlock(`resource link cap probe ${index}`)]
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: 'resource-links.jsonl' },
    session: { id: 'resource-links', agent: 'codex', title: 'Resource Links' },
    events
  })
  const tree = buildMipTree(ir)
  const opened = openLink(tree, sessionLink({ sessionId: ir.session.id, handle: tree.root.handle }), {
    budgetTokens: 100
  })
  assert.equal(opened.childCount, 12)
  assert.equal(opened.resourceLinks.length, 5)
})

test('conversation links let search resolve an assistant response back to its user turn', () => {
  const ir = importCodexJsonl(fixture)
  const user = ir.events.find(event => event.type === 'message' && event.role === 'user')
  const assistant = ir.events.find(event => event.type === 'message' && event.role === 'assistant')
  const toolCall = ir.events.find(event => event.type === 'tool_call')
  const toolResult = ir.events.find(event => event.type === 'tool_result')

  assert.equal(user.messageId, 'user_msg_todo_1')
  assert.equal(assistant.inReplyToMessageId, user.messageId)
  assert.equal(toolCall.inReplyToMessageId, user.messageId)
  assert.equal(toolResult.inReplyToMessageId, user.messageId)
  assert.equal(toolCall.toolCallId, 'call_todo')
  assert.equal(toolResult.toolCallId, 'call_todo')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-link-filter-'))
  writeSessionIndex({ root, ir })
  const docs = collectIndexDocuments(readSessionTree({ root, sessionId: 'mini-session' }))

  const assistantDoc = docs.find(doc =>
    doc.messageId === assistant.messageId &&
    doc.inReplyToMessageId === user.messageId &&
    /dry run completed.*clientRevision/i.test(doc.searchText)
  )
  assert.ok(assistantDoc)

  const userLeaf = docs.find(doc => doc.messageId === user.messageId && doc.isVerbatim)
  assert.ok(userLeaf)
  assert.match(userLeaf.excerpt, /Can you inspect the todo sync output/)

  const toolDocs = docs.filter(doc => doc.toolCallId === 'call_todo' && doc.isVerbatim)
  assert.ok(toolDocs.some(doc => doc.kind === 'tool_call'))
  assert.ok(toolDocs.some(doc => doc.kind === 'tool_result'))
})

test('Codex turn context keeps in-flight user updates from stealing reply anchors', () => {
  const tmp = path.join(os.tmpdir(), `session-indexer-turn-${Date.now()}.jsonl`)
  writeJsonl(tmp, [
    {
      timestamp: '2026-06-05T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'turn-session', cwd: '/tmp/project', model_provider: 'openai', cli_version: 'test' }
    },
    {
      timestamp: '2026-06-05T00:00:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn_one', cwd: '/tmp/project', model: 'gpt-test' }
    },
    {
      timestamp: '2026-06-05T00:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', client_id: 'root_user_msg', message: 'Start the compaction implementation.' }
    },
    {
      timestamp: '2026-06-05T00:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call_impl', arguments: '{"cmd":"npm test"}' }
    },
    {
      timestamp: '2026-06-05T00:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', client_id: 'followup_user_msg', message: 'Also add case E while this is running.' }
    },
    {
      timestamp: '2026-06-05T00:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'Implemented. Case E is now explicit.' }
    }
  ])

  const ir = importCodexJsonl(tmp)
  const rootUser = ir.events.find(event => event.messageId === 'root_user_msg')
  const followupUser = ir.events.find(event => event.messageId === 'followup_user_msg')
  const toolCall = ir.events.find(event => event.type === 'tool_call')
  const assistant = ir.events.find(event => event.type === 'message' && event.role === 'assistant')

  assert.equal(rootUser.meta.turnRoot, true)
  assert.equal(followupUser.meta.turnRootMessageId, rootUser.messageId)
  assert.equal(toolCall.inReplyToMessageId, rootUser.messageId)
  assert.equal(assistant.inReplyToMessageId, rootUser.messageId)
})

test('encrypted reasoning is replay-only and never model-facing', () => {
  const ir = importCodexJsonl(fixture)
  const tree = buildMipTree(ir)
  const reasoningNode = [...tree.byHandle.values()].find(node => node.kind === 'reasoning' || node.meta && node.meta.type === 'reasoning')
  assert.ok(reasoningNode)

  const docs = collectIndexDocuments(tree)
  assert.equal(docs.some(doc => doc.kind === 'reasoning' || doc.searchText.includes('encrypted-openai-reasoning')), false)

  const renderedRoot = openLink(tree, sessionLink({ sessionId: ir.session.id, handle: tree.root.handle }), {
    budgetTokens: 10000
  })
  assert.doesNotMatch(renderedRoot.content, /encrypted-openai-reasoning/)
  assert.doesNotMatch(renderedRoot.content, /Need to inspect the todo sync command output/)
  assert.throws(
    () => openLink(tree, sessionLink({ sessionId: ir.session.id, handle: reasoningNode.handle }), { budgetTokens: 1000 }),
    /Reasoning records are not available/
  )

  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 1000 })
  const prompt = makePrompt({
    node: prepared.nodes[0],
    maxChildChars: 1200,
    inputTokenBudget: 1000
  })
  assert.doesNotMatch(prompt, /encrypted-openai-reasoning/)
  assert.doesNotMatch(prompt, /Need to inspect the todo sync command output/)
})

test('Typesense schema supports exact conversation filters', () => {
  const fields = new Map(collectionSchema('test_docs').fields.map(field => [field.name, field]))
  assert.equal(fields.get('indexId').facet, true)
  assert.equal(fields.get('sessionId').facet, true)
  assert.equal(fields.get('agent').facet, true)
  assert.equal(fields.get('agent').optional, undefined)
  for (const name of ['messageId', 'inReplyToMessageId', 'toolCallId', 'role', 'depth', 'mipLevel', 'isVerbatim']) {
    assert.ok(fields.has(name), `${name} field exists`)
    assert.equal(fields.get(name).facet, true, `${name} is facetable`)
  }
  assert.equal(fields.get('handle').facet, undefined)
  assert.ok(fields.has('siblingIndex'), 'siblingIndex field exists for Typesense-backed browse ordering')
  assert.equal(fields.get('siblingIndex').sort, true)
  for (const name of ['siblingCount', 'mip', 'mips', 'fullTokenCount', 'childCount', 'payload']) {
    assert.equal(fields.has(name), false, `${name} does not belong in the Typesense schema as a typed field`)
  }
  assert.equal(fields.get('navigationJson').index, false)
  assert.equal(fields.get('metricsJson').index, false)
  assert.equal(fields.get('content').index, false)
  assert.equal(fields.get('topicsJson').index, false)
  assert.equal(fields.get('usageJson').index, false)

  const stored = docForTypesense({
    id: 'doc-1',
    indexId: 'idx-mini',
    sessionId: 'mini-session',
    agent: 'codex',
    handle: 'session/mini-session/event/1',
    link: 'tool:conversation_history://open?indexId=idx-mini&handle=session%2Fmini-session%2Fevent%2F1',
    parentHandle: 'session/mini-session',
    index: '1/2',
    zoom: '2/3',
    navigation: {
      siblingIndex: 1,
      siblingCount: 2,
      mip: 2,
      mips: 3,
      parentHandle: 'session/mini-session'
    },
    kind: 'message',
    mipLevel: 'leaf',
    isVerbatim: true,
    title: 'message',
    summary: 'short summary',
    summaryMeta: {
      mode: 'off',
      status: 'completed',
      compactionLog: [{ oversized: true }]
    },
    searchText: 'searchable text',
    content: 'exact source text',
    topics: ['API wiring.'],
    usage: { input: 1, output: 2, total: 3 },
    resourceLinks: ['tool:conversation_history://open?sessionId=mini-session&handle=session%2Fmini-session'],
    fullTokenCount: 4,
    childCount: 0,
    ts: 1
  })
  assert.equal(stored.payload, undefined)
  assert.equal(stored.indexId, 'idx-mini')
  assert.equal(stored.agent, 'codex')
  assert.equal(stored.content, 'exact source text')
  assert.equal(stored.nodeIndex, '1/2')
  assert.deepEqual(JSON.parse(stored.summaryMetaJson), {
    mode: 'off',
    status: 'completed'
  })
  assert.equal(JSON.parse(stored.navigationJson).siblingIndex, 1)
  assert.equal(JSON.parse(stored.metricsJson).fullTokenCount, 4)
})

test('Typesense docs require a session id for shared-backend filtering', () => {
  assert.throws(() => docForTypesense({
    id: 'missing-index',
    sessionId: 'mini-session',
    agent: 'codex',
    handle: 'session/mini-session',
    depth: 0,
    kind: 'session',
    mipLevel: 'root',
    isVerbatim: false
  }), /requires indexId/)

  assert.throws(() => docForTypesense({
    id: 'missing-session',
    indexId: 'idx-mini',
    handle: 'session/missing',
    depth: 0,
    kind: 'session',
    mipLevel: 'root',
    isVerbatim: false
  }), /requires sessionId/)

  const stored = docForTypesense({
    id: 'with-session',
    indexId: 'idx-mini',
    sessionId: 'mini-session',
    agent: 'codex',
    handle: 'session/mini-session',
    depth: 0,
    kind: 'session',
    mipLevel: 'root',
    isVerbatim: false
  })
  assert.equal(stored.sessionId, 'mini-session')
  assert.equal(stored.indexId, 'idx-mini')
  assert.equal(stored.agent, 'codex')

  assert.throws(() => docForTypesense({
    id: 'missing-agent',
    indexId: 'idx-mini',
    sessionId: 'mini-session',
    handle: 'session/mini-session',
    depth: 0,
    kind: 'session',
    mipLevel: 'root',
    isVerbatim: false
  }), /requires agent/)
})

test('Typesense docs replace lone surrogates before JSONL import', () => {
  const stored = docForTypesense({
    id: 'bad-surrogate',
    indexId: 'idx-mini',
    sessionId: 'mini-session',
    agent: 'codex',
    handle: 'session/mini-session/event/1',
    depth: 1,
    kind: 'message',
    mipLevel: 'leaf',
    isVerbatim: true,
    title: 'bad high \uD800 and bad low \uDC00 but keep pair \uD83D\uDE00',
    summary: 'summary \uD800',
    searchText: 'search \uDC00',
    content: 'content \uD800',
    topics: ['topic \uD800'],
    resourceLinks: ['tool:conversation_history://open?handle=\uDC00']
  })

  assert.equal(stored.title, 'bad high \uFFFD and bad low \uFFFD but keep pair \uD83D\uDE00')
  assert.equal(stored.summary, 'summary \uFFFD')
  assert.equal(stored.searchText, 'search \uFFFD')
  assert.equal(stored.content, 'content \uFFFD')
  assert.deepEqual(JSON.parse(stored.topicsJson), ['topic \uFFFD'])
  assert.deepEqual(JSON.parse(stored.resourceLinksJson), ['tool:conversation_history://open?handle=\uFFFD'])
  assert.doesNotMatch(JSON.stringify(stored), /\\ud(?:[89ab][0-9a-f]{2}|[cdef][0-9a-f]{2})/i)
})

test('Typesense imports reject cross-session records before backend startup', async () => {
  await assert.rejects(() => importDocuments({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-import-agent-required-')),
    sessionId: 'mini-session',
    docs: [],
    typesenseInstall: false
  }), /requires agent/)

  await assert.rejects(() => importDocuments({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-import-session-guard-')),
    sessionId: 'mini-session',
    agent: 'codex',
    docs: [{
      id: 'wrong-session',
      indexId: 'idx-other',
      sessionId: 'other-session',
      agent: 'codex',
      handle: 'session/other-session',
      depth: 0,
      kind: 'session',
      mipLevel: 'root',
      isVerbatim: false
    }],
    typesenseInstall: false
  }), /does not match import sessionId/)

  await assert.rejects(() => importDocuments({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-import-agent-guard-')),
    sessionId: 'mini-session',
    agent: 'codex',
    docs: [{
      id: 'wrong-agent',
      indexId: 'idx-mini',
      sessionId: 'mini-session',
      agent: 'claude',
      handle: 'session/mini-session',
      depth: 0,
      kind: 'session',
      mipLevel: 'root',
      isVerbatim: false
    }],
    typesenseInstall: false
  }), /does not match import agent/)
})

test('index document ids include agent for shared Typesense backends', () => {
  const codexIr = createSessionIR({
    source: { kind: 'codex', path: 'shared-session.jsonl' },
    session: { id: 'shared-session', agent: 'codex', title: 'Shared Session' },
    events: [{ type: 'message', role: 'user', content: [textBlock('same handle shape')] }]
  })
  const claudeIr = createSessionIR({
    source: { kind: 'claude', path: 'shared-session.jsonl' },
    session: { id: 'shared-session', agent: 'claude', title: 'Shared Session' },
    events: [{ type: 'message', role: 'user', content: [textBlock('same handle shape')] }]
  })

  const codexRoot = collectIndexDocuments(buildMipTree(codexIr)).find(doc => doc.handle === 'session/shared-session')
  const claudeRoot = collectIndexDocuments(buildMipTree(claudeIr)).find(doc => doc.handle === 'session/shared-session')
  assert.equal(codexRoot.agent, 'codex')
  assert.equal(claudeRoot.agent, 'claude')
  assert.notEqual(codexRoot.id, claudeRoot.id)
})

test('managed Typesense binds API and peering services to localhost', () => {
  const port = 30000 + (process.pid % 10000)
  const peeringPort = port + 1
  const args = managedTypesenseServerArgs({
    dataDir: '/tmp/session-indexer-typesense',
    apiKey: 'test-key',
    port,
    peeringPort
  })
  assert.ok(args.includes('--api-address=127.0.0.1'))
  assert.ok(args.includes(`--api-port=${port}`))
  assert.ok(args.includes('--peering-address=127.0.0.1'))
  assert.ok(args.includes(`--peering-port=${peeringPort}`))
})

test('default ConversationHistory state is shared across repo and plugin copies', () => {
  assert.match(LOCAL_STATE_DIR, /session-indexer[/\\]\.session-indexer$/)
  if (!process.env.SESSION_INDEXER_STATE_DIR) {
    assert.notEqual(LOCAL_STATE_DIR, path.join(REPO_ROOT, '.session-indexer'))
  }

  const parsed = parseArgs(['index_status', '--start-at', '0', '--limit', '1'])
  assert.equal(parsed.indexDir, LOCAL_STATE_DIR)
})

test('managed Typesense owns persisted port allocation and log paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-typesense-runtime-'))
  const first = await managedRuntimeInfo({ root })
  const second = await managedRuntimeInfo({ root })
  assert.equal(second.port, first.port)
  assert.equal(second.peeringPort, first.peeringPort)
  assert.notEqual(first.peeringPort, first.port)
  assert.equal(second.url, first.url)
  assert.match(first.url, new RegExp(`:${first.port}$`))
  assert.ok(first.logs.stdout.endsWith('typesense.out.log'))
  assert.ok(first.logs.stderr.endsWith('typesense.err.log'))

  const status = await managedTypesenseStatus({ root })
  assert.equal(status.port, first.port)
  assert.equal(status.peeringPort, first.peeringPort)
  assert.equal(status.url, first.url)
  assert.deepEqual(status.logs, first.logs)
  assert.equal(status.health.ok, false)
})

test('CLI accepts filter-only paged search requests', () => {
  const parsed = parseArgs([
    'search',
    '--filter',
    '{"messageId":"msg_1","mip":0,"role":"assistant"}',
    '--start-at',
    '0',
    '--limit',
    '1'
  ])

  assert.equal(parsed.filter, '{"messageId":"msg_1","mip":0,"role":"assistant"}')
  assert.equal(parsed.startAt, 0)
  assert.equal(parsed.limit, 1)

  const roleOnly = parseArgs(['search', '--role', 'assistant', '--limit', '1'])
  assert.equal(roleOnly.role, 'assistant')
  assert.equal(roleOnly.limit, 1)
  const agentOnly = parseArgs(['search', '--agent', 'codex', '--limit', '1'])
  assert.equal(agentOnly.agent, 'codex')
  assert.throws(() => parseArgs(['index_status']), /requires --start-at and --limit/)
  assert.throws(() => parseArgs(['index_status', '--start-at', '0']), /requires --start-at and --limit/)
  const statusPage = parseArgs(['index_status', '--start-at', '0', '--limit', '2'])
  assert.equal(statusPage.startAt, 0)
  assert.equal(statusPage.limit, 2)
  assert.throws(() => parseArgs(['index_status', '--start-at', '0', '--limit', '101']), /limit must be 100 or less/)
  assert.throws(() => parseArgs(['typesense_status', '--typesense-port', '12345']), /unknown argument: --typesense-port/)
  assert.throws(() => parseArgs(['search', '--query', 'x', '--search-backend', 'json']), /search-backend must be typesense/)
})

test('CLI accepts index id as the definitive browse/search id', () => {
  const search = parseArgs(['search', '--index-id', 'idx-abc'])
  assert.equal(search.indexId, 'idx-abc')

  const browse = parseArgs(['browse', '--index-id', 'idx-abc'])
  assert.equal(browse.indexId, 'idx-abc')
  assert.equal(browse.sessionId, '')

  const catalogBrowse = parseArgs(['browse', '--query', 'agent docs', '--start', '2', '--limit', '3'])
  assert.equal(catalogBrowse.indexId, '')
  assert.equal(catalogBrowse.query, 'agent docs')
  assert.equal(catalogBrowse.start, 2)
  assert.equal(catalogBrowse.limit, 3)
})

test('Typesense search failures reject instead of returning empty hits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-typesense-error-'))
  await assert.rejects(() => searchIndexWithBackend({
    root,
    query: 'clientRevision',
    typesenseInstall: false,
    typesenseCollection: `session_indexer_test_${process.pid}`
  }), /managed Typesense is not installed/)
})

test('Typesense backend imports no-compaction docs but hides live context from retrieval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-typesense-single-doc-'))
  const typesenseCollection = `session_indexer_single_${process.pid}_${Date.now()}`
  const sessionFile = path.join(root, 'single-session.jsonl')
  const ir = createSessionIR({
    source: { kind: 'test', path: sessionFile },
    session: { id: 'single-session', agent: 'codex', title: 'Single Session' },
    events: [{
      type: 'message',
      role: 'user',
      content: [textBlock('zzzz_live_probe_9482')]
    }]
  })
  const indexed = await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'off',
    typesenseCollection
  })
  assert.equal(indexed.sessionId, 'single-session')
  assert.equal(indexed.serverIndex.status, 'ready')
  assert.equal(indexed.serverIndex.result.imported, 3)
  assert.equal(indexed.docCount, 3)
  const codexSearch = await searchIndexWithBackend({
    root,
    query: 'zzzz_live_probe_9482',
    agent: 'codex',
    typesenseCollection
  })
  assert.equal(codexSearch.hits.length, 0)
  const claudeSearch = await searchIndexWithBackend({
    root,
    query: 'single backend import probe',
    agent: 'claude',
    typesenseCollection
  })
  assert.equal(claudeSearch.hits.length, 0)
})

test('Typesense publish defers repeated imports while model summaries are incomplete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-typesense-defer-'))
  const ir = importCodexJsonl(fixture)
  const typesenseCollection = `session_indexer_defer_${process.pid}_${Date.now()}`
  const firstProgress = []
  const first = await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'model',
    maxSummaryNodes: 0,
    typesenseCollection,
    onProgress: event => firstProgress.push(event)
  })
  assert.equal(first.serverIndex.status, 'ready')
  assert.ok(first.serverIndex.result.imported > 0)
  assert.ok(first.indexingStats.pendingTargetCount > 0)
  assert.ok(firstProgress.some(event => event.phase === 'index:documents'))
  assert.ok(firstProgress.some(event => event.phase === 'index:documents:upsert:preserve-existing'))
  assert.ok(firstProgress.some(event => event.phase === 'index:documents:import:chunk'))
  assert.equal(firstProgress.some(event => event.phase === 'index:documents:delete:start'), false)
  assert.equal(firstProgress.some(event => event.phase === 'index:documents:delete:done'), false)
  const firstManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(Object.hasOwn(firstManifest.sessions[first.sessionId], 'summaryJobs'), false)
  assert.equal(Object.hasOwn(firstManifest.sessions[first.sessionId], 'compactions'), false)
  assert.equal(Object.hasOwn(firstManifest.sessions[first.sessionId].summaryIndex, 'compactionLog'), false)
  const target = first.compactions.flatMap(compaction => compaction.targets || [])[0]
  assert.ok(target && target.targetId)
  commitSummaryJobs({
    root,
    sessionId: first.sessionId,
    ownerId: 'test-error-owner',
    jobs: [{
      ...target,
      error: 'synthetic summary failure'
    }]
  })

  const secondProgress = []
  const second = await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'model',
    maxSummaryNodes: 0,
    typesenseCollection,
    onProgress: event => secondProgress.push(event)
  })
  assert.equal(second.serverIndex.status, 'deferred')
  assert.equal(second.serverIndex.reason, 'summary_incomplete')
  const secondStatus = indexStatus({ root, sessionId: first.sessionId })
  assert.equal(secondStatus.sessions[0].summaryTargetStore.currentStoredFailedTargetCount, 1)
  assert.equal(second.docCount, first.docCount)
  assert.equal(second.serverIndex.previousDocCount, first.docCount)
  assert.ok(secondProgress.some(event => event.phase === 'index:documents:deferred'))
  assert.equal(secondProgress.some(event => event.phase === 'index:documents'), false)

  const thirdProgress = []
  const third = await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'model',
    maxSummaryNodes: 0,
    typesenseCollection,
    onProgress: event => thirdProgress.push(event)
  })
  assert.equal(third.serverIndex.status, 'deferred')
  assert.equal(third.docCount, first.docCount)
  assert.equal(thirdProgress.some(event => event.phase === 'index:documents'), false)

  const searched = await searchIndexWithBackend({
    root,
    query: 'clientRevision',
    sessionId: 'mini-session',
    typesenseCollection,
    limit: 1
  })
  assert.ok(searched.hits.length > 0)
})

test('persisted state read failures throw instead of returning empty status', () => {
  const manifestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-bad-manifest-'))
  fs.writeFileSync(path.join(manifestRoot, 'manifest.json'), '{not json')
  assert.throws(() => indexStatus({ root: manifestRoot, sessionId: 'mini-session' }), /JSON|Unexpected token/)

  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-bad-job-'))
  fs.writeFileSync(path.join(jobRoot, 'manifest.json'), `${JSON.stringify({
    schema: 'session-indexer.manifest.v1',
    updatedAt: new Date().toISOString(),
    sessions: {
      'mini-session': {
        sessionId: 'mini-session',
        sourcePath: path.join(jobRoot, 'missing.jsonl'),
        indexedAt: new Date().toISOString(),
        indexingStats: {}
      }
    }
  })}\n`)
  fs.mkdirSync(path.join(jobRoot, 'jobs'), { recursive: true })
  fs.writeFileSync(path.join(jobRoot, 'jobs', 'broken.json'), '{not json')
  assert.throws(() => indexStatus({ root: jobRoot, sessionId: 'mini-session' }), /JSON|Unexpected token/)
})

test('search documents preserve searchable navigation metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-'))
  const ir = importCodexJsonl(fixture)
  const indexed = writeSessionIndex({ root, ir })
  assert.equal(indexed.sessionId, 'mini-session')
  assert.ok(indexed.docCount > ir.events.length)
  assert.equal(indexed.usage.total, 120)

  assert.ok(fs.existsSync(path.join(root, 'sessions', 'mini-session.ir.jsonl')))
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'mini-session.ir.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'index', 'mini-session.docs.json')), false)
  const docs = collectIndexDocuments(readSessionTree({ root, sessionId: 'mini-session' }))
  const rootDoc = docs.find(doc => doc.handle === 'session/mini-session')
  assert.equal(rootDoc.indexId, indexIdForIR(ir))
  assert.match(rootDoc.link, /indexId=/)
  assert.equal(rootDoc.usage.cache_read, 70)
  assert.equal(rootDoc.index, '1/1')
  assert.match(rootDoc.zoom, /^1\/\d+$/)
  assert.ok(rootDoc.navigation.mips >= rootDoc.navigation.mip)

  const searchableDoc = docs.find(doc => /clientRevision/i.test(doc.searchText) && /atlas/i.test(doc.searchText))
  assert.ok(searchableDoc)
  assert.ok(searchableDoc.link.startsWith('tool:conversation_history://open?'))
  assert.match(searchableDoc.index, /^\d+\/\d+$/)
  assert.match(searchableDoc.zoom, /^\d+\/\d+$/)
  assert.ok(searchableDoc.navigation.siblingCount >= searchableDoc.navigation.siblingIndex)
})

test('top-level browse returns a compact paged session catalog', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-catalog-'))
  const oldIr = createSessionIR({
    source: { kind: 'test', path: path.join(root, 'old.jsonl') },
    session: {
      id: 'old-session',
      agent: 'codex',
      title: 'Older compiler frontend notes',
      updatedAt: '2026-06-01T00:00:00.000Z'
    },
    events: [
      { type: 'message', role: 'user', content: [textBlock('Design the compiler frontend notes.')] },
      { type: 'message', role: 'assistant', content: [textBlock('Frontend notes captured.')] }
    ]
  })
  const newIr = createSessionIR({
    source: { kind: 'test', path: path.join(root, 'new.jsonl') },
    session: {
      id: 'new-session',
      agent: 'codex',
      title: 'New agent doc catalog work',
      updatedAt: '2026-06-03T00:00:00.000Z'
    },
    events: [
      { type: 'message', role: 'user', content: [textBlock('Add a catalog browser.')] },
      { type: 'message', role: 'assistant', content: [textBlock('Catalog browser implemented.')] },
      { type: 'message', role: 'user', content: [textBlock('Keep output compact.')] }
    ]
  })
  writeSessionIndex({ root, ir: oldIr })
  writeSessionIndex({ root, ir: newIr })

  const firstPage = await runCommand(parseArgs([
    'browse',
    '--index-dir', root,
    '--start', '0',
    '--limit', '1'
  ]))
  assert.equal(firstPage.schema, 'session-indexer.browse.v1')
  assert.equal(firstPage.level, 'sessions')
  assert.equal(firstPage.page.total, 2)
  assert.equal(firstPage.page.returned, 1)
  assert.equal(firstPage.page.next_start, 1)
  assert.equal(firstPage.sessions[0].session_id, 'new-session')
  assert.equal(firstPage.sessions[0].turn_count, 2)
  assert.equal(firstPage.sessions[0].event_count, 3)
  assert.equal(firstPage.sessions[0].browse.index_id, indexIdForIR(newIr))
  assert.equal(firstPage.sessions[0].browse.topic_id, 'root')
  assert.equal(Object.hasOwn(firstPage, 'resourceUsage'), false)
  assert.equal(Object.hasOwn(firstPage.sessions[0], 'sourcePath'), false)
  assert.equal(Object.hasOwn(firstPage.sessions[0], 'summaryIndex'), false)
  assert.equal(Object.hasOwn(firstPage.sessions[0], 'usage'), false)

  const secondPage = await runCommand(parseArgs([
    'browse',
    '--index-dir', root,
    '--start', '1',
    '--limit', '1'
  ]))
  assert.equal(secondPage.sessions[0].session_id, 'old-session')

  const filtered = browseSessionCatalog({ root, query: 'frontend', limit: 5 })
  assert.equal(filtered.page.total, 1)
  assert.equal(filtered.sessions[0].session_id, 'old-session')
})

test('summary and leaf docs expose chronological anchors', () => {
  const ir = importCodexJsonl(fixture)
  const tree = buildMipTree(ir)
  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 1000 })
  const summary = prepared.nodes[0]

  assert.deepEqual(summary.meta.startAt, '2026-06-05T00:00:00.000Z')
  assert.deepEqual(summary.meta.endAt, '2026-06-05T00:00:05.000Z')

  const docs = collectIndexDocuments(tree)
  const summaryDoc = docs.find(doc => doc.handle === summary.handle)
  assert.deepEqual(summaryDoc.timeRange, {
    start: '2026-06-05T00:00:00.000Z',
    end: '2026-06-05T00:00:05.000Z'
  })

  const leafDoc = docs.find(doc => doc.handle.includes('/content') && /Can you inspect/.test(doc.searchText))
  assert.equal(leafDoc.at, '2026-06-05T00:00:01.000Z')
})

test('index docs bound inner-node descendant text without losing leaf search', () => {
  const events = Array.from({ length: 80 }, (_item, index) => ({
    type: 'message',
    role: index % 2 ? 'assistant' : 'user',
    content: [textBlock(`${index === 79 ? 'late_unique_marker ' : ''}${'large transcript block '.repeat(120)}`)]
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: 'large.jsonl' },
    session: { id: 'large-session', agent: 'codex', title: 'Large session' },
    events
  })
  const tree = buildMipTree(ir)
  const docs = collectIndexDocuments(tree)
  const rootDoc = docs.find(doc => doc.handle === 'session/large-session')
  assert.ok(rootDoc.searchText.length <= 20000)
  assert.doesNotMatch(rootDoc.searchText, /late_unique_marker/)

  assert.ok(docs.some(doc =>
    doc.isVerbatim &&
    doc.handle.includes('/content') &&
    /late_unique_marker/.test(doc.searchText)
  ))
})

test('MIP documents expose generated breadcrumbs for navigation', () => {
  const ir = importCodexJsonl(fixture)
  const tree = buildMipTree(ir)
  const node = [...tree.byHandle.values()].find(item => item.children.length)
  node.breadcrumb = 'handoff'
  node.head = 'summary about emergency handoff'

  const docs = collectIndexDocuments(tree)
  const doc = docs.find(item => item.handle === node.handle)
  assert.equal(doc.breadcrumb, 'handoff')
  assert.match(doc.index, /^\d+\/\d+$/)
  assert.match(doc.zoom, /^\d+\/\d+$/)

  assert.ok(doc.searchText.includes('handoff'))
})

test('summary planner skips sessions with no compaction boundary', () => {
  const ir = createSessionIR({
    source: { kind: 'test', path: 'no-compact.jsonl' },
    session: { id: 'no-compact', agent: 'codex', title: 'No compact' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('alpha live context')] },
      { type: 'message', role: 'assistant', content: [textBlock('beta live context')] }
    ]
  })
  const tree = buildMipTree(ir)
  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 1000 })
  const docs = collectIndexDocuments(tree)

  assert.equal(prepared.status, 'no_compaction')
  assert.equal(prepared.nodes.length, 0)
  assert.equal(tree.root.children.length, 0)
  assert.equal(docs.length, 1)
  assert.equal(docs[0].childCount, 0)
})

test('summary planner batches only the compacted-away prefix before a compaction', () => {
  const ir = createSessionIR({
    source: { kind: 'test', path: 'one-compact.jsonl' },
    session: { id: 'one-compact', agent: 'codex', title: 'One compact' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('alpha_before_compact')] },
      { type: 'message', role: 'assistant', content: [textBlock('beta_before_compact')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] },
      { type: 'message', role: 'user', content: [textBlock('gamma_after_compact_live_tail')] }
    ]
  })
  const tree = buildMipTree(ir)
  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 1000 })

  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.compactedSpanCount, 1)
  assert.equal(prepared.nodes.length, 1)
  assert.equal(prepared.nodes[0].children.length, 2)

  const prompt = makePrompt({
    node: prepared.nodes[0],
    maxChildChars: 1200,
    inputTokenBudget: 1000
  })
  assert.match(prompt, /alpha_before_compact/)
  assert.match(prompt, /beta_before_compact/)
  assert.doesNotMatch(prompt, /provider compact marker/)
  assert.doesNotMatch(prompt, /gamma_after_compact_live_tail/)
})

test('retrieval visibility keeps live tail indexed but hidden from search and browse', () => {
  const ir = createSessionIR({
    source: { kind: 'test', path: 'visibility-compact.jsonl' },
    session: { id: 'visibility-compact', agent: 'codex', title: 'Visibility compact' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('alpha_before_compact_visible')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] },
      { type: 'message', role: 'user', content: [textBlock('omega_after_compact_hidden')] }
    ]
  })
  const tree = buildMipTree(ir)
  const visibleHandles = compactedRetrievalHandles(tree)
  const docs = collectIndexDocuments(tree, {
    retrievalVisible: node => visibleHandles.has(node.handle)
  })

  const before = docs.find(doc => /alpha_before_compact_visible/.test(doc.searchText))
  const after = docs.find(doc => /omega_after_compact_hidden/.test(doc.searchText))
  assert.ok(before)
  assert.ok(after)
  assert.equal(before.retrievalVisible, true)
  assert.equal(after.retrievalVisible, false)
})

test('pending summary nodes do not match descendant raw search terms', () => {
  const ir = createSessionIR({
    source: { kind: 'test', path: 'pending-summary-search.jsonl' },
    session: { id: 'pending-summary-search', agent: 'codex', title: 'Pending summary search' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('needle_in_raw_child')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const tree = buildMipTree(ir)
  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 1000 })
  assert.equal(prepared.nodes[0].summaryMeta.status, 'pending')

  const docs = collectIndexDocuments(tree)
  const matchingDocs = docs.filter(doc => /needle_in_raw_child/.test(doc.searchText))
  assert.ok(matchingDocs.length)
  assert.equal(matchingDocs.some(doc => doc.kind === 'summary_span'), false)
  assert.ok(matchingDocs.some(doc => doc.isVerbatim && doc.handle.includes('/content')))
})

test('summary planner extends a boundary to keep paired tool calls and results together', () => {
  const ir = createSessionIR({
    source: { kind: 'test', path: 'tool-pair-compact.jsonl' },
    session: { id: 'tool-pair-compact', agent: 'codex', title: 'Tool pair compact' },
    events: [
      {
        type: 'tool_call',
        role: 'assistant',
        call: { id: 'call_pair_a', name: 'exec_command', arguments: { cmd: 'print important fact' } }
      },
      { type: 'message', role: 'assistant', content: [textBlock('intervening commentary that should stay chronological')] },
      {
        type: 'tool_result',
        role: 'tool',
        callId: 'call_pair_a',
        toolName: 'exec_command',
        output: 'important fact from tool result'
      },
      { type: 'message', role: 'assistant', content: [textBlock('after pair')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const tree = buildMipTree(ir)
  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 80 })
  const pairedNode = prepared.nodes.find(node =>
    node.children.some(child => child.meta && child.meta.type === 'tool_call' && child.meta.callId === 'call_pair_a') &&
    node.children.some(child => child.meta && child.meta.type === 'tool_result' && child.meta.callId === 'call_pair_a')
  )

  assert.ok(pairedNode)
  assert.deepEqual(
    pairedNode.children.slice(0, 3).map(child => child.meta && child.meta.type),
    ['tool_call', 'message', 'tool_result']
  )

  const prompt = makePrompt({
    node: pairedNode,
    maxChildChars: 1200,
    inputTokenBudget: 1
  })
  assert.match(prompt, /"tool_role":"call"/)
  assert.match(prompt, /"tool_role":"result"/)
  assert.match(prompt, /"tool_call_id":"call_pair_a"/)
})

test('summary planner backs up before a tool call when pairing extension is too large', () => {
  const longText = 'oversized intervening output '.repeat(2000)
  const ir = createSessionIR({
    source: { kind: 'test', path: 'tool-pair-backtrack.jsonl' },
    session: { id: 'tool-pair-backtrack', agent: 'codex', title: 'Tool pair backtrack' },
    events: [
      { type: 'message', role: 'assistant', content: [textBlock('safe prefix before tool call')] },
      {
        type: 'tool_call',
        role: 'assistant',
        call: { id: 'call_pair_b', name: 'exec_command', arguments: { cmd: 'print huge fact' } }
      },
      { type: 'message', role: 'assistant', content: [textBlock(longText)] },
      {
        type: 'tool_result',
        role: 'tool',
        callId: 'call_pair_b',
        toolName: 'exec_command',
        output: 'huge fact from tool result'
      },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const tree = buildMipTree(ir)
  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 80 })

  assert.equal(prepared.nodes[0].children.length, 1)
  assert.equal(prepared.nodes[0].children[0].meta.type, 'message')
  assert.equal(prepared.nodes[1].children[0].meta.type, 'tool_call')
})

test('generated summary handles survive tree serialization and openLink resolution', () => {
  const ir = importCodexJsonl(fixture)
  const tree = buildMipTree(ir)
  const prepared = prepareCompactedSummaryLayer(tree, { summaryInputTokenBudget: 1000 })
  assert.ok(prepared.nodes.length)
  prepared.nodes[0].breadcrumb = 'todo-sync'
  prepared.nodes[0].head = 'The compacted prefix covers the todo sync dry run.'

  const serializedRoot = JSON.parse(JSON.stringify(tree.root))
  const hydrated = hydrateMipTree({ ir, root: serializedRoot })
  const opened = openLink(
    hydrated,
    sessionLink({ sessionId: ir.session.id, handle: prepared.nodes[0].handle }),
    { budgetTokens: 200, summaryOnly: true }
  )

  assert.equal(opened.handle, prepared.nodes[0].handle)
  assert.equal(opened.mipLevel, 'heads')
  assert.match(opened.index, /^\d+\/\d+$/)
  assert.match(opened.zoom, /^\d+\/\d+$/)
  assert.equal(opened.childCount, prepared.nodes[0].children.length)
})

test('retrieval evaluation recovers a pre-compaction fact through MCP-shaped tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-retrieval-eval-'))
  const sessionId = 'retrieval-eval-session'
  const expected = 'ORCHID-7429'
  const collection = `session_indexer_retrieval_eval_${process.pid}_${Date.now()}`
  const ir = createSessionIR({
    source: { kind: 'test', path: path.join(root, 'retrieval-eval.jsonl') },
    session: { id: sessionId, agent: 'codex', title: 'Retrieval Eval Session' },
    events: [
      {
        type: 'message',
        role: 'user',
        content: [textBlock(`Record this exact deployment codename before compaction: ${expected}.`)]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [textBlock('Noted; the deployment codename has been recorded.')]
      },
      {
        type: 'compaction',
        title: 'compact boundary',
        content: [textBlock('provider compact marker')]
      },
      {
        type: 'message',
        role: 'user',
        content: [textBlock('The visible tail no longer repeats the deployment codename.')]
      }
    ]
  })
  await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'off',
    typesenseCollection: collection
  })

  const scriptedProvider = {
    async chat (messages) {
      const toolMessages = messages.filter(message => message.role === 'tool')
      if (!toolMessages.length) {
        return {
          output: [{
            type: 'function_call',
            call_id: 'call_search',
            name: 'conversation_search',
            arguments: JSON.stringify({
              session_id: sessionId,
              query: expected,
              limit: 5
            })
          }]
        }
      }
      if (toolMessages.length === 1) {
        const searchResult = JSON.parse(toolMessages[0].content)
        assert.equal(searchResult.agent, 'codex')
        const hit = searchResult.hits.find(item => item.isVerbatim) || searchResult.hits[0]
        assert.equal(hit.agent, 'codex')
        return {
          output: [{
            type: 'function_call',
            call_id: 'call_open',
            name: 'conversation_openLink',
            arguments: JSON.stringify({
              link: hit.link,
              budget_tokens: 2000
            })
          }]
        }
      }
      const opened = JSON.parse(toolMessages[1].content)
      assert.equal(opened.agent, 'codex')
      assert.equal(opened.isVerbatim, true)
      assert.equal(opened.omittedTokenCount || 0, 0)
      assert.match(opened.content, new RegExp(expected))
      return {
        output_text: `The deployment codename was ${expected}.`
      }
    }
  }

  const result = await runRetrievalEvaluation({
    provider: scriptedProvider,
    observerName: 'openai-responses',
    model: 'scripted-retrieval-eval',
    question: 'What was the exact deployment codename from before the compaction?',
    expectedAnswer: expected,
    context: {
      indexDir: root,
      sessionId,
      agent: 'codex',
      typesenseCollection: collection
    }
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.checks, {
    expectedAnswerInFinal: true,
    searchCalled: true,
    openLinkCalled: true,
    openedVerbatimEvidence: true,
    toolErrorCount: 0
  })
  assert.match(result.finalAnswer, new RegExp(expected))
  assert.ok(result.trace.some(item => item.type === 'tool' && item.name === 'conversation_search'))
  assert.ok(result.trace.some(item => item.type === 'tool' && item.name === 'conversation_openLink'))
  assert.equal(result.trace.some(item => item.name === 'start_indexing_session'), false)
})

test('retrieval evaluation reports tool errors in the trace instead of throwing', async () => {
  const scriptedProvider = {
    async chat (messages) {
      const toolMessages = messages.filter(message => message.role === 'tool')
      if (!toolMessages.length) {
        return {
          output: [{
            type: 'function_call',
            call_id: 'call_missing',
            name: 'conversation_missing',
            arguments: '{}'
          }]
        }
      }
      return { output_text: 'I could not retrieve the requested fact.' }
    }
  }

  const result = await runRetrievalEvaluation({
    provider: scriptedProvider,
    observerName: 'openai-responses',
    model: 'scripted-retrieval-error',
    question: 'What was the pre-compaction fact?',
    expectedAnswer: 'ORCHID-7429',
    context: {
      indexDir: fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-retrieval-tool-error-')),
      sessionId: 'missing-session',
      agent: 'codex'
    }
  })

  assert.equal(result.passed, false)
  assert.equal(result.checks.toolErrorCount, 1)
  assert.match(result.trace.find(item => item.type === 'tool').result.error, /unsupported retrieval evaluation tool/)
})

test('summary budget guard asks before a target that cannot fit', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-summary-budget-codex-home-'))
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-06-05T00:00:00.000Z',
    client_version: 'test',
    models: [{ id: 'gpt-5.4-mini' }]
  }))
  const pricingCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-summary-budget-pricing-'))
  fs.writeFileSync(path.join(pricingCacheDir, 'models-dev-api.json'), JSON.stringify({
    openai: {
      name: 'OpenAI',
      models: {
        'gpt-5.4-mini': {
          id: 'gpt-5.4-mini',
          name: 'GPT-5.4 mini',
          cost: { input: 0, output: 1 }
        }
      }
    }
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: 'summary-budget.jsonl' },
    session: { id: 'summary-budget', agent: 'codex', title: 'Summary budget' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('first compacted budget child')] },
      { type: 'message', role: 'user', content: [textBlock('second compacted budget child')] },
      { type: 'message', role: 'user', content: [textBlock('third compacted budget child')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const originalChat = OpenAICodexResponsesProvider.prototype.chat
  let callCount = 0
  OpenAICodexResponsesProvider.prototype.chat = async () => {
    callCount += 1
    return {
      output_text: JSON.stringify({
        breadcrumb: 'budget',
        summary: 'This should not be called.',
        topics: ['Budget guard should stop this call.']
      })
    }
  }

  try {
    const result = await summarizeTree(buildMipTree(ir), {
      summaryProvider: 'openai-codex-responses',
      summaryModel: 'gpt-5.4-mini',
      codexHome,
      pricingCacheDir,
      summaryInputTokenBudget: 1,
      summaryMaxOutputTokens: 64,
      summaryMaxBudgetUsd: '0.00001',
      maxSummaryNodes: 1,
      maxSummaryChildChars: 200,
      summaryConcurrency: 1
    })
    assert.equal(result.summary.status, 'suspended-budget')
    assert.equal(result.summary.summaryBudget.status, 'over_budget')
    assert.equal(callCount, 0)
  } finally {
    OpenAICodexResponsesProvider.prototype.chat = originalChat
  }
})

test('summary budget guard spends approved budget before asking for more', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-summary-budget-progress-codex-home-'))
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-06-05T00:00:00.000Z',
    client_version: 'test',
    models: [{ id: 'gpt-5.4-mini' }]
  }))
  const pricingCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-summary-budget-progress-pricing-'))
  fs.writeFileSync(path.join(pricingCacheDir, 'models-dev-api.json'), JSON.stringify({
    openai: {
      name: 'OpenAI',
      models: {
        'gpt-5.4-mini': {
          id: 'gpt-5.4-mini',
          name: 'GPT-5.4 mini',
          cost: { input: 0, output: 1 }
        }
      }
    }
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: 'summary-budget-progress.jsonl' },
    session: { id: 'summary-budget-progress', agent: 'codex', title: 'Summary budget progress' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('first affordable compacted budget child')] },
      { type: 'message', role: 'user', content: [textBlock('second unaffordable compacted budget child')] },
      { type: 'message', role: 'user', content: [textBlock('third unaffordable compacted budget child')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const originalChat = OpenAICodexResponsesProvider.prototype.chat
  let callCount = 0
  OpenAICodexResponsesProvider.prototype.chat = async () => {
    callCount += 1
    return {
      output_text: JSON.stringify({
        breadcrumb: 'budget',
        summary: 'One affordable target was summarized before asking for more budget.',
        topics: ['Affordable summary target progress before budget approval.']
      }),
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14
      }
    }
  }

  try {
    const result = await summarizeTree(buildMipTree(ir), {
      summaryProvider: 'openai-codex-responses',
      summaryModel: 'gpt-5.4-mini',
      codexHome,
      pricingCacheDir,
      summaryInputTokenBudget: 1,
      summaryMaxOutputTokens: 64,
      summaryMaxBudgetUsd: '0.00007',
      maxSummaryNodes: 3,
      maxSummaryChildChars: 200,
      summaryConcurrency: 3
    })
    assert.equal(callCount, 1)
    assert.equal(result.summary.status, 'suspended-budget')
    assert.equal(result.summary.completedJobCount, 1)
    assert.equal(result.summary.pendingJobCount > 0, true)
    assert.equal(result.summary.summaryBudget.status, 'budget_limited')
    assert.equal(result.summary.summaryBudget.selectedTargetCount, 1)
    assert.equal(result.summary.summaryBudget.pendingTargetCount > 1, true)
  } finally {
    OpenAICodexResponsesProvider.prototype.chat = originalChat
  }
})

test('summary model failures are recorded per target without aborting the queue', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-summary-failure-codex-home-'))
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-06-05T00:00:00.000Z',
    client_version: 'test',
    models: [{ id: 'gpt-5.4-mini' }]
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: 'summary-provider-failure.jsonl' },
    session: { id: 'summary-provider-failure', agent: 'codex', title: 'Summary provider failure' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('first compacted child')] },
      { type: 'message', role: 'assistant', content: [textBlock('second compacted child')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const originalChat = OpenAICodexResponsesProvider.prototype.chat
  let callCount = 0
  OpenAICodexResponsesProvider.prototype.chat = async () => {
    callCount += 1
    if (callCount === 1) throw new Error('transient provider outage')
    return {
      output_text: JSON.stringify({
        breadcrumb: 'second child',
        summary: 'The child discusses the second compacted message.',
        topics: ['Second compacted message summary.']
      }),
      usage: {
        input_tokens: 9,
        output_tokens: 5,
        total_tokens: 14
      }
    }
  }

  try {
    const result = await summarizeTree(buildMipTree(ir), {
      summaryProvider: 'openai-codex-responses',
      summaryModel: 'gpt-5.4-mini',
      codexHome,
      summaryMaxBudgetUsd: 'off',
      summaryInputTokenBudget: 1,
      maxSummaryNodes: 2,
      maxSummaryChildChars: 200,
      summaryConcurrency: 2
    })

    assert.equal(result.jobs.length, 2)
    assert.equal(result.summary.failedJobCount, 1)
    assert.equal(result.summary.completedJobCount, 1)
    assert.equal(result.jobs.filter(job => job.error).length, 1)
    assert.equal(result.jobs.filter(job => job.status === 'completed').length, 1)
    assert.match(result.jobs.find(job => job.error).error, /transient provider outage/)
  } finally {
    OpenAICodexResponsesProvider.prototype.chat = originalChat
  }
})

test('summary model 429s back off and report retry ETA progress', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-summary-429-codex-home-'))
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-06-05T00:00:00.000Z',
    client_version: 'test',
    models: [{ id: 'gpt-5.4-mini' }]
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: 'summary-provider-429.jsonl' },
    session: { id: 'summary-provider-429', agent: 'codex', title: 'Summary provider 429' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('compact this rate limited child')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const originalChat = OpenAICodexResponsesProvider.prototype.chat
  let callCount = 0
  OpenAICodexResponsesProvider.prototype.chat = async () => {
    callCount += 1
    if (callCount === 1) {
      const err = new Error('429 rate limit: try again in 0.001 seconds')
      err.status = 429
      err.retryAfterMs = 1
      throw err
    }
    return {
      output_text: JSON.stringify({
        breadcrumb: 'ratelimit',
        summary: 'The child covers a rate-limited summary retry.',
        topics: ['Rate-limited summary retry.']
      }),
      usage: {
        input_tokens: 4,
        output_tokens: 4,
        total_tokens: 8
      }
    }
  }
  const progress = []

  try {
    const result = await summarizeTree(buildMipTree(ir), {
      summaryProvider: 'openai-codex-responses',
      summaryModel: 'gpt-5.4-mini',
      codexHome,
      summaryMaxBudgetUsd: 'off',
      summaryRateLimitBackoffMs: 1,
      summaryRateLimitMaxBackoffMs: 1,
      summaryRateLimitMaxRetries: 2,
      maxSummaryNodes: 1,
      maxSummaryChildChars: 200,
      summaryConcurrency: 1,
      onProgress: event => progress.push(event)
    })

    assert.equal(callCount, 2)
    assert.equal(result.summary.failedJobCount, 0)
    assert.equal(result.summary.completedJobCount, 1)
    const started = progress.find(event => event.phase === 'summary:model:start')
    assert.ok(started)
    assert.equal(Object.hasOwn(started, 'estimatedRemainingMs'), false)
    assert.equal(Object.hasOwn(started, 'estimatedCompletionAt'), false)
    const rateLimited = progress.find(event => event.phase === 'summary:model:rate_limited')
    assert.ok(rateLimited)
    assert.equal(rateLimited.backoffMs, 1)
    assert.equal(rateLimited.attempt, 1)
    assert.equal(rateLimited.nextAttempt, 2)
    assert.match(rateLimited.retryAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(rateLimited.estimatedCompletionAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(Number.isFinite(rateLimited.estimatedRemainingMs), true)
  } finally {
    OpenAICodexResponsesProvider.prototype.chat = originalChat
  }
})

test('summary model empty responses retry before failing a target', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-summary-empty-codex-home-'))
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-06-05T00:00:00.000Z',
    client_version: 'test',
    models: [{ id: 'gpt-5.4-mini' }]
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: 'summary-provider-empty.jsonl' },
    session: { id: 'summary-provider-empty', agent: 'codex', title: 'Summary provider empty response' },
    events: [
      { type: 'message', role: 'user', content: [textBlock('compact this child after an empty model response')] },
      { type: 'compaction', title: 'compact boundary', content: [textBlock('provider compact marker')] }
    ]
  })
  const originalChat = OpenAICodexResponsesProvider.prototype.chat
  let callCount = 0
  OpenAICodexResponsesProvider.prototype.chat = async () => {
    callCount += 1
    if (callCount === 1) {
      return {
        output_text: '',
        usage: {
          input_tokens: 4,
          output_tokens: 0,
          total_tokens: 4
        }
      }
    }
    return {
      output_text: JSON.stringify({
        breadcrumb: 'empty retry',
        summary: 'The child was summarized after retrying an empty model response.',
        topics: ['Empty model response retry path.']
      }),
      usage: {
        input_tokens: 4,
        output_tokens: 4,
        total_tokens: 8
      }
    }
  }
  const progress = []

  try {
    const result = await summarizeTree(buildMipTree(ir), {
      summaryProvider: 'openai-codex-responses',
      summaryModel: 'gpt-5.4-mini',
      codexHome,
      summaryMaxBudgetUsd: 'off',
      summaryEmptyResponseBackoffMs: 1,
      summaryEmptyResponseMaxRetries: 2,
      maxSummaryNodes: 1,
      maxSummaryChildChars: 200,
      summaryConcurrency: 1,
      onProgress: event => progress.push(event)
    })

    assert.equal(callCount, 2)
    assert.equal(result.summary.failedJobCount, 0)
    assert.equal(result.summary.completedJobCount, 1)
    const retry = progress.find(event => event.phase === 'summary:model:retry')
    assert.ok(retry)
    assert.equal(retry.backoffMs, 1)
    assert.equal(retry.attempt, 1)
    assert.equal(retry.nextAttempt, 2)
    assert.match(retry.error, /empty response/)
  } finally {
    OpenAICodexResponsesProvider.prototype.chat = originalChat
  }
})

test('Claude Platform AWS batch requests use stable custom ids and message params', () => {
  const requests = makeBatchRequests({
    model: 'claude-haiku-4-5',
    maxTokens: 256,
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    jobs: [{
      customId: 'sum_test',
      prompt: 'summarize these children'
    }]
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].custom_id, 'sum_test')
  assert.equal(requests[0].params.model, 'claude-haiku-4-5')
  assert.equal(requests[0].params.max_tokens, 256)
  assert.equal(requests[0].params.messages[0].role, 'user')
  assert.equal(requests[0].params.messages[0].content, 'summarize these children')
  assert.equal(requests[0].params.system[0].text, SUMMARY_SYSTEM_PROMPT)
  assert.equal(requests[0].params.system[0].cache_control.type, 'ephemeral')
})

test('Claude batch results apply breadcrumbs, summaries, and topics to nodes', () => {
  const node = {
    head: '',
    breadcrumb: '',
    topics: [],
    summaryModel: '',
    summaryMeta: null
  }
  const jobs = [{
    customId: 'sum_node',
    childHash: 'abc123',
    node
  }]
  const applied = applyBatchResults({
    jobs,
    mode: 'model',
    resolved: {
      providerName: 'claude-platform-aws-batch',
      model: 'claude-haiku-4-5',
      modelSource: 'test'
    },
    results: [{
      custom_id: 'sum_node',
      result: {
        type: 'succeeded',
        message: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              breadcrumb: 'wasm proof',
              summary: 'The children discuss a Wasm proof sketch and evaluator constraints.',
              topics: ['Wasm proof and evaluator notes.']
            })
          }]
        }
      }
    }]
  })

  assert.equal(applied, 1)
  assert.equal(node.breadcrumb, 'wasm proof')
  assert.equal(node.head, 'The children discuss a Wasm proof sketch and evaluator constraints.')
  assert.deepEqual(node.topics, ['Wasm proof and evaluator notes.'])
  assert.equal(node.summaryModel, 'claude-haiku-4-5')
  assert.equal(node.summaryMeta.provider, 'claude-platform-aws-batch')
  assert.equal(jobs[0].outputChars, node.head.length)
})

test('Claude CLI provider uses lean print mode and parses JSON result output', async () => {
  let observed
  const provider = new ClaudeCliProvider({
    command: 'claude-test',
    model: 'haiku',
    runner: async request => {
      observed = request
      return {
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'summary text',
          usage: {
            input_tokens: 3,
            output_tokens: 4
          }
        }),
        stderr: ''
      }
    }
  })

  const response = await provider.chat([
    { role: 'system', content: 'summarize only the child records' },
    { role: 'user', content: 'child record text' }
  ])

  assert.equal(response.message.content, 'summary text')
  assert.equal(response.usage.input_tokens, 3)
  assert.equal(observed.command, 'claude-test')
  assert.deepEqual(observed.args.slice(0, 6), ['-p', '--bare', '--output-format', 'json', '--model', 'haiku'])
  assert.ok(observed.args.includes('--no-session-persistence'))
  assert.equal(observed.args[observed.args.indexOf('--tools') + 1], '')
  assert.equal(observed.args[observed.args.indexOf('--system-prompt') + 1], 'summarize only the child records')
  assert.equal(observed.input, 'USER:\nchild record text')
})

test('Claude CLI helpers expose budget guard and error results', () => {
  const args = buildClaudeCliArgs({
    model: 'haiku',
    systemPrompt: 'short system',
    maxBudgetUsd: '0.25'
  })
  assert.ok(args.includes('--no-session-persistence'))
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.25')

  assert.throws(() => parseClaudeCliResult(JSON.stringify({
    type: 'result',
    is_error: true,
    errors: ['budget exceeded']
  })), /budget exceeded/)
})

test('anthropic summary provider resolves to Claude CLI, not Bedrock', () => {
  const resolved = summaryProvider({
    summaryProvider: 'anthropic',
    summaryModel: 'haiku'
  })
  assert.equal(resolved.providerName, 'claude-cli')
  assert.equal(resolved.model, 'haiku')
})

test('Codex summary provider defaults to low reasoning effort', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-codex-home-'))
  fs.writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-06-05T00:00:00.000Z',
    client_version: 'test',
    models: [{ id: 'gpt-5.4-mini' }]
  }))

  const parsed = parseArgs(['index', '--summary-reasoning-effort', 'low'])
  assert.equal(parsed.summaryReasoningEffort, 'low')
  assert.equal(parsed.summaryMaxBudgetUsd, '5')
  assert.equal(parseArgs(['index', '--summary-concurrency', '4']).summaryConcurrency, 4)
  assert.equal(parseArgs(['index', '--summary-rate-limit-max-retries', '7']).summaryRateLimitMaxRetries, 7)
  assert.equal(parseArgs(['index', '--summary-rate-limit-backoff-ms', '10']).summaryRateLimitBackoffMs, 10)
  assert.equal(parseArgs(['index', '--summary-rate-limit-backoff-ms', '10', '--summary-rate-limit-max-backoff-ms', '20']).summaryRateLimitMaxBackoffMs, 20)
  assert.equal(parseArgs(['index', '--typesense-import-chunk-size', '1000']).typesenseImportChunkSize, 1000)
  assert.equal(parseArgs(['index', '--summary-max-budget-usd', 'off']).summaryMaxBudgetUsd, 'off')
  assert.throws(() => parseArgs(['index', '--summary-max-budget-usd', '-1']), /summary-max-budget-usd/)
  assert.throws(() => parseArgs(['index', '--summary-concurrency', '0']), /summary-concurrency/)
  assert.throws(() => parseArgs(['index', '--summary-rate-limit-max-retries', '-1']), /summary-rate-limit-max-retries/)
  assert.throws(() => parseArgs(['index', '--summary-rate-limit-backoff-ms', '0']), /summary-rate-limit-backoff-ms/)
  assert.throws(() => parseArgs(['index', '--summary-rate-limit-backoff-ms', '20', '--summary-rate-limit-max-backoff-ms', '10']), /summary-rate-limit-max-backoff-ms/)
  assert.throws(() => parseArgs(['index', '--typesense-import-chunk-size', '0']), /typesense-import-chunk-size/)
  const evalParsed = parseArgs(['eval_retrieval', '--question', 'what was the code?', '--expected-answer', 'ORCHID-7429', '--eval-max-turns', '3'])
  assert.equal(evalParsed.question, 'what was the code?')
  assert.equal(evalParsed.expectedAnswer, 'ORCHID-7429')
  assert.equal(evalParsed.evalMaxTurns, 3)
  assert.throws(() => parseArgs(['eval_retrieval', '--expected-answer', 'ORCHID-7429']), /requires --question/)

  const resolved = summaryProvider({
    summaryProvider: 'openai-codex-responses',
    summaryModel: 'gpt-5.4-mini',
    codexHome: root
  })
  assert.equal(resolved.providerName, 'openai-codex-responses')
  assert.equal(resolved.reasoningEffort, 'low')
  assert.deepEqual(resolved.callOptions.reasoning, { effort: 'low' })

  const disabled = summaryProvider({
    summaryProvider: 'openai-codex-responses',
    summaryModel: 'gpt-5.4-mini',
    summaryReasoningEffort: 'off',
    codexHome: root
  })
  assert.equal(disabled.reasoningEffort, '')
  assert.equal(disabled.callOptions.reasoning, undefined)
})

test('work queue caps concurrency and preserves result order', async () => {
  let active = 0
  let maxActive = 0
  const delays = [40, 5, 20, 0]
  const results = await runWorkQueue({
    items: delays,
    concurrency: 2,
    worker: async (_delay, index) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, delays[index]))
      active -= 1
      return `job-${index}`
    }
  })

  assert.deepEqual(results, ['job-0', 'job-1', 'job-2', 'job-3'])
  assert.equal(maxActive, 2)
  assert.equal(normalizeConcurrency('', 3), 3)
  assert.throws(() => normalizeConcurrency(0), /positive integer/)
})

test('Codex current-chat resolver matches session marker instead of mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-current-chat-'))
  const current = path.join(root, 'current.jsonl')
  const newer = path.join(root, 'newer.jsonl')
  const marker = 'conversation_history-session-11111111-1111-4111-8111-111111111111'
  writeJsonl(current, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'current-session' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'please index this chat' } },
    {
      timestamp: '2026-06-05T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_start',
        arguments: JSON.stringify({ cmd: `node bin/session-indexer.js start_indexing_session --this-chat --session-marker ${marker}` })
      }
    }
  ])
  writeJsonl(newer, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'newer-session' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'unrelated work' } },
    {
      timestamp: '2026-06-05T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_date',
        arguments: JSON.stringify({ cmd: 'date' })
      }
    }
  ])
  const oldTime = new Date(Date.now() - 60_000)
  const newTime = new Date()
  fs.utimesSync(current, oldTime, oldTime)
  fs.utimesSync(newer, newTime, newTime)

  const resolved = resolveCurrentCodexSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    limit: 1
  })
  assert.equal(resolved.file, current)
  assert.equal(resolved.reason, 'session_marker_match')
  assert.equal(resolved.signals.sessionMarkerMatch.marker, marker)
})

test('Codex current-chat resolver refuses missing or unrelated session markers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-current-chat-marker-'))
  const noMarkerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-current-chat-no-marker-'))
  const session = path.join(root, 'session.jsonl')
  const looseOverlap = path.join(root, 'loose-overlap.jsonl')
  const noMarkerSession = path.join(noMarkerRoot, 'session.jsonl')
  const marker = 'conversation_history-session-22222222-2222-4222-8222-222222222222'
  writeJsonl(session, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'marker-session' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'please index this chat' } },
    {
      timestamp: '2026-06-05T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_start',
        arguments: JSON.stringify({ cmd: `node bin/session-indexer.js start_indexing_session --this-chat --session-marker ${marker}` })
      }
    }
  ])
  writeJsonl(looseOverlap, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'loose-overlap-session' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'this is for unrelated resolver work only' } }
  ])
  writeJsonl(noMarkerSession, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'no-marker-session' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'please index this chat' } }
  ])

  assert.equal(resolveCurrentCodexSessionFile({
    root: noMarkerRoot,
    command: 'start_indexing_session'
  }), null)
  assert.equal(resolveCurrentCodexSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: 'conversation_history-session-33333333-3333-4333-8333-333333333333'
  }), null)

  await assert.rejects(
    () => runCommand(parseArgs(['inspect', '--source-root', noMarkerRoot, '--this-chat'])),
    /--this-chat requires --session-marker id/
  )
})

test('Codex current-chat resolver rejects duplicate session marker matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-current-chat-duplicate-marker-'))
  const one = path.join(root, 'one.jsonl')
  const two = path.join(root, 'two.jsonl')
  const marker = 'conversation_history-session-88888888-8888-4888-8888-888888888888'
  const markerCall = {
    type: 'function_call',
    name: 'exec_command',
    call_id: 'call_start',
    arguments: JSON.stringify({ cmd: `node bin/session-indexer.js start_indexing_session --this-chat --session-marker ${marker}` })
  }
  writeJsonl(one, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'one' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'response_item', payload: markerCall }
  ])
  writeJsonl(two, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'two' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'response_item', payload: markerCall }
  ])

  assert.throws(
    () => resolveCurrentCodexSessionFile({ root, command: 'start_indexing_session', sessionMarker: marker }),
    /session marker matched multiple Codex session files/
  )
})

test('Codex current-chat resolver chooses fork descendant for duplicate marker matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-current-chat-fork-marker-'))
  const parent = path.join(root, 'parent.jsonl')
  const child = path.join(root, 'child.jsonl')
  const marker = 'conversation_history-session-12121212-1212-4121-8121-121212121212'
  const markerCall = {
    type: 'function_call',
    name: 'exec_command',
    call_id: 'call_start',
    arguments: JSON.stringify({ cmd: `node bin/session-indexer.js start_indexing_session --this-chat --session-marker ${marker}` })
  }
  writeJsonl(parent, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'parent-thread' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'response_item', payload: markerCall }
  ])
  writeJsonl(child, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'child-thread' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'response_item', payload: markerCall },
    { timestamp: '2026-06-05T00:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'fork continuation' } }
  ])

  const resolved = resolveCurrentCodexSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    threadSpawnEdges: [{
      parentThreadId: 'parent-thread',
      childThreadId: 'child-thread'
    }]
  })
  assert.equal(resolved.file, child)
  assert.equal(resolved.reason, 'session_marker_match_fork_descendant')
  assert.equal(resolved.signals.forkResolution.selectedThreadId, 'child-thread')
})

test('Codex current-chat resolver scans the recent-file window first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-current-chat-window-'))
  const marker = 'conversation_history-session-44444444-4444-4444-8444-444444444444'
  const older = path.join(root, 'older.jsonl')
  const newer = path.join(root, 'newer.jsonl')
  writeJsonl(older, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: marker } }
  ])
  writeJsonl(newer, [
    { timestamp: '2026-06-06T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'newer unrelated session' } }
  ])
  fs.utimesSync(older, new Date('2026-06-05T00:00:00.000Z'), new Date('2026-06-05T00:00:00.000Z'))
  fs.utimesSync(newer, new Date('2026-06-06T00:00:00.000Z'), new Date('2026-06-06T00:00:00.000Z'))

  assert.equal(resolveCurrentCodexSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    sessionMarkerScanLimit: 1
  }), null)
  assert.equal(resolveCurrentCodexSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    sessionMarkerScanLimit: 2
  }).file, older)
})

test('Claude current-chat resolver matches session marker instead of mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-current-chat-'))
  const current = path.join(root, 'current.jsonl')
  const newer = path.join(root, 'newer.jsonl')
  const marker = 'conversation_history-session-55555555-5555-4555-8555-555555555555'
  writeJsonl(current, [
    { type: 'user', timestamp: '2026-06-05T00:00:01.000Z', message: { role: 'user', content: 'please index this chat' } },
    {
      type: 'assistant',
      timestamp: '2026-06-05T00:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'start_indexing_session', input: { session_marker: marker } }] }
    }
  ])
  writeJsonl(newer, [
    { type: 'user', timestamp: '2026-06-05T00:00:01.000Z', message: { role: 'user', content: 'unrelated work in another live session' } }
  ])
  const oldTime = new Date(Date.now() - 60_000)
  const newTime = new Date()
  fs.utimesSync(current, oldTime, oldTime)
  fs.utimesSync(newer, newTime, newTime)

  const resolved = resolveCurrentClaudeSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    limit: 1
  })
  assert.equal(resolved.file, current)
  assert.equal(resolved.reason, 'session_marker_match')
  assert.equal(resolved.signals.sessionMarkerMatch.marker, marker)
})

test('Claude current-chat resolver requires exact session marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-current-chat-marker-'))
  const session = path.join(root, 'session.jsonl')
  const unrelated = path.join(root, 'unrelated.jsonl')
  const marker = 'conversation_history-session-66666666-6666-4666-8666-666666666666'
  writeJsonl(session, [
    { type: 'user', timestamp: '2026-06-05T00:00:01.000Z', message: { role: 'user', content: 'please index this chat' } }
  ])
  writeJsonl(unrelated, [
    { type: 'user', timestamp: '2026-06-05T00:00:01.000Z', message: { role: 'user', content: 'completely unrelated phrase here' } },
    { type: 'assistant', timestamp: '2026-06-05T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'start_indexing_session', input: { session_marker: marker } }] } }
  ])

  assert.equal(resolveCurrentClaudeSessionFile({ root, command: 'start_indexing_session' }), null)
  assert.equal(resolveCurrentClaudeSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: 'conversation_history-session-77777777-7777-4777-8777-777777777777'
  }), null)
  assert.equal(resolveCurrentClaudeSessionFile({ root, command: 'start_indexing_session', sessionMarker: marker }).file, unrelated)
})

test('Claude current-chat resolver rejects duplicate session marker matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-current-chat-duplicate-marker-'))
  const one = path.join(root, 'one.jsonl')
  const two = path.join(root, 'two.jsonl')
  const marker = 'conversation_history-session-99999999-9999-4999-8999-999999999999'
  const row = {
    type: 'assistant',
    timestamp: '2026-06-05T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'start_indexing_session', input: { session_marker: marker } }]
    }
  }
  writeJsonl(one, [{ type: 'user', timestamp: '2026-06-05T00:00:00.000Z', message: { role: 'user', content: 'one' } }, row])
  writeJsonl(two, [{ type: 'user', timestamp: '2026-06-05T00:00:00.000Z', message: { role: 'user', content: 'two' } }, row])

  assert.throws(
    () => resolveCurrentClaudeSessionFile({ root, command: 'start_indexing_session', sessionMarker: marker }),
    /session marker matched multiple Claude session files/
  )
})

test('Claude current-chat resolver scans the recent-file window first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-current-chat-window-'))
  const marker = 'conversation_history-session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const older = path.join(root, 'older.jsonl')
  const newer = path.join(root, 'newer.jsonl')
  writeJsonl(older, [
    { type: 'user', timestamp: '2026-06-05T00:00:00.000Z', message: { role: 'user', content: marker } }
  ])
  writeJsonl(newer, [
    { type: 'user', timestamp: '2026-06-06T00:00:00.000Z', message: { role: 'user', content: 'newer unrelated session' } }
  ])
  fs.utimesSync(older, new Date('2026-06-05T00:00:00.000Z'), new Date('2026-06-05T00:00:00.000Z'))
  fs.utimesSync(newer, new Date('2026-06-06T00:00:00.000Z'), new Date('2026-06-06T00:00:00.000Z'))

  assert.equal(resolveCurrentClaudeSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    sessionMarkerScanLimit: 1
  }), null)
  assert.equal(resolveCurrentClaudeSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    sessionMarkerScanLimit: 2
  }).file, older)
})

test('Codex current-chat resolver finds markers before large tool-output tails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-current-chat-large-tail-'))
  const session = path.join(root, 'session.jsonl')
  const marker = 'conversation_history-session-44444444-4444-4444-8444-444444444444'
  writeJsonl(session, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'large-tail-session' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: marker } },
    {
      timestamp: '2026-06-05T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_large',
        output: 'x'.repeat(700 * 1024)
      }
    }
  ])

  const resolved = resolveCurrentCodexSessionFile({
    root,
    command: 'start_indexing_session',
    sessionMarker: marker,
    sessionMarkerScanBytes: 128
  })
  assert.equal(resolved.file, session)
  assert.equal(resolved.signals.sessionMarkerMatch.scan, 'full')
})

test('start indexing waits for a generated session marker to land in the Codex log', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-pending-marker-source-'))
  const indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-pending-marker-index-'))
  const session = path.join(sourceRoot, 'session.jsonl')
  const marker = 'conversation_history-session-55555555-5555-4555-8555-555555555555'
  writeJsonl(session, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'pending-marker-session' } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'please index this chat' } }
  ])

  const started = await runCommand(parseArgs([
    'start_indexing_session',
    '--source-root', sourceRoot,
    '--index-dir', indexRoot,
    '--summary-mode', 'off',
    '--this-chat',
    '--session-marker', marker,
    '--wait-for-session-marker',
    '--timeout-ms', '1000',
    '--poll-ms', '25'
  ]))

  try {
    assert.equal(started.schema, 'session-indexer.start_indexing_session.v1')
    assert.equal(started.sessionMarker, marker)
    assert.equal(started.job.waitForSessionMarker, true)
    assert.equal(started.job.progress.phase, 'waiting_for_session_marker')

    fs.appendFileSync(session, `${JSON.stringify({
      timestamp: '2026-06-05T00:00:02.000Z',
      type: 'function_call_output',
      payload: {
        call_id: 'call_marker',
        output: JSON.stringify({ sessionMarker: marker })
      }
    })}\n`)

    const ready = await waitForJob({
      root: indexRoot,
      jobId: started.job.jobId,
      timeoutMs: 30000,
      pollMs: 50
    })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.sessions.length, 1)
    assert.equal(ready.progress.phase, 'watching')
  } finally {
    await stopIndexingJobs({
      root: indexRoot,
      scope: 'all',
      timeoutMs: 5000,
      pollMs: 25
    })
  }
})

test('index worker suspends and exits when the next summary target exceeds approved budget', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-budget-worker-source-'))
  const indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-budget-worker-index-'))
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-budget-worker-codex-home-'))
  const pricingCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-budget-worker-pricing-'))
  const session = path.join(sourceRoot, 'budget-worker.jsonl')
  fs.copyFileSync(fixture, session)
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-06-05T00:00:00.000Z',
    client_version: 'test',
    models: [{ id: 'gpt-5.4-mini' }]
  }))
  fs.writeFileSync(path.join(pricingCacheDir, 'models-dev-api.json'), JSON.stringify({
    openai: {
      name: 'OpenAI',
      models: {
        'gpt-5.4-mini': {
          id: 'gpt-5.4-mini',
          name: 'GPT-5.4 mini',
          cost: { input: 0, output: 1 }
        }
      }
    }
  }))

  const started = await runCommand(parseArgs([
    'start_indexing_session',
    '--source', 'codex',
    '--session', session,
    '--index-dir', indexRoot,
    '--summary-mode', 'model',
    '--summary-provider', 'openai-codex-responses',
    '--summary-model', 'gpt-5.4-mini',
    '--summary-max-budget-usd', '0.00001',
    '--summary-input-token-budget', '1',
    '--summary-max-output-tokens', '64',
    '--codex-home', codexHome,
    '--pricing-cache-dir', pricingCacheDir,
    '--timeout-ms', '30000',
    '--poll-ms', '50'
  ]))

  try {
    assert.equal(started.job.status, 'suspended')
    assert.equal(started.job.suspendedReason, 'summary_budget')
    assert.match(started.job.message, /summary budget approval required/)
    assert.equal(started.job.progress.suspended, true)
    assert.equal(started.job.progress.reason, 'summary_budget')
    assert.equal(started.job.summaryBudget.status, 'over_budget')
    assert.equal(started.job.summaryBudget.maxBudgetUsd, 0.00001)
    assert.ok(started.job.summaryBudget.neededBudgetUsd > started.job.summaryBudget.maxBudgetUsd)
    assert.equal(started.job.summaryBudget.total_cost_usd, started.job.summaryBudget.neededBudgetUsd)
    assert.equal(Object.hasOwn(started.job.summaryBudget, 'pricing'), false)
    assert.equal(Object.hasOwn(started.job.suspension.summaryBudget, 'pricing'), false)
    assert.ok(started.job.summaryBudget.breakdown.output.tokens > 0)
    assert.match(started.job.suspension.requiredAction, /Ask the user to approve/)
    assert.equal(started.job.suspension.approval.status, 'required')
    assert.ok(Math.abs(started.job.suspension.approval.estimatedCostUsd - started.job.summaryBudget.neededBudgetUsd) < 1e-12)
    assert.ok(started.job.suspension.approval.amountUsd >= started.job.summaryBudget.neededBudgetUsd)
    assert.ok(Number(started.job.suspension.approval.resumeArgs.summary_max_budget_usd) >= started.job.summaryBudget.neededBudgetUsd)
    assert.equal(started.job.suspension.approval.amountUsd, Number(started.job.suspension.approval.resumeArgs.summary_max_budget_usd))
    assert.equal(started.job.progress.approval.amountUsd, started.job.suspension.approval.amountUsd)
    const deadline = Date.now() + 5000
    while (isPidRunning(started.job.pid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(isPidRunning(started.job.pid), false)
  } finally {
    await stopIndexingJobs({
      root: indexRoot,
      scope: 'all',
      timeoutMs: 5000,
      pollMs: 25
    })
  }
})

test('index status reports operational indexing state without indexing on demand', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-status-'))
  const sessionFile = path.join(root, 'codex-mini.jsonl')
  fs.copyFileSync(fixture, sessionFile)
  const ir = importCodexJsonl(sessionFile)
  writeSessionIndex({ root, ir })
  const statusManifestFile = path.join(root, 'manifest.json')
  const statusManifest = JSON.parse(fs.readFileSync(statusManifestFile, 'utf8'))
  statusManifest.sessions['mini-session'].summaryIndex = {
    ...(statusManifest.sessions['mini-session'].summaryIndex || {}),
    model: 'gpt-status-summary',
    usage: {
      input: 11,
      output: 2,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      total: 13
    },
    usageBasis: 'provider_usage'
  }
  statusManifest.sessions['mini-session'].indexingStats = {
    ...(statusManifest.sessions['mini-session'].indexingStats || {}),
    summaryUsage: {
      input: 11,
      output: 2,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      total: 13
    },
    summaryUsageBasis: 'provider_usage'
  }
  fs.writeFileSync(statusManifestFile, JSON.stringify(statusManifest, null, 2))
  const secondFile = path.join(root, 'second-session.jsonl')
  writeJsonl(secondFile, [{ type: 'message', role: 'user', content: 'second status page' }])
  writeSessionIndex({
    root,
    ir: createSessionIR({
      source: { kind: 'test', path: secondFile },
      session: { id: 'second-session', agent: 'codex', title: 'Second session' },
      events: [{
        type: 'message',
        role: 'user',
        content: [textBlock('second status page')]
      }]
    })
  })
  const typesenseDataDir = path.join(root, 'typesense', 'runtime', 'data')
  fs.mkdirSync(typesenseDataDir, { recursive: true })
  fs.writeFileSync(path.join(typesenseDataDir, 'resource-probe.bin'), Buffer.alloc(1024))
  fs.writeFileSync(path.join(root, 'typesense', 'runtime', 'typesense.pid'), `${process.pid}\n`)

  const firstPage = indexStatus({ root, startAt: 0, limit: 1 })
  const secondPage = indexStatus({ root, startAt: 1, limit: 1 })
  assert.equal(firstPage.startAt, 0)
  assert.equal(firstPage.limit, 1)
  assert.equal(firstPage.sessions.length, 1)
  assert.equal(secondPage.sessions.length, 1)
  assert.notEqual(firstPage.sessions[0].sessionId, secondPage.sessions[0].sessionId)
  assert.ok(firstPage.resourceUsage.disk.sessions.bytes > 0)
  assert.ok(firstPage.resourceUsage.disk.typesenseData.bytes >= 1024)
  assert.equal(firstPage.resourceUsage.typesense.pid, process.pid)
  if (firstPage.resourceUsage.typesense.resourceUsage) {
    assert.equal(firstPage.resourceUsage.typesense.resourceUsage.pid, process.pid)
    assert.ok(firstPage.resourceUsage.typesense.resourceUsage.rssBytes > 0)
  }

  const notStarted = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(notStarted.sessions[0].state, 'not-started')
  assert.equal(Object.hasOwn(notStarted.sessions[0], 'upToDate'), false)
  assert.equal(Object.hasOwn(notStarted.sessions[0], 'staleByMs'), false)
  assert.equal(Object.hasOwn(notStarted.sessions[0], 'sourceUpdatedAt'), false)
  assert.equal(Object.hasOwn(notStarted.sessions[0], 'sourceUpdatedAgo'), false)
  assert.equal(Object.hasOwn(notStarted.sessions[0].indexingStats, 'summaryUsageBasis'), false)
  assert.equal(notStarted.sessions[0].indexingStats.summaryUsage.model, 'gpt-status-summary')
  assert.match(notStarted.sessions[0].indexedAgo, /just now|s ago/)

  const indexedAt = Date.parse(statusManifest.sessions['mini-session'].indexedAt)
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'jobs', 'old-error-before-publish.json'), `${JSON.stringify({
    schema: 'session-indexer.indexing-job.v1',
    jobId: 'old-error-before-publish',
    scope: 'this_session_only',
    source: 'codex',
    sessions: [sessionFile],
    status: 'error',
    error: 'old publish failure',
    progress: { phase: 'error' },
    updatedAt: new Date(indexedAt - 1000).toISOString()
  }, null, 2)}\n`)
  const ignoresOldError = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(ignoresOldError.sessions[0].state, 'not-started')
  assert.equal(Object.hasOwn(ignoresOldError.sessions[0], 'errorMessage'), false)

  writeJobState({
    root,
    state: {
      jobId: 'index-test-ready',
      scope: 'this_session_only',
      source: 'codex',
      sessions: [sessionFile],
      pid: process.pid,
      status: 'ready',
      progress: { phase: 'watching' },
      result: {
        sessions: [{
          sessionId: 'mini-session',
          summaryIndex: {
            compactionLog: [{ targetCount: 999 }]
          }
        }]
      }
    }
  })
  const ready = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(ready.sessions[0].state, 'ready')
  assert.equal(ready.sessions[0].indexingJob.status, 'ready')
  if (ready.sessions[0].indexingJob.resourceUsage) {
    assert.equal(ready.sessions[0].indexingJob.resourceUsage.pid, process.pid)
    assert.ok(ready.sessions[0].indexingJob.resourceUsage.rssBytes > 0)
  }
  assert.equal(Object.hasOwn(ready.sessions[0].indexingJob, 'result'), false)
  assert.equal(Object.hasOwn(ready.sessions[0].indexingJob, 'running'), false)

  writeJobState({
    root,
    state: {
      jobId: 'index-test-budget-suspended',
      scope: 'this_session_only',
      source: 'codex',
      sessions: [sessionFile],
      status: 'suspended',
      suspendedReason: 'summary_budget',
      message: 'summary budget approval required: approve estimated spend $2.5000 for 3 target(s)',
      summaryBudget: {
        status: 'over_budget',
        maxBudgetUsd: 1,
        neededBudgetUsd: 2.5,
        additionalBudgetUsd: 1.5,
        targetCount: 3,
        pricing: {
          provider: 'openai',
          model_id: 'gpt-verbose',
          cost: {
            input: 1,
            output: 2
          },
          rawCost: {
            input: 1,
            output: 2,
            internal: 'do not expose this in status'
          },
          modalities: {
            input: ['text'],
            output: ['text']
          }
        },
        breakdown: {
          input: {
            tokens: 1000,
            rate_per_million_usd: 1,
            cost_usd: 0.001
          },
          output: {
            tokens: 500,
            rate_per_million_usd: 2,
            cost_usd: 0.001
          },
          reasoning: {
            tokens: 0,
            rate_per_million_usd: 0,
            cost_usd: 0
          }
        }
      },
      suspension: {
        reason: 'summary_budget',
        phase: 'summary:budget_suspended',
        message: 'summary budget approval required: approve estimated spend $2.5000 for 3 target(s)',
        summaryBudget: {
          status: 'over_budget',
          maxBudgetUsd: 1,
          neededBudgetUsd: 2.5,
          additionalBudgetUsd: 1.5,
          targetCount: 3,
          pricing: {
            provider: 'openai',
            model_id: 'gpt-verbose',
            cost: {
              input: 1,
              output: 2
            },
            rawCost: {
              internal: 'do not expose this in status'
            }
          }
        },
        approval: {
          type: 'summary_budget',
          status: 'required',
          amountUsd: 2.5,
          currentCapUsd: 1,
          additionalUsd: 1.5,
          targetCount: 3,
          estimatedCostUsd: 2.5,
          prompt: 'Approve conversation_history remaining summarization spend up to $2.50 for 3 target(s)?',
          resumeArgs: {
            summary_max_budget_usd: '2.50'
          },
          cliFlag: '--summary-max-budget-usd 2.50'
        },
        requiredAction: 'Ask the user to approve conversation_history remaining summarization spend up to $2.50 for 3 target(s). After approval, resume with summary_max_budget_usd=2.50.'
      },
      progress: {
        phase: 'summary:budget_suspended',
        suspended: true,
        reason: 'summary_budget',
        summaryBudget: {
          status: 'over_budget',
          neededBudgetUsd: 2.5,
          pricing: {
            rawCost: {
              internal: 'do not expose this in status'
            }
          }
        },
        approval: {
          type: 'summary_budget',
          status: 'required',
          amountUsd: 2.5
        }
      }
    }
  })
  const budgetSuspended = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(budgetSuspended.sessions[0].state, 'suspended-budget')
  assert.match(budgetSuspended.sessions[0].statusMessage, /summary budget approval required/)
  assert.equal(budgetSuspended.sessions[0].suspension.summaryBudget.neededBudgetUsd, 2.5)
  assert.equal(budgetSuspended.sessions[0].suspension.approval.amountUsd, 2.5)
  assert.match(budgetSuspended.sessions[0].suspension.requiredAction, /Ask the user to approve/)
  assert.equal(Object.hasOwn(budgetSuspended.sessions[0].suspension.summaryBudget, 'pricing'), false)
  assert.equal(budgetSuspended.sessions[0].indexingJob.status, 'suspended')
  assert.equal(budgetSuspended.sessions[0].indexingJob.summaryBudget.additionalBudgetUsd, 1.5)
  assert.equal(Object.hasOwn(budgetSuspended.sessions[0].indexingJob.summaryBudget, 'pricing'), false)
  assert.equal(Object.hasOwn(budgetSuspended.sessions[0].indexingJob.progress.summaryBudget, 'pricing'), false)
  assert.equal(budgetSuspended.sessions[0].indexingJob.progress.approval.amountUsd, 2.5)
  assert.equal(budgetSuspended.sessions[0].indexingJob.summaryBudget.breakdown.input.cost_usd, 0.001)

  writeJobState({
    root,
    state: {
      jobId: 'index-test-ready-during-reindex',
      scope: 'this_session_only',
      source: 'codex',
      sessions: [sessionFile],
      pid: process.pid,
      status: 'indexing',
      ready: false,
      progress: { phase: 'indexing' }
    }
  })
  const readyDuringReindex = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(readyDuringReindex.sessions[0].state, 'indexing-in-progress')
  assert.equal(readyDuringReindex.sessions[0].indexingJob.status, 'indexing')

  writeJobState({
    root,
    state: {
      jobId: 'index-test-not-ready',
      scope: 'this_session_only',
      source: 'codex',
      sessions: [sessionFile],
      pid: process.pid,
      status: 'ready',
      ready: false,
      progress: { phase: 'summarizing', pendingTargetCount: 1 }
    }
  })
  const notActuallyReady = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(notActuallyReady.sessions[0].state, 'indexing-in-progress')
  assert.equal(notActuallyReady.sessions[0].indexingJob.status, 'indexing')
  assert.equal(Object.hasOwn(notActuallyReady.sessions[0].indexingJob, 'maxSummaryNodes'), false)

  const future = new Date(Date.now() + 10_000)
  fs.utimesSync(sessionFile, future, future)
  writeJobState({
    root,
    state: {
      jobId: 'index-test-not-ready',
      scope: 'this_session_only',
      source: 'codex',
      sessions: [sessionFile],
      pid: process.pid,
      status: 'ready',
      ready: true,
      progress: { phase: 'watching' }
    }
  })
  const afterLiveAppend = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(afterLiveAppend.sessions[0].state, 'ready')
  assert.equal(Object.hasOwn(afterLiveAppend.sessions[0], 'upToDate'), false)
  assert.equal(Object.hasOwn(afterLiveAppend.sessions[0], 'sourceUpdatedAt'), false)
  assert.equal(Object.hasOwn(afterLiveAppend.sessions[0], 'sourceUpdatedAgo'), false)

  writeJobState({
    root,
    state: {
      jobId: 'index-test-error',
      scope: 'this_session_only',
      source: 'codex',
      sessions: [sessionFile],
      status: 'error',
      error: 'synthetic indexing failure',
      progress: { phase: 'error' }
    }
  })
  const failed = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(failed.sessions[0].state, 'error')
  assert.equal(failed.sessions[0].errorMessage, 'synthetic indexing failure')

  const compact = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(Object.hasOwn(compact.sessions[0], 'compactions'), false)

  const missing = indexStatus({ root, sessionId: 'not-there' })
  assert.deepEqual(missing.sessions, [])
})

test('index worker coalesces live transcript changes and publishes when a compaction boundary lands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-live-worker-'))
  const sessionFile = path.join(root, 'live-growth-session.jsonl')
  const typesenseCollection = `session_indexer_live_${process.pid}_${Date.now()}`
  const sessionId = 'live-growth-session'
  writeJsonl(sessionFile, [
    {
      timestamp: '2026-06-05T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: '/tmp/live-growth',
        model_provider: 'openai',
        cli_version: 'test',
        dynamic_tools: [{ name: 'exec_command' }]
      }
    },
    {
      timestamp: '2026-06-05T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        client_id: 'initial-user',
        message: 'Initial live worker transcript.'
      }
    }
  ])

  const started = await runCommand(parseArgs([
    'start_indexing_session',
    '--source', 'codex',
    '--session', sessionFile,
    '--index-dir', root,
    '--summary-mode', 'off',
    '--typesense-collection', typesenseCollection,
    '--debounce-ms', '100',
    '--timeout-ms', '30000',
    '--poll-ms', '50'
  ]))

  try {
    assert.equal(started.job.status, 'ready')
    assert.equal(isPidRunning(started.job.pid), true)
    const initialStatus = indexStatus({ root, sessionId })
    assert.equal(initialStatus.sessions[0].state, 'ready')
    assert.equal(initialStatus.sessions[0].indexingJob.status, 'ready')
    assert.ok(initialStatus.sessions[0].indexingJob.resourceUsage.rssBytes > 0)
    assert.notEqual(initialStatus.sessions[0].indexingJob.resourceUsage.cpuPercent, null)

    await sleepMs(300)
    appendJsonl(sessionFile, [
      {
        timestamp: '2026-06-05T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'growth-user-1',
          message: 'Remember live growth sentinel GROWTH-CODE-418 before compaction.'
        }
      },
      {
        timestamp: '2026-06-05T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Acknowledged GROWTH-CODE-418.'
        }
      },
      {
        timestamp: '2026-06-05T00:00:04.000Z',
        type: 'compacted',
        payload: {
          message: 'Compacted live growth prefix.',
          replacement_history: [{ role: 'user', content: 'summary' }]
        }
      }
    ])

    const search = await waitUntil(async () => {
      const result = await searchIndexWithBackend({
        root,
        query: 'GROWTH-CODE-418',
        sessionId,
        agent: 'codex',
        typesenseCollection,
        limit: 5
      })
      return result.hits.length ? result : null
    }, {
      timeoutMs: 10000,
      pollMs: 250,
      label: 'compaction-triggered live worker reindex'
    })
    assert.ok(search.hits.some(hit => hit.agent === 'codex' && /live-growth-session/.test(hit.link || '')))

    const status = await waitUntil(async () => {
      const current = indexStatus({ root, sessionId })
      const session = current.sessions[0]
      return session && session.state === 'ready' && session.eventCount >= 5 ? current : null
    }, {
      timeoutMs: 5000,
      pollMs: 100,
      label: 'live worker ready state after compaction import'
    })
    assert.equal(status.sessions[0].state, 'ready')
    assert.ok(status.sessions[0].eventCount >= 5)
    assert.ok(status.resourceUsage.disk.jobs.bytes > 0)
    assert.ok(status.resourceUsage.disk.typesenseData.bytes > 0)

    const progress = readProgressEvents(started.job.log.stdout)
    const imports = progress.filter(event => event.phase === 'import:start' && event.file === sessionFile)
    assert.equal(imports.length, 2)
    assert.ok(progress.some(event => event.phase === 'index:documents:import:chunk' && event.sessionId === sessionId))
  } finally {
    await runCommand(parseArgs([
      'stop_indexing_session',
      '--source', 'codex',
      '--session', sessionFile,
      '--index-dir', root,
      '--timeout-ms', '10000',
      '--poll-ms', '50'
    ]))
  }
})

test('Typesense upserts are batched and status reports managed disk usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-batched-upsert-'))
  const typesenseCollection = `session_indexer_batch_${process.pid}_${Date.now()}`
  const sessionId = 'batched-upsert-session'
  const events = Array.from({ length: 17 }, (_item, index) => ({
    type: 'message',
    role: index % 2 ? 'assistant' : 'user',
    content: [textBlock(`batched upsert record ${index} BATCHED-UPsert-NEEDLE`)]
  }))
  const ir = createSessionIR({
    source: { kind: 'test', path: path.join(root, 'batched-upsert.jsonl') },
    session: { id: sessionId, agent: 'codex', title: 'Batched upsert' },
    events
  })
  const progress = []
  const indexed = await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'off',
    typesenseCollection,
    typesenseImportChunkSize: 5,
    onProgress: event => progress.push(event)
  })

  const start = progress.find(event => event.phase === 'index:documents:import:start')
  const chunks = progress.filter(event => event.phase === 'index:documents:import:chunk')
  assert.equal(start.chunkSize, 5)
  assert.equal(start.chunkCount, Math.ceil(indexed.docCount / 5))
  assert.equal(chunks.length, start.chunkCount)
  assert.ok(chunks.every(event => event.chunkSize <= 5))
  assert.equal(chunks[chunks.length - 1].imported, indexed.docCount)
  assert.ok(progress.some(event => event.phase === 'index:documents:upsert:preserve-existing'))

  const status = indexStatus({ root, sessionId })
  assert.equal(status.sessions[0].state, 'not-started')
  assert.ok(status.resourceUsage.disk.typesenseData.bytes > 0)
  assert.ok(status.resourceUsage.typesense.pid > 0)
  if (status.resourceUsage.typesense.resourceUsage) {
    assert.ok(status.resourceUsage.typesense.resourceUsage.rssBytes > 0)
    assert.notEqual(status.resourceUsage.typesense.resourceUsage.cpuPercent, null)
  }
})

test('shared Typesense collection isolates sessions by agent and session id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-shared-agents-'))
  const typesenseCollection = `session_indexer_shared_${process.pid}_${Date.now()}`
  const makeIR = ({ sessionId, agent, title, needle }) => createSessionIR({
    source: { kind: 'test', path: path.join(root, `${sessionId}.jsonl`) },
    session: { id: sessionId, agent, title },
    events: [{
      type: 'message',
      role: 'user',
      content: [textBlock(`shared collection sentinel ${needle}`)]
    }]
  })
  const sessions = [
    { sessionId: 'shared-codex-session', agent: 'codex', title: 'Shared Codex', needle: 'CODEX-ONLY-711' },
    { sessionId: 'shared-claude-session', agent: 'claude', title: 'Shared Claude', needle: 'CLAUDE-ONLY-812' },
    { sessionId: 'shared-antigravity-session', agent: 'antigravity', title: 'Shared Antigravity', needle: 'ANTIGRAVITY-ONLY-913' }
  ]
  for (const item of sessions) {
    await writeSessionIndexWithBackend({
      root,
      ir: makeIR(item),
      summaryMode: 'off',
      typesenseCollection
    })
  }

  const codexOnly = await searchIndexWithBackend({
    root,
    query: 'shared collection sentinel',
    agent: 'codex',
    typesenseCollection,
    limit: 10
  })
  assert.ok(codexOnly.hits.length > 0)
  assert.ok(codexOnly.hits.every(hit => hit.agent === 'codex'))

  const claudeOnly = await searchIndexWithBackend({
    root,
    query: 'shared collection sentinel',
    agent: 'claude',
    typesenseCollection,
    limit: 10
  })
  assert.ok(claudeOnly.hits.length > 0)
  assert.ok(claudeOnly.hits.every(hit => hit.agent === 'claude'))

  const wrongAgent = await searchIndexWithBackend({
    root,
    query: 'shared collection sentinel',
    sessionId: 'shared-codex-session',
    agent: 'claude',
    typesenseCollection,
    limit: 10
  })
  assert.equal(wrongAgent.hits.length, 0)

  const scoped = await searchIndexWithBackend({
    root,
    query: 'shared collection sentinel',
    sessionId: 'shared-codex-session',
    agent: 'codex',
    typesenseCollection,
    limit: 10
  })
  assert.ok(scoped.hits.length > 0)
  assert.ok(scoped.hits.every(hit => hit.agent === 'codex'))
})

test('search and browse missing indexed content do not create session artifacts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-no-on-demand-'))
  const typesenseCollection = `session_indexer_no_demand_${process.pid}_${Date.now()}`
  const ir = createSessionIR({
    source: { kind: 'test', path: path.join(root, 'indexed.jsonl') },
    session: { id: 'indexed-session', agent: 'codex', title: 'Indexed session' },
    events: [{
      type: 'message',
      role: 'user',
      content: [textBlock('indexed only sentinel')]
    }]
  })
  await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'off',
    typesenseCollection
  })
  const sessionsDir = path.join(root, 'sessions')
  const beforeFiles = fs.readdirSync(sessionsDir).sort()
  const beforeManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))

  const missingSearch = await searchIndexWithBackend({
    root,
    query: 'indexed only sentinel',
    sessionId: 'missing-session',
    agent: 'codex',
    typesenseCollection,
    limit: 5
  })
  assert.deepEqual(missingSearch.hits, [])
  await assert.rejects(() => browseIndexWithBackend({
    root,
    sessionId: 'missing-session',
    agent: 'codex',
    typesenseCollection,
    limit: 5
  }), /Unknown session browse target/)

  const afterFiles = fs.readdirSync(sessionsDir).sort()
  const afterManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.deepEqual(afterFiles, beforeFiles)
  assert.deepEqual(Object.keys(afterManifest.sessions || {}).sort(), Object.keys(beforeManifest.sessions || {}).sort())
  assert.equal(Object.hasOwn(afterManifest.sessions || {}, 'missing-session'), false)
})

test('index status reports stale summary claims before a session is published', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-stale-claim-'))
  reserveSummaryJobs({
    root,
    sessionId: 'unpublished-stale-session',
    ownerId: 'other-worker',
    claimTtlMs: -1
  })([{
    targetId: 'stale-target',
    targetMaterialHash: 'stale-material',
    handle: 'session/unpublished-stale-session/mip/1',
    inputTokenCount: 123
  }])

  const status = indexStatus({ root, sessionId: 'unpublished-stale-session' })
  assert.equal(status.sessions.length, 1)
  assert.equal(status.sessions[0].indexed, false)
  assert.equal(status.sessions[0].state, 'error')
  assert.match(status.sessions[0].errorMessage, /stale work claims/)
  assert.equal(status.sessions[0].summaryTargetStore.currentStoredStaleClaimCount, 1)
  assert.equal(status.sessions[0].summaryTargetStore.currentStoredClaimedTargetCount, 0)
})

test('reset session index removes persisted local artifacts and manifest state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-reset-'))
  const ir = importCodexJsonl(fixture)
  writeSessionIndex({ root, ir })
  const legacyTreePath = path.join(root, 'sessions', 'mini-session.tree.json')
  assert.equal(fs.existsSync(legacyTreePath), false)
  fs.writeFileSync(legacyTreePath, '{"schema":"legacy-tree"}\n')
  commitSummaryJobs({
    root,
    sessionId: 'mini-session',
    ownerId: 'owner-a',
    jobs: [{
      targetId: 'summary-target',
      targetMaterialHash: 'summary-target-hash',
      handle: 'session/mini-session',
      status: 'completed',
      summary: 'Stored summary.',
      topics: ['Stored summary.']
    }]
  })
  writeJobState({
    root,
    state: {
      jobId: 'reset-job',
      scope: 'this_session_only',
      source: 'codex',
      sessions: [ir.source.path],
      status: 'stopped',
      result: {
        sessions: [{ sessionId: 'mini-session' }]
      },
      progress: { phase: 'stopped' }
    }
  })
  const resetJobState = path.join(root, 'jobs', 'reset-job.json')
  const resetJobOut = path.join(root, 'jobs', 'reset-job.out.log')
  const resetJobErr = path.join(root, 'jobs', 'reset-job.err.log')
  fs.writeFileSync(resetJobOut, 'stdout\n')
  fs.writeFileSync(resetJobErr, 'stderr\n')

  assert.equal(indexStatus({ root, sessionId: 'mini-session' }).sessions[0].indexed, true)
  assert.ok(fs.existsSync(resetJobState))
  assert.ok(fs.existsSync(resetJobOut))
  assert.ok(fs.existsSync(resetJobErr))
  const result = resetSessionIndex({
    root,
    sessionId: 'mini-session'
  })

  assert.equal(result.sessionId, 'mini-session')
  assert.equal(result.removedFromManifest, true)
  assert.equal(result.removedSession.sessionId, 'mini-session')
  assert.equal(result.removedSession.title, 'Codex session mini-session')
  assert.equal(Object.hasOwn(result, 'removedManifestRecord'), false)
  assert.ok(result.removedFiles.some(file => file.endsWith('mini-session.ir.jsonl')))
  assert.ok(result.removedFiles.some(file => file.endsWith('mini-session.tree.json')))
  assert.ok(result.removedFiles.some(file => file.endsWith('mini-session.summary-targets.jsonl')))
  assert.ok(result.removedJobArtifacts.some(job => job.jobId === 'reset-job'))
  assert.equal(fs.existsSync(resetJobState), false)
  assert.equal(fs.existsSync(resetJobOut), false)
  assert.equal(fs.existsSync(resetJobErr), false)
  assert.deepEqual(indexStatus({ root, sessionId: 'mini-session' }).sessions, [])

  const backendFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-reset-backend-failure-'))
  writeSessionIndex({ root: backendFailureRoot, ir })
  await assert.rejects(() => resetSessionIndexWithBackend({
    root: backendFailureRoot,
    sessionId: 'mini-session',
    searchBackend: 'typesense',
    typesenseInstall: false,
    typesenseCollection: `session_indexer_test_${process.pid}`
  }), /managed Typesense is not installed/)
  assert.equal(indexStatus({ root: backendFailureRoot, sessionId: 'mini-session' }).sessions[0].indexed, true)
  assert.ok(fs.existsSync(path.join(backendFailureRoot, 'sessions', 'mini-session.ir.jsonl')))
  assert.equal(fs.existsSync(path.join(backendFailureRoot, 'index', 'mini-session.docs.json')), false)
})

test('summary target storage claims work across processes and reuses completed targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-targets-'))
  const ir = importCodexJsonl(fixture)
  writeSessionIndex({ root, ir })
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'mini-session.summary-targets.jsonl')), false)
  const job = {
    targetId: 'summary-test-target',
    targetMaterialHash: 'material-hash',
    handle: 'session/mini-session/summary/level-1/span-0000-test',
    provider: 'openai-codex-responses',
    model: 'gpt-test',
    inputTokenCount: 42,
    status: 'pending'
  }

  const reserveA = reserveSummaryJobs({
    root,
    sessionId: 'mini-session',
    ownerId: 'owner-a',
    claimTtlMs: 60_000
  })([job])
  assert.deepEqual(reserveA.claimedTargetIds, ['summary-test-target'])
  assert.ok(fs.existsSync(path.join(root, 'sessions', 'mini-session.summary-targets.jsonl')))
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'mini-session.summary-targets.json')), false)

  const reserveBWhileClaimed = reserveSummaryJobs({
    root,
    sessionId: 'mini-session',
    ownerId: 'owner-b',
    claimTtlMs: 60_000
  })([job])
  assert.equal(reserveBWhileClaimed.claimedTargetIds.length, 0)
  assert.equal(reserveBWhileClaimed.skippedJobs[0].status, 'claimed_elsewhere')

  commitSummaryJobs({
    root,
    sessionId: 'mini-session',
    ownerId: 'owner-a',
    jobs: [{
      ...job,
      status: 'completed',
      summary: 'Completed summary body.',
      breadcrumb: 'done',
      topics: ['Completed summary target.']
    }]
  })

  const reserveBAfterCommit = reserveSummaryJobs({
    root,
    sessionId: 'mini-session',
    ownerId: 'owner-b',
    claimTtlMs: 60_000
  })([job])
  assert.equal(reserveBAfterCommit.claimedTargetIds.length, 0)
  assert.equal(reserveBAfterCommit.reusableJobs[0].summary, 'Completed summary body.')
  assert.equal(completedSummaryJobs({ root, sessionId: 'mini-session' }).length, 1)

  const status = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(status.sessions[0].summaryTargetStore.completedTargetCount, 1)
  assert.equal(status.sessions[0].summaryTargetStore.claimedTargetCount, 0)
  assert.equal(status.sessions[0].summaryTargetStore.currentStoredCompletedTargetCount, 1)

  commitSummaryJobs({
    root,
    sessionId: 'mini-session',
    ownerId: 'owner-a',
    jobs: [{
      ...job,
      targetId: 'orphan-target',
      targetMaterialHash: 'orphan-material-hash',
      status: 'completed',
      summary: 'Old summary from a previous tree plan.',
      breadcrumb: 'old',
      topics: ['Previous tree plan target.']
    }]
  })
  const manifestFile = path.join(root, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.sessions['mini-session'].compactions = [{
    status: 'partial',
    targetCount: 1,
    completedTargetCount: 1,
    pendingTargetCount: 0,
    targets: [{ targetId: 'summary-test-target' }]
  }]
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))

  const narrowedStatus = indexStatus({ root, sessionId: 'mini-session' })
  assert.equal(narrowedStatus.sessions[0].summaryTargetStore.completedTargetCount, 2)
  assert.equal(narrowedStatus.sessions[0].summaryTargetStore.currentTargetCount, 1)
  assert.equal(narrowedStatus.sessions[0].summaryTargetStore.currentStoredTargetCount, 1)
  assert.equal(narrowedStatus.sessions[0].summaryTargetStore.currentStoredCompletedTargetCount, 1)
  assert.equal(narrowedStatus.sessions[0].summaryTargetStore.orphanStoredTargetCount, 1)
})

test('models.dev pricing helpers list, resolve, and estimate costs', () => {
  const models = listModels({ catalog: pricingCatalog, filter: 'gpt', limit: 5 })
  assert.equal(models.length, 1)
  assert.equal(models[0].model_id, 'gpt-test')

  const pricing = resolvePricing({ catalog: pricingCatalog, model_id: 'openai/gpt-test' })
  assert.equal(pricing.cost.cache_read, 0.1)

  const estimate = estimateCost({
    pricing,
    usage: {
      input: 1000,
      output: 100,
      cache_read: 250,
      cache_write: 50,
      reasoning: 20,
      total: 1100
    }
  })
  assert.equal(estimate.breakdown.input.tokens, 700)
  assert.equal(estimate.breakdown.output.tokens, 80)
  assert.equal(estimate.breakdown.reasoning.tokens, 20)
  assert.equal(Number(estimate.total_cost_usd.toFixed(8)), 0.0018875)
})

test('deploys repo as a Codex plugin package with marketplace entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-deploy-'))
  const pluginDest = path.join(root, 'plugins', 'conversation-history')
  const marketplacePath = path.join(root, 'marketplace.json')
  const result = deploySkill({
    target: 'codex-plugin',
    dest: pluginDest,
    marketplacePath,
    force: true,
    installDependencies: false
  })

  assert.equal(result.target, 'codex-plugin')
  assert.equal(result.mode, 'copy')
  assert.equal(result.dependenciesInstalled, false)
  assert.equal(fs.lstatSync(pluginDest).isSymbolicLink(), false)
  assert.ok(fs.existsSync(path.join(pluginDest, '.codex-plugin', 'plugin.json')))
  assert.ok(fs.existsSync(path.join(pluginDest, 'skills', 'conversation_history', 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(pluginDest, 'SKILL.md')))
  assert.equal(result.codexSkill, undefined)
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(pluginDest, '.mcp.json'), 'utf8'))
  assert.equal(mcpConfig.mcpServers.conversation_history.cwd, '.')
  assert.deepEqual(mcpConfig.mcpServers.conversation_history.args, ['bin/session-indexer-mcp.js'])
  assert.equal(mcpConfig.mcpServers.conversation_history.env.SESSION_INDEXER_DEPLOY_TARGET, 'codex-plugin')
  assert.doesNotMatch(JSON.stringify(mcpConfig), /CLAUDE_PLUGIN_ROOT/)
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'))
  assert.equal(marketplace.plugins[0].name, 'conversation-history')
  assert.equal(marketplace.plugins[0].source.path, './plugins/conversation-history')
})

test('deploys repo as a Pi skill package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-pi-deploy-'))
  const result = deploySkill({
    target: 'pi',
    piAgentDir: root,
    force: true,
    installDependencies: false
  })

  const skillDest = path.join(root, 'skills', 'conversation_history')
  assert.equal(result.target, 'pi')
  assert.equal(result.mode, 'copy')
  assert.equal(result.dependenciesInstalled, false)
  assert.equal(result.dest, skillDest)
  assert.equal(fs.lstatSync(skillDest).isSymbolicLink(), false)
  assert.ok(fs.existsSync(path.join(skillDest, 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(skillDest, 'bin', 'session-indexer.js')))
  const skill = fs.readFileSync(path.join(skillDest, 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: conversation_history/m)
})

test('deploys repo as a Claude Code plugin package with marketplace entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-claude-deploy-'))
  const pluginDest = path.join(root, 'conversation-history')
  const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json')
  const result = deploySkill({
    target: 'claude-plugin',
    dest: pluginDest,
    marketplacePath,
    force: true,
    installDependencies: false
  })

  assert.equal(result.target, 'claude-plugin')
  assert.equal(result.mode, 'copy')
  assert.equal(result.dependenciesInstalled, false)
  assert.equal(fs.lstatSync(pluginDest).isSymbolicLink(), false)
  assert.ok(fs.existsSync(path.join(pluginDest, '.claude-plugin', 'plugin.json')))
  assert.ok(fs.existsSync(path.join(pluginDest, 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(pluginDest, '.mcp.json')))
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'))
  assert.equal(marketplace.plugins[0].name, 'conversation-history')
  // source path is relative to the marketplace root (parent of .claude-plugin/)
  assert.equal(marketplace.plugins[0].source, './conversation-history')
  assert.match(result.hint.marketplaceAdd, /plugin marketplace add/)
})

test('redeploy target follows the install context, not the caller', async () => {
  const { runCommand, parseArgs } = require('../src/cli.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-redeploy-'))
  const prior = process.env.SESSION_INDEXER_DEPLOY_TARGET
  const redeploy = extraArgs => runCommand(parseArgs([
    'redeploy_session_index_mcp', '--mode', 'copy',
    '--dest', fs.mkdtempSync(path.join(root, 'dest-')),
    '--no-marketplace', '--no-install-dependencies', ...extraArgs
  ]))
  try {
    // Claude plugin install injects this env in its MCP launch config.
    process.env.SESSION_INDEXER_DEPLOY_TARGET = 'claude-plugin'
    assert.equal((await redeploy([])).result.target, 'claude-plugin')

    // Codex install (no env) keeps the codex-plugin default.
    delete process.env.SESSION_INDEXER_DEPLOY_TARGET
    assert.equal((await redeploy([])).result.target, 'codex-plugin')

    // An explicit operator --target still wins over the env.
    process.env.SESSION_INDEXER_DEPLOY_TARGET = 'codex-plugin'
    assert.equal((await redeploy(['--target', 'claude-plugin'])).result.target, 'claude-plugin')
  } finally {
    if (prior === undefined) delete process.env.SESSION_INDEXER_DEPLOY_TARGET
    else process.env.SESSION_INDEXER_DEPLOY_TARGET = prior
  }
})

test('MCP start indexing always generates the conversation marker server-side', () => {
  const { __testing: mcpTesting } = require('../src/mcpServer.js')
  const supplied = 'conversation_history-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const args = { session_marker: supplied }
  const marker = mcpTesting.ensureStartSessionMarker(args)
  assert.equal(marker.generated, true)
  assert.match(marker.sessionMarker, /^conversation_history-session-[0-9a-f-]{36}$/)
  assert.equal(args.session_marker, marker.sessionMarker)
  assert.notEqual(args.session_marker, supplied)
  assert.equal(args.wait_for_session_marker, true)

  const allArgs = { all: true, session_marker: supplied }
  assert.equal(mcpTesting.ensureStartSessionMarker(allArgs), null)
  assert.equal(Object.hasOwn(allArgs, 'session_marker'), false)
})

test('MCP marker discovery uses only the last marker as definitive', async () => {
  const { __testing: mcpTesting } = require('../src/mcpServer.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-mcp-marker-'))
  const session = path.join(root, 'session.jsonl')
  const oldMarker = 'conversation_history-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const latestMarker = 'conversation_history-session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  writeJsonl(session, [
    { timestamp: '2026-06-05T00:00:00.000Z', type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify({ sessionMarker: oldMarker }) } },
    { timestamp: '2026-06-05T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'forked work continues' } },
    { timestamp: '2026-06-05T00:00:02.000Z', type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify({ sessionMarker: latestMarker }) } }
  ])

  const codexSessionService = new CodexSessionServerState({
    sessionRoot: root,
    watch: false
  }).start()

  assert.equal(await mcpTesting.discoverExistingSessionMarker({
    source: 'codex',
    source_root: root,
    codex_session_service: codexSessionService
  }), latestMarker)
})

test('MCP server exposes native conversation search and openLink tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-indexer-mcp-'))
  const ir = importCodexJsonl(fixture)
  await writeSessionIndexWithBackend({
    root,
    ir,
    summaryMode: 'off'
  })
  const indexId = indexIdForIR(ir)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'bin', 'session-indexer-mcp.js')],
    cwd: path.join(__dirname, '..'),
    env: {
      SESSION_INDEXER_STATE_DIR: root,
      SESSION_INDEXER_SUMMARY_MODE: 'off'
    },
    stderr: 'pipe'
  })
  const client = new Client({
    name: 'session-indexer-test',
    version: '0.1.0'
  })

  await client.connect(transport)
  try {
    const listed = await client.listTools()
    const names = listed.tools.map(tool => tool.name)
    assert.ok(names.includes('conversation_search'))
    assert.ok(names.includes('conversation_openLink'))
    assert.ok(names.includes('conversation_index_status'))
    assert.ok(names.includes('start_indexing_session'))
    assert.ok(names.includes('reset_session_index'))
    assert.ok(names.includes('redeploy_session_index_mcp'))
    assert.equal(names.includes('conversation_search_server_status'), false)
    assert.equal(names.includes('conversation_list_models'), false)
    assert.equal(names.includes('conversation_get_cost'), false)
    assert.equal(names.some(name => /^typesense_/i.test(name)), false)
    assert.doesNotMatch(JSON.stringify(listed.tools), /typesense|search_backend|search-backend|serverIndex/i)
    assert.doesNotMatch(JSON.stringify(listed.tools), /max_summary_nodes|maxSummaryNodes|max-summary-nodes/i)
    const publicPropertyNames = listed.tools.flatMap(tool => Object.keys(tool.inputSchema.properties || {}))
    for (const leaked of [
      'session_marker',
      'index_dir',
      'summary_provider',
      'summary_model',
      'summary_max_budget_usd',
      'source_root',
      'session_index',
      'include_response_messages',
      'timeout_ms',
      'poll_ms',
      'debounce_ms',
      'claude_cli_path',
      'codex_home'
    ]) {
      assert.equal(publicPropertyNames.includes(leaked), false, `${leaked} should not be model-facing`)
    }
    assert.doesNotMatch(JSON.stringify(listed.tools), /current_user_message|current-user-message|currentUserMessage/)

    const searchTool = listed.tools.find(tool => tool.name === 'conversation_search')
    assert.ok(searchTool.inputSchema.properties.agent)
    assert.ok(searchTool.inputSchema.properties.filter.properties.agent)
    const browseTool = listed.tools.find(tool => tool.name === 'conversation_browse')
    assert.ok(browseTool.inputSchema.properties.query)
    assert.ok(browseTool.inputSchema.properties.agent)
    assert.ok(browseTool.inputSchema.properties.index_id)
    assert.ok(browseTool.inputSchema.properties.topic_id)
    assert.ok(browseTool.inputSchema.properties.zoom)
    assert.ok(browseTool.inputSchema.properties.start)
    assert.equal(Object.hasOwn(browseTool.inputSchema.properties, 'handle'), false)
    assert.equal(Object.hasOwn(browseTool.inputSchema.properties, 'topic'), false)
    const openTool = listed.tools.find(tool => tool.name === 'conversation_openLink')
    assert.ok(openTool.inputSchema.properties.agent)

    const indexingTool = listed.tools.find(tool => tool.name === 'start_indexing_session')
    assert.deepEqual(Object.keys(indexingTool.inputSchema.properties || {}), ['all'])
    // Redeploy target is decided by the install context, never a model argument.
    const redeployTool = listed.tools.find(tool => tool.name === 'redeploy_session_index_mcp')
    assert.equal(Object.hasOwn(redeployTool.inputSchema.properties || {}, 'target'), false)
    assert.deepEqual(Object.keys(redeployTool.inputSchema.properties || {}), [])

    const prompts = await client.listPrompts()
    const promptNames = prompts.prompts.map(prompt => prompt.name)
    assert.ok(promptNames.includes('conversation_history_system'))
    const prompt = await client.getPrompt({ name: 'conversation_history_system' })
    assert.match(prompt.messages[0].content.text, /conversation_history keeps the conversation outside the context window as a hierarchy/)
    assert.match(prompt.messages[0].content.text, /bounded token budget/)
    assert.match(prompt.messages[0].content.text, /lowest zoom level is lossless/)
    assert.match(prompt.messages[0].content.text, /Do not fill gaps from memory/)
    assert.doesNotMatch(prompt.messages[0].content.text, /session_marker_required|conversation_history-session|session-indexer-session|retry\.session_marker/)
    assert.doesNotMatch(prompt.messages[0].content.text, /start_indexing_session first/)
    assert.doesNotMatch(prompt.messages[0].content.text, /typesense|backend|serverIndex|search_backend|search-backend/i)

    const catalogBrowse = (await client.callTool({
      name: 'conversation_browse',
      arguments: {
        limit: 1
      }
    })).structuredContent.result
    assert.equal(catalogBrowse.schema, 'session-indexer.browse.v1')
    assert.equal(catalogBrowse.level, 'sessions')
    assert.equal(catalogBrowse.page.returned, 1)
    assert.equal(catalogBrowse.sessions[0].session_id, 'mini-session')
    assert.equal(catalogBrowse.sessions[0].browse.index_id, indexId)
    assert.equal(catalogBrowse.sessions[0].browse.topic_id, 'root')
    assert.equal(Object.hasOwn(catalogBrowse, 'resourceUsage'), false)
    assert.equal(Object.hasOwn(catalogBrowse.sessions[0], 'summaryIndex'), false)

    const browsed = await client.callTool({
      name: 'conversation_browse',
      arguments: {
        index_id: indexId,
        session_id: 'mini-session',
        limit: 1
      }
    })
    const browseResult = browsed.structuredContent.result
    assert.equal(browseResult.schema, 'session-indexer.browse.v1')
    assert.equal(Object.hasOwn(browseResult, 'indexStatus'), false)
    assert.equal(Object.hasOwn(browseResult, 'ready'), false)
    assert.equal(Object.hasOwn(browseResult, 'handle'), false)
    assert.equal(browseResult.zoom, 'children')
    assert.equal(browseResult.page.start, 0)
    assert.equal(browseResult.page.limit, 1)
    assert.equal(browseResult.page.returned, 1)
    assert.ok(browseResult.topics[0].topic_id)
    if (browseResult.children.length) {
      assert.equal(Object.hasOwn(browseResult.children[0], 'handle'), false)
      assert.equal(Object.hasOwn(browseResult.children[0], 'resourceLinks'), false)
      assert.equal(Object.hasOwn(browseResult.children[0], 'summaryMeta'), false)
      assert.equal(Object.hasOwn(browseResult.children[0], 'usage'), false)
      assert.ok(browseResult.children[0].topic_id)
    }
    const rootTopicBrowse = (await client.callTool({
      name: 'conversation_browse',
      arguments: {
        index_id: indexId,
        session_id: 'mini-session',
        topic_id: 'root',
        limit: 1
      }
    })).structuredContent.result
    assert.equal(rootTopicBrowse.zoom, 'children')
    assert.equal(rootTopicBrowse.selected_topic_id, undefined)
    assert.equal(rootTopicBrowse.children[0].link, browseResult.children[0].link)
    const browseSecondPage = (await client.callTool({
      name: 'conversation_browse',
      arguments: {
        index_id: indexId,
        session_id: 'mini-session',
        start: 1,
        limit: 1
      }
    })).structuredContent.result
    assert.equal(browseSecondPage.page.start, 1)
    assert.equal(browseSecondPage.page.returned, 1)
    assert.notEqual(browseSecondPage.children[0].topic_id, browseResult.children[0].topic_id)
    assert.equal(browseSecondPage.children[0].index, '2/5')
    const zoomedBrowse = (await client.callTool({
      name: 'conversation_browse',
      arguments: {
        index_id: indexId,
        session_id: 'mini-session',
        topic_id: browseResult.children[0].topic_id,
        zoom: 'in',
        limit: 1
      }
    })).structuredContent.result
    assert.equal(zoomedBrowse.zoom, 'in')
    assert.equal(zoomedBrowse.selected_topic_id, browseResult.children[0].topic_id)
    assert.equal(zoomedBrowse.topic_id, browseResult.children[0].topic_id)
    assert.equal(Object.hasOwn(zoomedBrowse, 'handle'), false)

    const callMiniStatus = async () => (await client.callTool({
      name: 'conversation_index_status',
      arguments: {
        start_at: 0,
        limit: 1,
        session_id: 'mini-session'
      }
    })).structuredContent.result
    const statusResult = await callMiniStatus()
    assert.equal(statusResult.schema, 'session-indexer.index_status.v1')
    assert.equal(Object.hasOwn(statusResult, 'indexedSessionCount'), false)
    assert.equal(Object.hasOwn(statusResult, 'requestedSessionCount'), false)
    assert.equal(Object.hasOwn(statusResult, 'upToDate'), false)
    assert.equal(Object.hasOwn(statusResult.sessions[0], 'upToDate'), false)
    assert.equal(Object.hasOwn(statusResult.sessions[0], 'staleByMs'), false)
    assert.equal(Object.hasOwn(statusResult.sessions[0], 'sourceUpdatedAt'), false)
    assert.equal(Object.hasOwn(statusResult.sessions[0], 'sourceUpdatedAgo'), false)
    assert.equal(statusResult.sessions[0].indexId, indexId)
    assert.equal(Object.hasOwn(statusResult.sessions[0].indexingStats, 'summaryUsageBasis'), false)
    assert.equal(Object.hasOwn(statusResult.sessions[0], 'compactions'), false)
    if (statusResult.sessions[0].indexingJob) {
      assert.equal(Object.hasOwn(statusResult.sessions[0].indexingJob, 'result'), false)
      assert.equal(Object.hasOwn(statusResult.sessions[0].indexingJob, 'running'), false)
      assert.equal(Object.hasOwn(statusResult.sessions[0].indexingJob, 'maxSummaryNodes'), false)
    }
    assert.equal(statusResult.sessions[0].summaryTargetStore.targetCount, 0)
    assert.equal(Object.hasOwn(statusResult.sessions[0], 'nextStatusPoll'), false)

    const statusWorker = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    try {
      writeJobState({
        root,
        state: {
          jobId: 'mcp-status-backoff',
          scope: 'this_session_only',
          source: 'codex',
          sessions: [ir.source.path],
          pid: statusWorker.pid,
          status: 'indexing',
          ready: false,
          progress: {
            phase: 'indexing',
            targetId: 'same-target'
          }
        }
      })
      const activeFirst = await callMiniStatus()
      assert.equal(activeFirst.sessions[0].state, 'indexing-in-progress')
      assert.equal(activeFirst.sessions[0].nextStatusPoll.reason, 'active_indexing')
      assert.equal(activeFirst.sessions[0].nextStatusPoll.source, 'mcp_backoff')
      assert.equal(activeFirst.sessions[0].nextStatusPoll.retryAfterMs, 15000)
      assert.match(activeFirst.sessions[0].nextStatusPoll.retryAt, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(activeFirst.sessions[0].nextStatusPoll.backoff.strategy, 'exponential')
      assert.equal(activeFirst.sessions[0].nextStatusPoll.backoff.currentMs, 15000)

      const activeSecond = await callMiniStatus()
      assert.equal(activeSecond.sessions[0].state, 'indexing-in-progress')
      assert.equal(activeSecond.sessions[0].nextStatusPoll.retryAfterMs, 30000)
      assert.equal(activeSecond.sessions[0].nextStatusPoll.backoff.currentMs, 30000)

      writeJobState({
        root,
        state: {
          jobId: 'mcp-status-backoff',
          scope: 'this_session_only',
          source: 'codex',
          sessions: [ir.source.path],
          pid: statusWorker.pid,
          status: 'indexing',
          ready: false,
          progress: {
            phase: 'indexing',
            targetId: 'next-target'
          }
        }
      })
      const activeChanged = await callMiniStatus()
      assert.equal(activeChanged.sessions[0].state, 'indexing-in-progress')
      assert.equal(activeChanged.sessions[0].nextStatusPoll.retryAfterMs, 15000)
      assert.equal(activeChanged.sessions[0].nextStatusPoll.backoff.currentMs, 15000)

      writeJobState({
        root,
        state: {
          jobId: 'mcp-status-backoff',
          scope: 'this_session_only',
          source: 'codex',
          sessions: [ir.source.path],
          status: 'suspended',
          suspendedReason: 'summary_budget',
          message: 'summary budget approval required',
          suspension: {
            reason: 'summary_budget',
            message: 'summary budget approval required',
            requiredAction: 'Ask the user to approve the remaining conversation_history indexing budget.'
          },
          progress: {
            phase: 'summary:budget_suspended',
            suspended: true,
            reason: 'summary_budget'
          }
        }
      })
      const suspended = await callMiniStatus()
      assert.equal(suspended.sessions[0].state, 'suspended-budget')
      assert.equal(suspended.sessions[0].nextStatusPoll.reason, 'approval_required')
      assert.equal(suspended.sessions[0].nextStatusPoll.retryAfterMs, null)
      assert.equal(suspended.sessions[0].nextStatusPoll.retryAt, null)
      assert.match(suspended.sessions[0].nextStatusPoll.message, /Do not poll/)
    } finally {
      if (!statusWorker.killed) statusWorker.kill('SIGTERM')
      await Promise.race([
        new Promise(resolve => statusWorker.once('exit', resolve)),
        sleepMs(1000)
      ])
    }

    const searched = await client.callTool({
      name: 'conversation_search',
      arguments: {
        session_id: 'mini-session',
        query: 'clientRevision atlas',
        limit: 1
      }
    })
    const searchResult = searched.structuredContent.result
    assert.equal(searchResult.schema, 'session-indexer.search.v1')
    assert.equal(Object.hasOwn(searchResult, 'indexStatus'), false)
    assert.equal(Object.hasOwn(searchResult, 'searchBackend'), false)
    assert.equal(Object.hasOwn(searchResult, 'indexDir'), false)
    assert.equal(Object.hasOwn(searchResult, 'filter'), false)
    assert.equal(searchResult.hits.length, 1)
    assert.equal(searchResult.hits[0].index_id, indexId)
    assert.equal(Object.hasOwn(searchResult.hits[0], 'head'), false)
    assert.equal(Object.hasOwn(searchResult.hits[0], 'excerpt'), false)
    assert.equal(Object.hasOwn(searchResult.hits[0], 'navigation'), false)
    assert.equal(Object.hasOwn(searchResult.hits[0], 'usage'), false)
    assert.equal(Object.hasOwn(searchResult.hits[0], 'summaryMeta'), false)

    const docs = collectIndexDocuments(readSessionTree({ root, sessionId: 'mini-session' }))
    const openDoc = docs.find(doc => /clientRevision 7|atlas/i.test(doc.searchText))
    assert.ok(openDoc)
    const opened = await client.callTool({
      name: 'conversation_openLink',
      arguments: {
        link: openDoc.link,
        budget_tokens: 2000
      }
    })
    const openResult = opened.structuredContent.result
    assert.equal(openResult.schema, 'session-indexer.openLink.v1')
    assert.match(openResult.content, /clientRevision 7|atlas/i)

    const reset = await client.callTool({
      name: 'reset_session_index',
      arguments: {
        session_id: 'mini-session'
      }
    })
    assert.equal(reset.structuredContent.result.schema, 'session-indexer.reset_session_index.v1')
    assert.equal(Object.hasOwn(reset.structuredContent.result.sessions[0], 'removedFiles'), false)
    assert.equal(Object.hasOwn(reset.structuredContent.result.sessions[0], 'removedJobArtifacts'), false)
    assert.deepEqual(indexStatus({ root, sessionId: 'mini-session' }).sessions, [])

    const missingBrowse = await client.callTool({
      name: 'conversation_browse',
      arguments: {
        index_id: indexId,
        session_id: 'mini-session',
        limit: 1
      }
    })
    assert.equal(missingBrowse.isError, true)
    assert.match(missingBrowse.content[0].text, /Unknown session browse target|conversation_history CLI failed/)
  } finally {
    await client.close()
  }
})

test('test cleanup removes temporary ConversationHistory runtimes', async () => {
  const roots = await cleanupTestTempRoots()
  for (const root of roots) {
    assert.equal(fs.existsSync(root), false, `${root} was removed`)
  }
})
