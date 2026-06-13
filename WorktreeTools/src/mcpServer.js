const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const {
  renderWorktreeCompact,
  safeSnapshotWorktree
} = require('./index.js')

const shortenMiddle = (value, max = 96) => {
  const text = String(value || '')
  if (text.length <= max) return text
  const side = Math.floor((max - 3) / 2)
  return `${text.slice(0, side)}...${text.slice(-side)}`
}

const summarizeSnapshot = result => {
  if (!result || result.ok === false) {
    return {
      schema: 'worktree-tools.entrypoint.v1',
      ok: false,
      status: result && result.status || 'blocked',
      reason: result && result.reason || 'not_git_repo'
    }
  }
  const snapshot = result.snapshot
  return {
    schema: 'worktree-tools.entrypoint.v1',
    ok: true,
    status: 'resolved',
    repo: snapshot.root,
    branch: snapshot.branch,
    upstream: snapshot.upstream,
    linked_worktree: snapshot.is_linked_worktree,
    staged_change_fingerprint: snapshot.staged_change_fingerprint,
    staged_file_count: snapshot.staged_file_count,
    staged_files: (snapshot.staged_files || []).slice(0, 20),
    staged_files_omitted: Math.max(0, Number(snapshot.staged_file_count || 0) - 20),
    dirty: snapshot.status && snapshot.status.dirty,
    unstaged: snapshot.status && snapshot.status.unstaged,
    untracked: snapshot.status && snapshot.status.untracked
  }
}

const renderSummary = result => {
  if (!result || result.ok === false) return `blocked reason=${result && result.reason || 'not_git_repo'}`
  const bits = [
    'ok',
    `repo=${shortenMiddle(result.repo, 80)}`,
    result.branch ? `branch=${result.branch}` : 'branch=detached',
    `staged=${result.staged_file_count}`,
    `dirty=${result.dirty}`,
    result.linked_worktree ? 'linked=1' : null,
    result.staged_change_fingerprint ? `fingerprint=${shortenMiddle(result.staged_change_fingerprint, 28)}` : null
  ].filter(Boolean)
  return bits.join(' ')
}

const toolResult = result => ({
  content: [{
    type: 'text',
    text: renderSummary(result)
  }],
  structuredContent: {
    result
  }
})

const registerTools = server => {
  server.registerTool('worktree_status', {
    title: 'Worktree Status',
    description: 'Return compact canonical repository/worktree identity and staged-state handles. Does not return diffs or raw git porcelain.',
    inputSchema: {
      workdir: z.string().optional().describe('Path inside the target repository/worktree. Defaults to the MCP server working directory.')
    }
  }, async args => toolResult(summarizeSnapshot(safeSnapshotWorktree(args.workdir || process.cwd()))))

  server.registerTool('worktree_staged_fingerprint', {
    title: 'Worktree Staged Fingerprint',
    description: 'Return the staged fingerprint and capped staged path summary for the resolved worktree.',
    inputSchema: {
      workdir: z.string().optional().describe('Path inside the target repository/worktree. Defaults to the MCP server working directory.')
    }
  }, async args => {
    const summary = summarizeSnapshot(safeSnapshotWorktree(args.workdir || process.cwd()))
    return toolResult(summary.ok === false
      ? summary
      : {
          schema: 'worktree-tools.staged-entrypoint.v1',
          ok: true,
          status: 'resolved',
          repo: summary.repo,
          staged_change_fingerprint: summary.staged_change_fingerprint,
          staged_file_count: summary.staged_file_count,
          staged_files: summary.staged_files,
          staged_files_omitted: summary.staged_files_omitted
        })
  })
}

const createMcpServer = () => {
  const server = new McpServer({
    name: 'worktree-tools',
    version: '0.1.0'
  })
  registerTools(server)
  return server
}

const startStdioServer = async () => {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())
}

module.exports = {
  createMcpServer,
  registerTools,
  renderSummary,
  startStdioServer,
  summarizeSnapshot
}
