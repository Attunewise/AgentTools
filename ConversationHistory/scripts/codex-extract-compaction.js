#!/usr/bin/env node
'use strict'

// Extract the last compaction "summary" (the carried-forward context) plus every
// message recorded after it from a Codex rollout, and emit it as an OpenAI
// chat-completions `messages` array.
//
// Codex desktop compactions store their summary as `encrypted_content`, which is
// not recoverable as plaintext. What the model actually carries forward after a
// compaction is the `replacement_history` attached to the `compacted` event, so
// that is what we reconstruct here. If a session ever records a plaintext summary
// (`payload.message`), we prefer it.
//
// Usage:
//   node scripts/codex-extract-compaction.js --title "Build lang repl UI"
//   node scripts/codex-extract-compaction.js --file <rollout.jsonl> [--out out.json]
//   node scripts/codex-extract-compaction.js --session-id <uuid>
//   node scripts/codex-extract-compaction.js --latest
//
// Flags:
//   --out <path>            write JSON here instead of stdout
//   --developer-role <r>    map Codex `developer` role to this OpenAI role
//                           (default: developer; use `system` for older APIs)
//   --no-replacement-history  emit only the summary marker + subsequent messages,
//                             skipping the reconstructed pre-compaction history
//   --messages-only         emit a bare messages array (default wraps with meta)
//   --pretty                pretty-print JSON (default: on for files, compact off)

const fs = require('fs')
const os = require('os')
const path = require('path')
const { readJsonlRows, stableStringify, walkFiles, newestFile } = require('../src/util.js')

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions')
const DEFAULT_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl')

const parseArgs = argv => {
  const opts = { developerRole: 'developer', includeReplacementHistory: true, messagesOnly: false, pretty: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--file': opts.file = next(); break
      case '--title': opts.title = next(); break
      case '--session-id': opts.sessionId = next(); break
      case '--latest': opts.latest = true; break
      case '--list': opts.list = true; break
      case '--out': opts.out = next(); break
      case '--developer-role': opts.developerRole = next(); break
      case '--no-replacement-history': opts.includeReplacementHistory = false; break
      case '--messages-only': opts.messagesOnly = true; break
      case '--pretty': opts.pretty = true; break
      case '--sessions-root': opts.sessionsRoot = next(); break
      case '--session-index': opts.sessionIndex = next(); break
      case '-h': case '--help': opts.help = true; break
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

// ---- session file resolution -------------------------------------------------

const sessionFilesByIdFragment = (root, fragment) =>
  walkFiles(root, file => file.endsWith('.jsonl') && file.includes(fragment))

const readSessionIndex = file => {
  const entries = []
  try {
    for (const row of readJsonlRows(file)) {
      if (row.parseError || !row.json || !row.json.id) continue
      entries.push({ id: row.json.id, name: row.json.thread_name || row.json.name || row.json.id, updatedAt: row.json.updated_at })
    }
  } catch (_err) {
    // session_index.jsonl is optional metadata.
  }
  return entries
}

// Lists every Codex session found on disk, newest first, in a shape ready for a
// picker menu: { id, title, updatedAt, file, sizeBytes, files }. Titles come from
// session_index.jsonl when available; sessions missing from the index still appear.
const listSessions = (opts = {}) => {
  const root = opts.sessionsRoot || DEFAULT_SESSIONS_ROOT
  const index = new Map(readSessionIndex(opts.sessionIndex || DEFAULT_SESSION_INDEX).map(e => [e.id, e]))
  const byId = new Map()
  for (const file of walkFiles(root, f => f.endsWith('.jsonl'))) {
    let stat
    try { stat = fs.statSync(file) } catch (_err) { continue }
    const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/)
    const id = match ? match[1] : file
    const entry = byId.get(id) || { id, file, mtimeMs: 0, sizeBytes: 0, files: 0 }
    entry.files += 1
    entry.sizeBytes += stat.size
    if (stat.mtimeMs > entry.mtimeMs) {
      entry.mtimeMs = stat.mtimeMs
      entry.file = file
    }
    byId.set(id, entry)
  }
  return [...byId.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(entry => {
      const meta = index.get(entry.id)
      return {
        id: entry.id,
        title: meta && meta.name || `(untitled) ${entry.id}`,
        updatedAt: new Date(entry.mtimeMs).toISOString(),
        file: entry.file,
        sizeBytes: entry.sizeBytes,
        files: entry.files
      }
    })
}

const resolveSessionFile = opts => {
  const root = opts.sessionsRoot || DEFAULT_SESSIONS_ROOT
  if (opts.file) return path.resolve(opts.file)

  if (opts.sessionId) {
    const matches = sessionFilesByIdFragment(root, opts.sessionId)
    if (!matches.length) throw new Error(`no Codex rollout file found for session id ${opts.sessionId}`)
    return newestFile(matches).file
  }

  if (opts.title) {
    const entries = readSessionIndex(opts.sessionIndex || DEFAULT_SESSION_INDEX)
    const wanted = opts.title.trim().toLowerCase()
    const hits = entries.filter(e => (e.name || '').trim().toLowerCase() === wanted)
    const candidates = hits.length ? hits : entries.filter(e => (e.name || '').toLowerCase().includes(wanted))
    if (!candidates.length) throw new Error(`no session titled "${opts.title}" found in ${opts.sessionIndex || DEFAULT_SESSION_INDEX}`)
    // Newest matching session id wins if several share the title.
    candidates.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    for (const candidate of candidates) {
      const files = sessionFilesByIdFragment(root, candidate.id)
      if (files.length) return newestFile(files).file
    }
    throw new Error(`session "${opts.title}" (id ${candidates[0].id}) has no rollout file under ${root}`)
  }

  if (opts.latest) {
    const latest = newestFile(walkFiles(root, file => file.endsWith('.jsonl')))
    if (!latest) throw new Error(`no Codex rollout files under ${root}`)
    return latest.file
  }

  throw new Error('specify one of --file, --title, --session-id, or --latest')
}

// ---- Codex API item -> OpenAI chat message mapping ---------------------------

const itemText = content => {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stableStringify(content)
  return content
    .map(part => {
      if (!part) return ''
      if (typeof part === 'string') return part
      return part.text || part.input_text || part.output_text || ''
    })
    .filter(Boolean)
    .join('')
}

const toArguments = value => {
  if (value == null) return '{}'
  if (typeof value === 'string') return value
  return stableStringify(value)
}

const toOutputString = value => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value.output === 'string') return value.output
  return stableStringify(value)
}

