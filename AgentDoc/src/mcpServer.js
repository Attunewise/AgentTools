const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const { AgentDocServerState } = require('./server.js')
const { createMcpLogger, installMcpProcessLogging } = require('./mcpLog.js')

const shorten = (value, max = 88) => {
  const text = String(value || '')
  return text.length <= max ? text : `...${text.slice(-(max - 3))}`
}

const repositorySummary = repo => {
  if (!repo) return {}
  return {
    repo: repo.root,
    staged: repo.git && repo.git.staged_file_count,
    docs: repo.docs && repo.docs.section_count,
    stamp: repo.stamp && repo.stamp.status && repo.stamp.status.status,
    linked: repo.git && repo.git.is_linked_worktree
  }
}

const summarizeResult = result => {
  const schema = result && result.schema || 'agentdoc.result.v1'
  if (schema === 'agentdoc.server-state.v1') {
    return {
      schema,
      status: 'ok',
      sessions: Array.isArray(result.sessions) ? result.sessions.length : 0,
      watched: Array.isArray(result.watched_repositories) ? result.watched_repositories.length : 0
    }
  }
  if (schema === 'agentdoc.start-session.v1') {
    return {
      schema,
      status: 'ok',
      agentdoc_session_id: result.agentdoc_session_id
    }
  }
  if (schema === 'agentdoc.gate-status.v1') {
    return {
      schema,
      status: result.allowed ? 'allowed' : 'blocked',
      allowed: result.allowed,
      reason: result.reason,
      ...repositorySummary(result.repository)
    }
  }
  return {
    schema,
    status: result && result.message && /blocked|required|stale|invalid/i.test(result.message) ? 'blocked' : 'ok',
    message: result && result.message ? String(result.message).split(/\r?\n/)[0] : undefined,
    ...repositorySummary(result && result.repository)
  }
}

const renderSummary = summary => {
  const bits = [
    summary.status === 'blocked' ? 'blocked' : 'ok',
    summary.allowed === false ? 'allowed=0' : summary.allowed === true ? 'allowed=1' : null,
    summary.reason ? `reason=${summary.reason}` : null,
    summary.repo ? `repo=${shorten(summary.repo)}` : null,
    summary.agentdoc_session_id ? `session=${summary.agentdoc_session_id}` : null,
    summary.staged !== undefined ? `staged=${summary.staged}` : null,
    summary.docs !== undefined ? `docs=${summary.docs}` : null,
    summary.stamp ? `stamp=${summary.stamp}` : null,
    summary.linked ? 'linked=1' : null,
    summary.sessions !== undefined ? `sessions=${summary.sessions}` : null,
    summary.watched !== undefined ? `watched=${summary.watched}` : null
  ].filter(Boolean)
  return bits.join(' ')
}

const toolResult = result => {
  const summary = summarizeResult(result)
  return {
    content: [{
      type: 'text',
      text: renderSummary(summary)
    }],
    structuredContent: {
      result: summary
    }
  }
}

const sessionScopedShape = {
  agentdoc_session_id: z.string().optional().describe('AgentDoc session id returned by agentdoc_start_session. Omit only when there is exactly one active AgentDoc session.'),
  workdir: z.string().optional().describe('Explicit repository/worktree override. Normally omit so AgentDoc resolves it from the Codex session.')
}

const registerTools = (server, state) => {
  const readyState = async () => {
    await state.start()
    return state
  }

  server.registerTool('agentdoc_start_session', {
    title: 'Start AgentDoc Session',
    description: 'Start AgentDoc for this Codex session. Returns a generated id/marker that AgentDoc uses to bind to the recorded Codex session log.',
    inputSchema: {}
  }, async () => toolResult(await (await readyState()).startAgentDocSession()))

  server.registerTool('agentdoc_status', {
    title: 'AgentDoc Status',
    description: 'Return bounded AgentDoc server state, including AgentDoc sessions, Codex session binding, and watched repositories.',
    inputSchema: {
      refresh: z.boolean().optional().describe('Refresh live state before returning it.')
    }
  }, async args => {
    const current = await readyState()
    const snapshot = args.refresh ? await current.refresh('mcp:status') : await current.getSnapshot()
    return toolResult(snapshot)
  })

  server.registerTool('agentdoc_prepare_review', {
    title: 'Prepare AgentDoc Review',
    description: 'Prepare a bounded staged-change documentation review file. This does not stamp the check.',
    inputSchema: sessionScopedShape
  }, async args => {
    const current = await readyState()
    const result = await current.prepareReview(args)
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
    const current = await readyState()
    const result = await current.recordCheck({
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
  }, async args => toolResult(await (await readyState()).gateStatus(args)))

  server.registerTool('agentdoc_direct_status', {
    title: 'AgentDoc Repository Status',
    description: 'Return bounded status for the repository/worktree resolved from the AgentDoc session.',
    inputSchema: sessionScopedShape
  }, async args => {
    const current = await readyState()
    const root = await current.resolveWorkdir(args)
    return toolResult({
      schema: 'agentdoc.repository-status.v1',
      repository: current.repoSnapshot(root)
    })
  })

  server.registerTool('agentdoc_install_hook', {
    title: 'Install AgentDoc Hook',
    description: 'Install the tiny pre-commit hook verifier for this repository.',
    inputSchema: sessionScopedShape
  }, async args => toolResult({
    schema: 'agentdoc.install-hook.v1',
    ...(await (await readyState()).installHook(args))
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
  const logger = createMcpLogger('agentdoc')
  installMcpProcessLogging(logger)
  logger.info('start', {
    cwd: process.cwd(),
    node: process.version,
    execPath: process.execPath,
    log: logger.file
  })
  const state = new AgentDocServerState(options)
  const shutdown = async () => {
    logger.info('shutdown')
    await state.stop()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  const server = createMcpServer({ state })
  try {
    await server.connect(new StdioServerTransport())
    logger.info('connected')
  } catch (err) {
    logger.error('startup_error', err)
    throw err
  }
}

module.exports = {
  createMcpServer,
  registerTools,
  startStdioServer
}
