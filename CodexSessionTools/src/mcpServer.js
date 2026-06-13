const crypto = require('node:crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const { connectOrStartCodexSessionServer } = require('./client.js')
const { defaultCodexSessionRoot } = require('./index.js')
const { renderForTool, shortenMiddle } = require('./render.js')

const MARKER_PREFIXES = {
  'codex-session': /codex-session-[0-9a-fA-F-]{36}/g,
  'agentdoc-session': /agentdoc-session-[0-9a-fA-F-]{36}/g,
  'conversation_history-session': /conversation_history-session-[0-9a-fA-F-]{36}/g
}

const compactSession = item => item
  ? {
      file: item.file,
      mtime_ms: item.mtimeMs,
      size: item.size
    }
  : null

const summarizeStatus = result => ({
  schema: 'codex-session-tools.status.v1',
  status: 'ok',
  session_root: result.session_root,
  session_count: result.session_count,
  thread_spawn_edge_count: result.thread_spawn_edge_count,
  app_server: result.app_server,
  latest_session: compactSession(result.latest_session)
})

const summarizeResolve = result => {
  if (!result) {
    return {
      schema: 'codex-session-tools.resolve.v1',
      ok: false,
      status: 'blocked',
      reason: 'not_found'
    }
  }
  return {
    schema: 'codex-session-tools.resolve.v1',
    ok: result.ok !== false,
    status: result.status || (result.file ? 'resolved' : 'blocked'),
    reason: result.reason,
    codex_session_id: result.codex_session_id || result.thread_id || result.session_id,
    file: result.file,
    warning: result.warning
  }
}

const summarizeMarker = result => result
  ? {
      schema: 'codex-session-tools.latest-marker.v1',
      status: 'hint',
      ok: true,
      binding_proof: false,
      current_session_proof: false,
      warning: 'not_current_session_binding',
      instruction: 'Use codex_session_start_binding, then codex_session_resolve_marker with that marker, to prove the current model run is bound.',
      marker: result.marker,
      file: result.file,
      byte_offset: result.byteOffset,
      mtime_ms: result.mtimeMs
    }
  : {
      schema: 'codex-session-tools.latest-marker.v1',
      ok: false,
      status: 'blocked',
      binding_proof: false,
      current_session_proof: false,
      reason: 'not_found'
    }

const summarizeAppServer = result => ({
  schema: 'codex-session-tools.app-server-status.v1',
  ok: result.ok !== false,
  status: result.status || (result.ok === false ? 'degraded' : 'resolved'),
  reason: result.reason,
  thread_count: Array.isArray(result.result && result.result.data) ? result.result.data.length : undefined
})

const toolResult = (toolName, result) => ({
  content: [{
    type: 'text',
    text: renderForTool(toolName, result)
  }],
  structuredContent: {
    result
  }
})

const bindingMarker = () => `codex-session-${crypto.randomUUID()}`

const markerPatternFor = prefix => MARKER_PREFIXES[prefix] || MARKER_PREFIXES['codex-session']

const registerTools = (server, clientFactory) => {
  let clientPromise = null
  const client = async () => {
    if (!clientPromise) clientPromise = Promise.resolve(clientFactory())
    return clientPromise
  }

  server.registerTool('codex_session_start_binding', {
    title: 'Start Codex Session Binding',
    description: 'Create a marker recorded in the current Codex transcript. Pass it to codex_session_resolve_marker to bind this model run to a session.',
    inputSchema: {}
  }, async () => {
    const marker = bindingMarker()
    return toolResult('codex_session_health', {
      schema: 'codex-session-tools.binding.v1',
      status: 'ok',
      codex_session_marker: marker
    })
  })

  server.registerTool('codex_session_status', {
    title: 'Codex Session Status',
    description: 'Return compact status for the shared Codex session authority.',
    inputSchema: {
      refresh: z.boolean().optional().describe('Refresh the shared session snapshot before returning status.')
    }
  }, async args => {
    const codexClient = await client()
    const result = args.refresh ? await codexClient.refresh('mcp:status') : await codexClient.status()
    return toolResult('codex_session_status', summarizeStatus(result))
  })

  server.registerTool('codex_session_resolve_marker', {
    title: 'Resolve Codex Session Marker',
    description: 'Resolve a marker to a fork-aware Codex session entry. Returns handles, not transcript text.',
    inputSchema: {
      marker: z.string().describe('Marker previously returned by codex_session_start_binding or another AgentTools binding tool.')
    }
  }, async args => toolResult(
    'codex_session_resolve_current',
    summarizeResolve(await (await client()).resolveMarker({ marker: args.marker }))
  ))

  server.registerTool('codex_session_latest_marker', {
    title: 'Latest Codex Session Marker',
    description: 'Find a recent marker hint for a known AgentTools marker family. This is not evidence that the current model run is bound. To prove current-session binding, call codex_session_start_binding and then codex_session_resolve_marker with that fresh marker.',
    inputSchema: {
      marker_prefix: z.enum(['codex-session', 'agentdoc-session', 'conversation_history-session']).optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  }, async args => toolResult(
    'codex_session_latest_marker',
    summarizeMarker(await (await client()).latestMarker({
      pattern: markerPatternFor(args.marker_prefix || 'codex-session'),
      limit: args.limit || 50
    }))
  ))

  server.registerTool('codex_session_app_server_status', {
    title: 'Codex App Server Status',
    description: 'Check whether codex app-server can answer a small thread-list request. Does not return thread payloads.',
    inputSchema: {}
  }, async () => toolResult(
    'codex_session_health',
    summarizeAppServer(await (await client()).appServerThreadList({ limit: 1, useStateDbOnly: true }))
  ))

  server.registerTool('codex_session_diagnostics', {
    title: 'Codex Session Diagnostics',
    description: 'Read a capped compact diagnostics page from the shared Codex session authority.',
    inputSchema: {
      limit: z.number().int().positive().max(20).optional(),
      cursor: z.string().optional()
    }
  }, async args => toolResult(
    'codex_session_diagnostics',
    await (await client()).diagnostics({ kind: 'events', limit: args.limit || 10, cursor: args.cursor })
  ))
}

const createMcpServer = ({
  clientFactory = () => connectOrStartCodexSessionServer({
    sessionRoot: process.env.CODEX_SESSION_TOOLS_SESSION_ROOT || defaultCodexSessionRoot()
  })
} = {}) => {
  const server = new McpServer({
    name: 'codex-session-tools',
    version: '0.1.0'
  })
  registerTools(server, clientFactory)
  return server
}

const startStdioServer = async options => {
  const server = createMcpServer(options)
  await server.connect(new StdioServerTransport())
}

module.exports = {
  createMcpServer,
  registerTools,
  startStdioServer,
  summarizeResolve,
  summarizeStatus
}
