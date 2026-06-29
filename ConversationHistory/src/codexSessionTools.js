const missingRequestedModule = (err, request) => err &&
  err.code === 'MODULE_NOT_FOUND' &&
  typeof err.message === 'string' &&
  err.message.includes(`'${request}'`)

const requireWithVendorFallback = (request, fallback) => {
  try {
    return require(request)
  } catch (err) {
    if (!missingRequestedModule(err, request)) throw err
    return require(fallback)
  }
}

const loadCodexSessionTools = () => requireWithVendorFallback(
  'codex-session-tools',
  '../vendor/CodexSessionTools'
)

const loadCodexSessionToolsClient = () => requireWithVendorFallback(
  'codex-session-tools/src/client.js',
  '../vendor/CodexSessionTools/src/client.js'
)

module.exports = {
  loadCodexSessionTools,
  loadCodexSessionToolsClient
}
