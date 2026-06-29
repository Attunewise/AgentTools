const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  createSessionIR,
  normalizeModelFamily,
  normalizeUsage
} = require('../ir.js')
const {
  hashString,
  preview,
  readJsonlRows,
  stableStringify,
  walkFiles,
  newestFile
} = require('../util.js')

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.claude', 'projects')
// Claude Code stores titles inline (ai-title/custom-title records); no external index file.
const DEFAULT_SESSION_INDEX = ''
const SESSION_MARKER_PREFIX = 'conversation_history-session-'
const LEGACY_SESSION_MARKER_PREFIX = 'session-indexer-session-'
const DEFAULT_SESSION_MARKER_SCAN_BYTES = 8 * 1024 * 1024
const DEFAULT_SESSION_MARKER_SCAN_LIMIT = 100

const contentText = content => {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stableStringify(content)
  return content.map(part => {
    if (!part) return ''
    if (typeof part === 'string') return part
    return part.text || part.content || stableStringify(part)
  }).filter(Boolean).join('\n')
}

const claudeSessionFiles = (root = DEFAULT_SESSIONS_ROOT) => walkFiles(root, file => file.endsWith('.jsonl'))

const latestClaudeSessionFile = (root = DEFAULT_SESSIONS_ROOT) => {
  const latest = newestFile(claudeSessionFiles(root))
  return latest && latest.file
}

