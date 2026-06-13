const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  analyzeCodexSessionFile,
  findCodexSessionsContainingMarker,
  fileContainsLiteral,
  latestCodexSessionFile,
  walkJsonlFiles
} = require('../src/index.js')

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

test('literal marker scan checks the tail first and falls back to the full file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-tools-literal-'))
  try {
    const file = path.join(root, 'session.jsonl')
    const marker = 'conversation_history-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    fs.writeFileSync(file, `${marker}\n${'x'.repeat(512 * 1024)}\n`)

    const match = fileContainsLiteral({
      file,
      literal: marker,
      tailBytes: 128
    })
    assert.equal(match.scan, 'full')
    assert.equal(match.byteOffset, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