// Returns an array of OpenAI chat-completions messages for one Codex API item
// (shared between replacement_history items and post-compaction response_items).
const apiItemToMessages = (item, opts) => {
  if (!item || typeof item !== 'object') return []
  switch (item.type) {
    case 'message': {
      const text = itemText(item.content)
      if (!text) return []
      let role = item.role || 'user'
      if (role === 'developer') role = opts.developerRole
      if (role === 'tool') role = 'assistant' // defensive; tool output comes via *_output items
      return [{ role, content: text }]
    }
    case 'function_call':
    case 'custom_tool_call': {
      const callId = item.call_id || item.callId || item.id
      const args = item.arguments !== undefined ? item.arguments : item.input
      return [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: callId || 'call_unknown',
          type: 'function',
          function: { name: item.name || 'unknown', arguments: toArguments(args) }
        }]
      }]
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = item.call_id || item.callId || item.id
      return [{ role: 'tool', tool_call_id: callId || 'call_unknown', content: toOutputString(item.output) }]
    }
    case 'compaction':
      // Encrypted summary blob — represented separately by the caller.
      return []
    case 'reasoning':
    case 'web_search_call':
    default:
      return []
  }
}

const compactionSummaryMessage = (compactedPayload, replacementHistory) => {
  const plaintext = compactedPayload && typeof compactedPayload.message === 'string' ? compactedPayload.message.trim() : ''
  if (plaintext) return { role: 'system', content: plaintext }
  const encrypted = (replacementHistory || []).find(item => item && item.type === 'compaction' && item.encrypted_content)
  const bytes = encrypted ? encrypted.encrypted_content.length : 0
  const preserved = (replacementHistory || []).length
  return {
    role: 'system',
    content: `[Codex compaction summary — encrypted (${bytes} bytes), not recoverable as plaintext. ${preserved} item(s) of carried-forward context preserved below.]`
  }
}