const claudeSessionFileItems = (root = DEFAULT_SESSIONS_ROOT) => claudeSessionFiles(root)
  .map(file => {
    try {
      const stat = fs.statSync(file)
      return { file, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch (_err) {
      return null
    }
  })
  .filter(Boolean)

const sessionMarkerScanLimit = opts => {
  const value = opts.sessionMarkerScanLimit === undefined
    ? process.env.SESSION_INDEXER_SESSION_MARKER_SCAN_LIMIT || DEFAULT_SESSION_MARKER_SCAN_LIMIT
    : opts.sessionMarkerScanLimit
  const text = String(value || '').trim().toLowerCase()
  if (!text || text === 'all' || text === 'off' || text === 'none') return Infinity
  const number = Number(text)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_SESSION_MARKER_SCAN_LIMIT
}

const recentSessionFileItems = (items, opts = {}) => {
  const sorted = [...(items || [])].sort((a, b) =>
    b.mtimeMs - a.mtimeMs ||
    b.size - a.size ||
    a.file.localeCompare(b.file)
  )
  const limit = sessionMarkerScanLimit(opts)
  return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted
}

const blocksOf = row => {
  if (row.parseError || !row.json) return []
  const content = row.json.message && row.json.message.content
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return []
}

const normalizeSessionMarker = value => {
  const marker = String(value || '').trim()
  if (!marker) return ''
  return marker.startsWith(SESSION_MARKER_PREFIX) || marker.startsWith(LEGACY_SESSION_MARKER_PREFIX) ? marker : ''
}

const fileContainsLiteral = ({ file, literal, tailBytes = DEFAULT_SESSION_MARKER_SCAN_BYTES }) => {
  const needle = Buffer.from(String(literal || ''))
  if (!needle.length) return null
  const fd = fs.openSync(file, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const readRegion = ({ start, end, scan }) => {
      const length = Math.max(0, end - start)
      if (!length) return null
      const buffer = Buffer.allocUnsafe(length)
      fs.readSync(fd, buffer, 0, length, start)
      const index = buffer.indexOf(needle)
      return index >= 0
        ? {
            byteOffset: start + index,
            scan
          }
        : null
    }
    const tailStart = Math.max(0, stat.size - tailBytes - Math.max(0, needle.length - 1))
    const tailMatch = readRegion({ start: tailStart, end: stat.size, scan: 'tail' })
    if (tailMatch) return tailMatch
    if (tailStart <= 0) return null

    const chunkSize = 1024 * 1024
    let position = 0
    let carry = Buffer.alloc(0)
    while (position < tailStart) {
      const readSize = Math.min(chunkSize, tailStart - position)
      const chunk = Buffer.allocUnsafe(readSize)
      fs.readSync(fd, chunk, 0, readSize, position)
      const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const index = combined.indexOf(needle)
      if (index >= 0) {
        return {
          byteOffset: position - carry.length + index,
          scan: 'full'
        }
      }
      carry = combined.slice(-Math.max(0, needle.length - 1))
      position += readSize
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

const scoreClaudeSessionFile = (item, marker, opts = {}) => {
  let fileItem = item
  if (typeof item === 'string') {
    const stat = fs.statSync(item)
    fileItem = {
      file: item,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  }
  const match = fileContainsLiteral({
    file: fileItem.file,
    literal: marker,
    tailBytes: opts.sessionMarkerScanBytes || DEFAULT_SESSION_MARKER_SCAN_BYTES
  })
  if (!match) return null
  const mtimeMs = fileItem.mtimeMs !== undefined ? fileItem.mtimeMs : Number(fileItem.mtime)
  const size = fileItem.size
  return {
    file: fileItem.file,
    mtimeMs,
    size,
    signals: {
      sessionMarkerMatch: {
        marker,
        byteOffset: match.byteOffset,
        scan: match.scan
      }
    }
  }
}

const resolveCurrentClaudeSessionFile = (opts = {}) => {
  const sessionMarker = normalizeSessionMarker(opts.sessionMarker)
  if (!sessionMarker) return null
  const candidates = recentSessionFileItems(claudeSessionFileItems(opts.root || DEFAULT_SESSIONS_ROOT), opts)
    .map(item => scoreClaudeSessionFile(item, sessionMarker, opts))
    .filter(Boolean)
  if (!candidates.length) return null
  candidates.sort((a, b) => a.file.localeCompare(b.file))
  if (candidates.length > 1) {
    const err = new Error(`session marker matched multiple Claude session files: ${candidates.map(item => item.file).join(', ')}`)
    err.code = 'AMBIGUOUS_SESSION_MARKER'
    err.candidates = candidates
    throw err
  }
  const selected = candidates[0]
  return {
    ...selected,
    reason: 'session_marker_match',
    candidates: candidates.slice(0, opts.includeCandidates ? opts.limit || 10 : 0)
  }
}

const sourceFor = ({ file, row, block }) => ({
  sourceKind: 'claude-jsonl',
  path: file,
  lineNumber: row.lineNumber,
  outerType: row.json.type,
  payloadType: block && block.type,
  callId: block && (block.id || block.tool_use_id),
  toolName: block && block.name
})

const toolResultOutput = (block, row) => {
  if (row.json.toolUseResult !== undefined) return stableStringify(row.json.toolUseResult)
  if (block.content !== undefined) return contentText(block.content)
  return stableStringify(block)
}

// Drop noisy diagnostic system rows that add no navigational value.
const SKIP_SYSTEM_SUBTYPES = new Set(['turn_duration', 'stop_hook_summary'])

const rowToEvents = ({ row, file }) => {
  if (row.parseError) {
    return [{
      type: 'agent_event',
      role: 'observer',
      title: 'jsonl parse error',
      content: row.parseError,
      source: { sourceKind: 'claude-jsonl', path: file, lineNumber: row.lineNumber }
    }]
  }
  const json = row.json
  const type = json.type
  const at = json.timestamp
  const sidechain = json.isSidechain ? { sidechain: true } : undefined

  if (type === 'user') {
    const blocks = blocksOf(row)
    return blocks.flatMap(block => {
      const source = sourceFor({ file, row, block })
      if (block.type === 'tool_result') {
        return [{
          type: 'tool_result',
          role: 'tool',
          at,
          title: 'tool result',
          callId: block.tool_use_id,
          output: toolResultOutput(block, row),
          source,
          meta: { ...(sidechain || {}), isError: Boolean(block.is_error) }
        }]
      }
      const text = block.type === 'text' ? block.text : contentText(block)
      if (!text) return []
      // A post-compaction summary is a normal user record flagged isCompactSummary;
      // it is a navigation/summary record, not original user input.
      const userMeta = {
        ...(sidechain || {}),
        ...(json.isCompactSummary ? { isCompactSummary: true } : {})
      }
      return [{
        type: 'message',
        role: 'user',
        messageId: json.uuid,
        at,
        title: json.isCompactSummary ? 'compaction summary' : 'user message',
        content: text,
        source,
        meta: Object.keys(userMeta).length ? userMeta : undefined
      }]
    })
  }

  if (type === 'assistant') {
    const message = json.message || {}
    const model = message.model
    const modelFamily = normalizeModelFamily(model)
    const events = blocksOf(row).flatMap(block => {
      const source = sourceFor({ file, row, block })
      if (block.type === 'text') {
        if (!block.text) return []
        return [{
          type: 'message',
          role: 'assistant',
          at,
          title: 'assistant message',
          content: block.text,
          source,
          model,
          modelFamily,
          meta: sidechain
        }]
      }
      if (block.type === 'thinking') {
        if (!block.thinking && !block.signature) return []
        return [{
          type: 'reasoning',
          role: 'assistant',
          at,
          title: 'reasoning record',
          reasoning: [{
            modelFamily: 'anthropic',
            hasSummary: Boolean(block.thinking),
            hasSignature: Boolean(block.signature)
          }],
          source,
          model,
          modelFamily,
          meta: sidechain
        }]
      }
      if (block.type === 'tool_use') {
        return [{
          type: 'tool_call',
          role: 'assistant',
          at,
          title: `tool call ${block.name || 'unknown'}`,
          call: {
            id: block.id,
            name: block.name || 'unknown',
            arguments: block.input,
            raw: block
          },
          source,
          model,
          modelFamily,
          meta: sidechain
        }]
      }
      return []
    })
    if (message.usage) {
      events.push({
        type: 'usage',
        role: 'observer',
        at,
        title: 'token usage',
        usage: message.usage,
        content: { usage: normalizeUsage(message.usage) },
        source: sourceFor({ file, row, block: null }),
        model,
        modelFamily,
        meta: { ...(sidechain || {}), rawUsage: message.usage, stopReason: message.stop_reason }
      })
    }
    return events
  }

  // Verified against Claude Code (v2.1.x): a compaction boundary is written as a
  // system record with subtype "compact_boundary" carrying compactMetadata. The
  // synthesized summary that follows is a separate user record flagged
  // isCompactSummary (handled above). `type:"summary"` records are resume/title
  // pointers (with leafUuid), not compaction, so they are intentionally ignored.
  if (type === 'system' && json.subtype === 'compact_boundary') {
    const compactMetadata = json.compactMetadata || {}
    return [{
      type: 'compaction',
      role: 'system',
      at,
      title: 'context compacted',
      content: {
        note: json.content,
        subtype: json.subtype,
        compactMetadata
      },
      source: sourceFor({ file, row, block: null }),
      meta: {
        trigger: compactMetadata.trigger,
        preTokens: compactMetadata.preTokens,
        postTokens: compactMetadata.postTokens,
        preservedMessages: compactMetadata.preservedMessages,
        hasPreservedSegment: Boolean(compactMetadata.preservedSegment || compactMetadata.preservedMessages),
        logicalParentUuid: json.logicalParentUuid
      }
    }]
  }

  if (type === 'system') {
    if (SKIP_SYSTEM_SUBTYPES.has(json.subtype)) return []
    return [{
      type: 'agent_event',
      role: 'observer',
      at,
      title: `system ${json.subtype || ''}`.trim(),
      content: { subtype: json.subtype, level: json.level, toolUseID: json.toolUseID },
      source: sourceFor({ file, row, block: null }),
      meta: sidechain
    }]
  }

  if (type === 'attachment') {
    return [{
      type: 'agent_event',
      role: 'observer',
      at,
      title: 'attachment',
      content: json.attachment || {},
      source: sourceFor({ file, row, block: null }),
      meta: sidechain
    }]
  }

  // ai-title, custom-title, last-prompt, queue-operation, mode, permission-mode,
  // file-history-snapshot: control/metadata records, not transcript events.
  return []
}

const fallbackSessionIdFromFile = file => {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/)
  return match ? match[1] : hashString(file).slice(0, 24)
}

const titleForSession = ({ sessionId, firstUserText, aiTitle, customTitle }) => {
  return customTitle || aiTitle || (firstUserText && preview(firstUserText, 80)) || `Claude session ${sessionId}`
}

const importClaudeJsonl = (file, _opts = {}) => {
  const stat = fs.statSync(file)
  let sessionId
  let firstAt
  let cwd
  let model
  let firstUserText = ''
  let aiTitle
  let customTitle
  const events = []
  for (const row of readJsonlRows(file)) {
    if (!row.parseError && row.json) {
      if (!sessionId && row.json.sessionId) sessionId = row.json.sessionId
      if (row.json.type === 'custom-title' && row.json.customTitle) customTitle = row.json.customTitle
      else if (row.json.type === 'ai-title' && row.json.aiTitle) aiTitle = row.json.aiTitle
      if (!cwd && row.json.cwd) cwd = row.json.cwd
      if (!model && row.json.type === 'assistant' && row.json.message) {
        const candidate = row.json.message.model
        // Skip Claude Code's `<synthetic>` placeholder used for injected turns.
        if (candidate && candidate !== '<synthetic>') model = candidate
      }
      if (!firstUserText && row.json.type === 'user') firstUserText = contentText(row.json.message && row.json.message.content)
    }
    const rowEvents = rowToEvents({ row, file })
    for (const event of rowEvents) {
      if (event.at && !firstAt) firstAt = event.at
      events.push(event)
    }
  }
  sessionId = sessionId || fallbackSessionIdFromFile(file)
  const title = titleForSession({ sessionId, firstUserText, aiTitle, customTitle })
  return createSessionIR({
    source: {
      kind: 'claude-jsonl',
      path: file,
      size: stat.size,
      mtime: stat.mtime.toISOString()
    },
    session: {
      id: sessionId,
      title,
      startedAt: firstAt,
      updatedAt: stat.mtime.toISOString(),
      cwd,
      agent: 'claude',
      model,
      modelFamily: normalizeModelFamily(model)
    },
    events
  })
}

module.exports = {
  DEFAULT_SESSION_INDEX,
  DEFAULT_SESSIONS_ROOT,
  claudeSessionFiles,
  importClaudeJsonl,
  latestClaudeSessionFile,
  resolveCurrentClaudeSessionFile,
  scoreClaudeSessionFile
}
