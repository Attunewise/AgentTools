const shortenMiddle = (value, max = 96) => {
  const text = String(value || '')
  if (text.length <= max) return text
  const side = Math.floor((max - 3) / 2)
  return `${text.slice(0, side)}...${text.slice(-side)}`
}

const compactThreadId = value => String(value || '').slice(0, 8)

const oneLine = parts => parts.filter(Boolean).join(' ')

const renderStatus = result => oneLine([
  result && result.ok === false ? 'blocked' : 'ok',
  result && result.status ? `status=${result.status}` : null,
  result && result.session_count !== undefined ? `sessions=${result.session_count}` : null,
  result && result.thread_spawn_edge_count !== undefined ? `fork_edges=${result.thread_spawn_edge_count}` : null,
  result && result.app_server && result.app_server.available !== undefined ? `app_server=${result.app_server.available ? 'up' : 'down'}` : null
])

const renderSessionResolve = result => {
  if (!result) return 'blocked reason=not_found'
  if (result.ok === false || result.status === 'blocked') return oneLine([
    'blocked',
    result.reason ? `reason=${result.reason}` : null
  ])
  return oneLine([
    result.status === 'degraded' ? 'degraded' : 'ok',
    result.codex_session_id ? `thread=${compactThreadId(result.codex_session_id)}` : null,
    result.file ? `file=${shortenMiddle(result.file, 80)}` : null,
    result.reason ? `reason=${result.reason}` : null,
    result.warning ? `warn=${result.warning}` : null
  ])
}

const renderHealth = result => oneLine([
  result && result.ok === false ? 'degraded' : 'ok',
  result && result.status ? `status=${result.status}` : null,
  result && result.warnings ? `warnings=${result.warnings.length}` : null
])

const renderDiagnosticsPage = result => {
  const events = Array.isArray(result && result.events) ? result.events : []
  const lines = [`events: ${events.length}`]
  for (const event of events.slice(0, 10)) {
    lines.push(`- ${event.code || event.reason || 'event'}${event.status ? ` ${event.status}` : ''}`)
  }
  if (result && result.next_cursor) lines.push(`next: ${result.next_cursor}`)
  return lines.join('\n')
}

const renderForTool = (toolName, result) => {
  if (toolName === 'codex_session_status') return renderStatus(result)
  if (toolName === 'codex_session_resolve_current') return renderSessionResolve(result)
  if (toolName === 'codex_session_health') return renderHealth(result)
  if (toolName === 'codex_session_diagnostics') return renderDiagnosticsPage(result)
  if (toolName === 'agentdoc_binding') return renderSessionResolve(result)
  return renderHealth(result)
}

const toolResult = (toolName, result) => ({
  content: [{
    type: 'text',
    text: renderForTool(toolName, result)
  }],
  structuredContent: {
    result
  }
})

module.exports = {
  compactThreadId,
  renderDiagnosticsPage,
  renderForTool,
  renderHealth,
  renderSessionResolve,
  renderStatus,
  shortenMiddle,
  toolResult
}
