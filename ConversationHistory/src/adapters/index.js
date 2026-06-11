const {
  DEFAULT_SESSION_INDEX,
  DEFAULT_SESSIONS_ROOT,
  codexSessionFiles,
  codexSessionFingerprint,
  importCodexJsonl,
  latestCodexSessionFile,
  resolveCurrentCodexSessionFile
} = require('./codex.js')
const {
  DEFAULT_SESSION_INDEX: CLAUDE_DEFAULT_SESSION_INDEX,
  DEFAULT_SESSIONS_ROOT: CLAUDE_DEFAULT_SESSIONS_ROOT,
  claudeSessionFiles,
  importClaudeJsonl,
  latestClaudeSessionFile,
  resolveCurrentClaudeSessionFile
} = require('./claude.js')

const adapters = {
  codex: {
    name: 'codex',
    defaultRoot: DEFAULT_SESSIONS_ROOT,
    defaultSessionIndex: DEFAULT_SESSION_INDEX,
    files: codexSessionFiles,
    sourceFingerprint: codexSessionFingerprint,
    latestFile: latestCodexSessionFile,
    resolveCurrentSessionFile: resolveCurrentCodexSessionFile,
    importFile: importCodexJsonl
  },
  claude: {
    name: 'claude',
    defaultRoot: CLAUDE_DEFAULT_SESSIONS_ROOT,
    defaultSessionIndex: CLAUDE_DEFAULT_SESSION_INDEX,
    files: claudeSessionFiles,
    latestFile: latestClaudeSessionFile,
    resolveCurrentSessionFile: resolveCurrentClaudeSessionFile,
    importFile: importClaudeJsonl
  }
}

const adapterFor = source => {
  const adapter = adapters[source || 'codex']
  if (!adapter) throw new Error(`unknown source adapter: ${source}`)
  return adapter
}

module.exports = {
  adapterFor,
  adapters
}