// ---- extraction --------------------------------------------------------------

const extract = (file, opts) => {
  let lastCompacted = null // { lineNumber, payload }
  let subsequent = [] // rows after the most recent compacted row

  for (const row of readJsonlRows(file)) {
    if (row.parseError || !row.json) continue
    if (row.json.type === 'compacted') {
      lastCompacted = { lineNumber: row.lineNumber, payload: row.json.payload || {}, timestamp: row.json.timestamp }
      subsequent = [] // reset: only keep rows after the *last* compaction
      continue
    }
    if (lastCompacted) subsequent.push(row)
  }

  if (!lastCompacted) throw new Error(`no compaction (\`compacted\`) event found in ${file}`)

  const replacementHistory = Array.isArray(lastCompacted.payload.replacement_history)
    ? lastCompacted.payload.replacement_history
    : []

  const messages = []

  // 1. The compaction summary marker (plaintext if present, else encrypted note).
  messages.push(compactionSummaryMessage(lastCompacted.payload, replacementHistory))

  // 2. The carried-forward (pre-compaction) context, reconstructed.
  let historyMessages = 0
  if (opts.includeReplacementHistory) {
    for (const item of replacementHistory) {
      const mapped = apiItemToMessages(item, opts)
      historyMessages += mapped.length
      messages.push(...mapped)
    }
  }

  // 3. Everything recorded after the last compaction.
  let subsequentMessages = 0
  for (const row of subsequent) {
    if (row.json.type !== 'response_item') continue // event_msg rows mirror these; skip the duplicates
    const mapped = apiItemToMessages(row.json.payload || {}, opts)
    subsequentMessages += mapped.length
    messages.push(...mapped)
  }

  return {
    messages,
    meta: {
      source: file,
      lastCompactionLine: lastCompacted.lineNumber,
      lastCompactionTimestamp: lastCompacted.timestamp,
      replacementHistoryItems: replacementHistory.length,
      encryptedSummary: !(lastCompacted.payload && lastCompacted.payload.message),
      reconstructedHistoryMessages: historyMessages,
      subsequentRows: subsequent.length,
      subsequentMessages
    }
  }
}

// ---- main --------------------------------------------------------------------

const HELP = `codex-extract-compaction — export last compaction + subsequent messages as OpenAI chat messages

  node scripts/codex-extract-compaction.js --title "Build lang repl UI" [--out out.json] [--pretty]
  node scripts/codex-extract-compaction.js --file <rollout.jsonl>
  node scripts/codex-extract-compaction.js --session-id <uuid>
  node scripts/codex-extract-compaction.js --latest
  node scripts/codex-extract-compaction.js --list

  --list                     list all sessions (newest first) as JSON for a picker menu
  --out <path>               write to file instead of stdout
  --developer-role <role>    OpenAI role for Codex 'developer' messages (default: developer)
  --no-replacement-history   skip the reconstructed pre-compaction context
  --messages-only            emit a bare messages array (omit the meta wrapper)
  --pretty                   pretty-print JSON
`

const main = () => {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`)
    process.exit(2)
  }
  if (opts.help) {
    process.stdout.write(HELP)
    return
  }

  if (opts.list) {
    const sessions = listSessions(opts)
    const json = JSON.stringify(sessions, null, opts.pretty || opts.out ? 2 : 0)
    if (opts.out) {
      fs.writeFileSync(opts.out, json)
      process.stderr.write(`wrote ${sessions.length} sessions to ${opts.out}\n`)
    } else {
      process.stdout.write(json + '\n')
    }
    return
  }

  const file = resolveSessionFile(opts)
  const result = extract(file, opts)
  const payload = opts.messagesOnly ? result.messages : result
  const json = JSON.stringify(payload, null, opts.pretty || opts.out ? 2 : 0)

  if (opts.out) {
    fs.writeFileSync(opts.out, json)
    process.stderr.write(`wrote ${result.messages.length} messages to ${opts.out}\n`)
    process.stderr.write(`${stableStringify(result.meta)}\n`)
  } else {
    process.stdout.write(json + '\n')
  }
}

if (require.main === module) main()

module.exports = { extract, apiItemToMessages, resolveSessionFile, listSessions }
