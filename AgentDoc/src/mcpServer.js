const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const { AgentDocServerState } = require('./server.js')

const toolResult = result => ({
  content: [{
    type: 'text',
    text: JSON.stringify(result, null, 2)
  }],
  structuredContent: {
    result
  }
})

const sessionScopedShape = {
  agentdoc_session_id: z.string().optional().describe('AgentDoc session id returned by agentdoc_start_session. Omit only when there is exactly one active AgentDoc session.'),
  workdir: z.string().optional().describe('Explicit repository/worktree override. Normally omit so AgentDoc resolves it from the Codex session.')
}

const registerTools = (server, state) => {
  server.registerTool('agentdoc_start_session', {
    title: 'Start AgentDoc Session',
    description: 'Start AgentDoc for this Codex session. Returns a generated id/marker that AgentDoc uses to bind to the recorded Codex session log.',
    inputSchema: {}
  }, async () => toolResult(state.startAgentDocSession()))

  server.registerTool('agentdoc_status', {
    title: 'AgentDoc Status',
    description: 'Return bounded AgentDoc server state, including AgentDoc sessions, Codex session binding, and watched repositories.',
    inputSchema: {
      refresh: z.boolean().optional().describe('Refresh live state before returning it.')
    }
  }, async args => {
    const snapshot = args.refresh ? state.refresh('mcp:status') : state.getSnapshot()
    return toolResult(snapshot)
  })

  server.registerTool('agentdoc_prepare_review', {
    title: 'Prepare AgentDoc Review',
    description: 'Prepare a bounded staged-change documentation review file. This does not stamp the check.',
    inputSchema: sessionScopedShape
  }, async args => {
    const result = state.prepareReview(args)
    return toolResult({
      schema: 'agentdoc.prepare.v1',
      message: result.message,
      repository: result.repository
    })
  })

  server.registerTool('agentdoc_record_check', {
    title: 'Record AgentDoc Check',
    description: 'Stamp the exact staged fingerprint after the agent has inspected or updated relevant docs.',
    inputSchema: {
      result: z.enum(['docs-current', 'docs-updated', 'needs-doc-update', 'blocked']),
      reviewed: z.array(z.string()).optional().describe('Doc section paths reviewed during this check.'),
      updated: z.array(z.string()).optional().describe('Doc section paths updated during this check.'),
      no_docs_needed: z.boolean().optional().describe('Use only when no doc section was applicable after review.'),
      note: z.string().optional().describe('Short bounded note.'),
      ...sessionScopedShape
    }
  }, async args => {
    const result = state.recordCheck({
      result: args.result,
      reviewed: args.reviewed || [],
      updated: args.updated || [],
      noDocsNeeded: Boolean(args.no_docs_needed),
      note: args.note,
      agentdoc_session_id: args.agentdoc_session_id,
      workdir: args.workdir
    })
    return toolResult({
      schema: 'agentdoc.check.v1',
      message: result.message,
      repository: result.repository
    })
  })

  server.registerTool('agentdoc_gate_status', {
    title: 'AgentDoc Gate Status',
    description: 'Check whether the current staged state has a valid AgentDoc stamp without printing hook text.',
    inputSchema: sessionScopedShape
  }, async args => toolResult(state.gateStatus(args)))

  server.registerTool('agentdoc_direct_status', {
    title: 'AgentDoc Repository Status',
    description: 'Return bounded status for the repository/worktree resolved from the AgentDoc session.',
    inputSchema: sessionScopedShape
  }, async args => {
    const root = state.resolveWorkdir(args)
    return toolResult({
      schema: 'agentdoc.repository-status.v1',
      repository: state.repoSnapshot(root)
    })
  })

  server.registerTool('agentdoc_install_hook', {
    title: 'Install AgentDoc Hook',
    description: 'Install the tiny pre-commit hook verifier for this repository.',
    inputSchema: sessionScopedShape
  }, async args => toolResult({
    schema: 'agentdoc.install-hook.v1',
    ...state.installHook(args)
  }))
}

const createMcpServer = ({ state = new AgentDocServerState() } = {}) => {
  const server = new McpServer({
    name: 'agentdoc',
    version: '0.1.0'
  })
  registerTools(server, state)
  return server
}

const startStdioServer = async (options = {}) => {
  const state = new AgentDocServerState(options)
  await state.start()
  const shutdown = async () => {
    await state.stop()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  const server = createMcpServer({ state })
  await server.connect(new StdioServerTransport())
}

module.exports = {
  createMcpServer,
  registerTools,
  startStdioServer
}
