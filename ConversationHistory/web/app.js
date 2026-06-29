const state = {
  sessions: [],
  selectedSession: null,
  selectedHandle: '',
  browseHandle: '',
  browseHistory: [],
  agent: 'codex'
}

const $ = id => document.getElementById(id)
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const api = async (path, params = {}) => {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
  }
  const response = await fetch(url)
  const json = await response.json()
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`)
  return json
}

const text = value => value === undefined || value === null || value === '' ? '' : String(value)

const shortId = value => {
  const raw = text(value)
  return raw.length > 14 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw
}

const summaryLevel = handle => {
  const match = String(handle || '').match(/\/summary\/level-(\d+)\//)
  return match ? Number(match[1]) : 0
}

const rowLabel = item => {
  if (!item) return 'Result'
  if (summaryLevel(item.handle)) return `Summary level ${summaryLevel(item.handle)}`
  if (item.openable) return item.line ? `Message at line ${item.line}` : 'Message'
  if (item.child_count) return 'Conversation section'
  return 'Record'
}

const rowActionLabel = item => item && item.child_count > 0
  ? item.openable
    ? `Open ${rowLabel(item)}`
    : `Browse ${rowLabel(item)}`
  : item && item.openable
    ? `Open ${rowLabel(item)}`
    : `Select ${rowLabel(item)}`

const previewText = (value, limit = 1200) => {
  const raw = text(value).trim()
  return raw.length > limit ? `${raw.slice(0, limit).trimEnd()}...` : raw
}

const appendInlineMarkdown = (node, value) => {
  const parts = String(value || '').split(/(`[^`]*`|\*\*[^*]+\*\*)/g)
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      const code = document.createElement('code')
      code.textContent = part.slice(1, -1)
      node.append(code)
    } else if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      const strong = document.createElement('strong')
      strong.textContent = part.slice(2, -2)
      node.append(strong)
    } else {
      node.append(document.createTextNode(part))
    }
  }
}

const renderMarkdown = (node, value) => {
  node.textContent = ''
  node.classList.add('markdownBody')
  const raw = text(value).trim()
  if (!raw) return

  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let paragraph = []
  let list = null
  let listTag = ''
  let codeLines = null

  const closeList = () => {
    list = null
    listTag = ''
  }

  const flushParagraph = () => {
    if (!paragraph.length) return
    const p = document.createElement('p')
    appendInlineMarkdown(p, paragraph.join(' '))
    node.append(p)
    paragraph = []
  }

  const ensureList = tag => {
    if (list && listTag === tag) return list
    closeList()
    listTag = tag
    list = document.createElement(tag)
    node.append(list)
    return list
  }

  const appendCodeBlock = lines => {
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = lines.join('\n')
    pre.append(code)
    node.append(pre)
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const fence = /^```/.test(trimmed)
    if (codeLines) {
      if (fence) {
        appendCodeBlock(codeLines)
        codeLines = null
      } else {
        codeLines.push(line)
      }
      continue
    }
    if (fence) {
      flushParagraph()
      closeList()
      codeLines = []
      continue
    }
    if (!trimmed) {
      flushParagraph()
      closeList()
      continue
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      closeList()
      const div = document.createElement('div')
      div.className = `mdHeading mdH${heading[1].length}`
      appendInlineMarkdown(div, heading[2])
      node.append(div)
      continue
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/)
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/)
    if (unordered || ordered) {
      flushParagraph()
      const li = document.createElement('li')
      appendInlineMarkdown(li, (unordered || ordered)[1])
      ensureList(unordered ? 'ul' : 'ol').append(li)
      continue
    }

    closeList()
    paragraph.push(trimmed)
  }

  if (codeLines) appendCodeBlock(codeLines)
  flushParagraph()
}

const browseLocationLabel = result => {
  if (!result || !result.handle) return 'Conversation'
  if (/\/summary\//.test(result.handle)) {
    const level = summaryLevel(result.handle)
    return level ? `Summary level ${level}` : 'Summary'
  }
  if (/\/event\//.test(result.handle)) return 'Source record'
  return 'Conversation'
}

const setError = (node, err) => {
  node.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'error'
  div.textContent = err && err.message ? err.message : String(err)
  node.append(div)
}

const setEmpty = (node, message) => {
  node.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'empty'
  div.textContent = message
  node.append(div)
}

const pill = (value, kind = '') => {
  const span = document.createElement('span')
  span.className = `pill ${kind}`.trim()
  span.textContent = value
  return span
}

const rowMeta = values => {
  const meta = document.createElement('div')
  meta.className = 'rowMeta'
  for (const value of values.filter(Boolean)) {
    const span = document.createElement('span')
    span.textContent = value
    meta.append(span)
  }
  return meta
}

const renderHealth = async () => {
  try {
    const health = await api('/api/health')
    $('health').textContent = `${health.indexDir} · ${health.managed && health.managed.running ? 'Typesense running' : 'Typesense not running'}`
  } catch (err) {
    $('health').textContent = err.message
  }
}

const renderSessions = () => {
  const list = $('sessionList')
  list.innerHTML = ''
  if (!state.sessions.length) {
    setEmpty(list, 'No indexed sessions')
    return
  }
  for (const session of state.sessions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `sessionRow ${state.selectedSession && state.selectedSession.session_id === session.session_id ? 'active' : ''}`.trim()
    const title = document.createElement('div')
    title.className = 'rowTitle'
    title.textContent = session.title || session.session_id
    const meta = rowMeta([
      session.last_modified_ago || session.last_modified_at,
      session.pending_compaction_count ? 'summaries pending' : 'summaries ready'
    ])
    const summary = document.createElement('div')
    summary.className = 'rowText'
    renderMarkdown(summary, session.short_summary || session.session_id)
    button.append(title, meta, summary)
    button.addEventListener('click', () => selectSession(session))
    list.append(button)
  }
}

const loadSessions = async () => {
  const list = $('sessionList')
  setEmpty(list, 'Loading')
  try {
    const result = await api('/api/sessions', {
      agent: state.agent,
      q: $('sessionQuery').value,
      start: 0,
      limit: 80
    })
    state.sessions = result.sessions || []
    if (state.selectedSession && !state.sessions.some(session => session.session_id === state.selectedSession.session_id)) {
      state.selectedSession = null
    }
    if (!state.selectedSession && state.sessions.length) {
      state.selectedSession = state.sessions[0]
      await selectSession(state.selectedSession, { skipRender: true })
    }
    renderSessions()
    renderSessionHeader()
  } catch (err) {
    setError(list, err)
  }
}

const renderSessionHeader = async () => {
  const session = state.selectedSession
  $('sessionTitle').textContent = session ? (session.title || session.session_id) : 'Select an indexed session'
  renderMarkdown($('sessionMeta'), session ? (session.short_summary || '') : '')
  const stats = $('sessionStats')
  stats.innerHTML = ''
  if (!session) return
  stats.append(
    pill(session.pending_compaction_count ? 'summaries pending' : 'summaries ready', session.pending_compaction_count ? 'warn' : 'good')
  )
  try {
    const status = await api('/api/status', { session_id: session.session_id, limit: 1 })
    const current = status.sessions && status.sessions[0]
    if (current && current.state && !['not-started', 'ready'].includes(current.state)) {
      stats.append(pill(current.state, 'warn'))
    }
  } catch (_err) {}
}

const selectSession = async (session, opts = {}) => {
  state.selectedSession = session
  state.selectedHandle = ''
  state.browseHandle = ''
  state.browseHistory = []
  $('sourceView').textContent = ''
  $('openMeta').textContent = ''
  if (!opts.skipRender) {
    renderSessions()
    await renderSessionHeader()
  }
  const initialHandle = browseHandleFromHash()
  const browsed = await browse({ handle: initialHandle || '', zoom: 'children' }, { pushHistory: false, pushBrowser: false })
  if (!browsed && initialHandle) await browseRoot({ pushHistory: false, pushBrowser: false })
  replaceBrowseState(state.browseHandle)
  await runSearch()
}

const scoped = extra => ({
  agent: state.agent,
  session_id: state.selectedSession && state.selectedSession.session_id,
  index_id: state.selectedSession && state.selectedSession.index_id,
  ...extra
})

const browseUrlForHandle = handle => {
  const url = new URL(window.location.href)
  if (handle) url.hash = `browse=${encodeURIComponent(handle)}`
  else url.hash = ''
  return url
}

const browseHandleFromHash = () => {
  const raw = window.location.hash.replace(/^#/, '')
  if (!raw.startsWith('browse=')) return ''
  try {
    return decodeURIComponent(raw.slice('browse='.length))
  } catch (_err) {
    return ''
  }
}

const pushBrowseState = handle => {
  window.history.pushState({ browseHandle: handle || '' }, '', browseUrlForHandle(handle || ''))
}

const replaceBrowseState = handle => {
  window.history.replaceState({ browseHandle: handle || '' }, '', browseUrlForHandle(handle || ''))
}

const updateBrowseNav = () => {
  $('backBrowse').disabled = state.browseHistory.length === 0
}

const browse = async (extra = {}, opts = {}) => {
  const container = $('browseResults')
  if (!state.selectedSession) {
    setEmpty(container, 'No session selected')
    return
  }
  const requestedHandle = hasOwn(extra, 'handle') ? extra.handle : state.browseHandle
  const previousHandle = browseHandleFromHash() || state.browseHandle
  setEmpty(container, 'Loading')
  try {
    const result = await api('/api/browse', scoped({
      handle: requestedHandle,
      zoom: extra.zoom || 'children',
      start: extra.start || 0,
      limit: 80
    }))
    state.browseHandle = result.handle || ''
    if (opts.pushHistory !== false && previousHandle && previousHandle !== state.browseHandle) {
      state.browseHistory.push(previousHandle)
    }
    if (opts.pushBrowser !== false && previousHandle !== state.browseHandle) {
      pushBrowseState(state.browseHandle)
    }
    $('browseTrail').textContent = browseLocationLabel(result)
    renderMarkdown($('browseSummaryText'), result.text || 'No summary recorded for this node.')
    $('browseCount').textContent = result.page ? `${result.page.returned}/${result.page.total}` : ''
    renderBrowseRows(result.children || [])
    updateBrowseNav()
    return result
  } catch (err) {
    $('browseSummaryText').textContent = ''
    setError(container, err)
    updateBrowseNav()
  }
}

const browseRoot = (opts = {}) => browse({ handle: '', zoom: 'children' }, opts)

const browseBack = async () => {
  const handle = state.browseHistory.pop()
  updateBrowseNav()
  if (!handle) return
  await browse({ handle, zoom: 'children' }, { pushHistory: false, pushBrowser: false })
  replaceBrowseState(state.browseHandle)
}

const renderBrowseRows = rows => {
  const container = $('browseResults')
  container.innerHTML = ''
  if (!rows.length) {
    setEmpty(container, 'No children')
    return
  }
  for (const item of rows) {
    const button = resultButton(item)
    button.addEventListener('click', async () => {
      state.selectedHandle = item.handle
      if (item.openable) await openHandle(item.handle)
      else if (item.child_count > 0) await browse({ handle: item.handle, zoom: 'children' })
    })
    container.append(button)
  }
}

const resultButton = item => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `resultRow ${state.selectedHandle === item.handle ? 'active' : ''}`.trim()
  button.setAttribute('aria-label', rowActionLabel(item))
  button.title = item.handle || ''
  const title = document.createElement('div')
  title.className = 'rowTitle'
  title.textContent = rowLabel(item)
  const meta = rowMeta([
    item.index ? `${item.index}` : '',
    item.openable ? 'source' : '',
    item.child_count ? `${item.child_count} child nodes` : '',
    item.score ? `score ${item.score}` : ''
  ])
  const body = document.createElement('div')
  body.className = 'rowText compactMarkdown'
  renderMarkdown(body, previewText(item.text || 'No text returned for this node.'))
  button.append(title, meta, body)
  return button
}

const runSearch = async () => {
  const container = $('searchResults')
  if (!state.selectedSession) {
    setEmpty(container, 'No session selected')
    return
  }
  const query = $('searchInput').value.trim()
  if (!query) {
    setEmpty(container, 'Enter a query')
    $('searchCount').textContent = ''
    return
  }
  setEmpty(container, 'Searching')
  try {
    const result = await api('/api/search', scoped({
      q: query,
      role: $('roleFilter').value,
      start_at: 0,
      limit: 40
    }))
    $('searchCount').textContent = `${(result.hits || []).length} hits`
    renderSearchRows(result.hits || [])
  } catch (err) {
    setError(container, err)
  }
}

const renderSearchRows = hits => {
  const container = $('searchResults')
  container.innerHTML = ''
  if (!hits.length) {
    setEmpty(container, 'No hits')
    return
  }
  for (const hit of hits) {
    const button = resultButton(hit)
    button.addEventListener('click', async () => {
      state.selectedHandle = hit.handle
      if (hit.openable) await openHandle(hit.handle)
      else await browse({ handle: hit.handle, zoom: 'children' })
    })
    container.append(button)
  }
}

const openHandle = async handle => {
  const view = $('sourceView')
  if (!state.selectedSession || !handle) return
  view.textContent = 'Loading'
  try {
    const result = await api('/api/open', scoped({
      handle,
      budget_tokens: $('budgetInput').value
    }))
    $('openMeta').textContent = `${result.isVerbatim ? 'verbatim' : 'summary'} · ${shortId(handle)}${result.omittedTokenCount ? ` · omitted ${result.omittedTokenCount}` : ''}`
    renderMarkdown(view, result.content || result.text || '')
  } catch (err) {
    view.textContent = err.message
    $('openMeta').textContent = 'error'
  }
}

const debounce = (fn, delay = 250) => {
  let timeout
  return (...args) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }
}

$('refreshSessions').addEventListener('click', () => loadSessions())
$('agentFilter').addEventListener('change', event => {
  state.agent = event.target.value
  state.selectedSession = null
  loadSessions()
})
$('sessionQuery').addEventListener('input', debounce(() => loadSessions()))
$('searchForm').addEventListener('submit', event => {
  event.preventDefault()
  runSearch()
})
$('backBrowse').addEventListener('click', () => browseBack())
$('rootBrowse').addEventListener('click', () => browseRoot())
$('outBrowse').addEventListener('click', () => browse({ handle: state.browseHandle, zoom: 'out' }))
$('siblingsBrowse').addEventListener('click', () => browse({ handle: state.browseHandle, zoom: 'siblings' }))
window.addEventListener('popstate', event => {
  const handle = event.state && hasOwn(event.state, 'browseHandle')
    ? event.state.browseHandle
    : browseHandleFromHash()
  if (state.browseHistory[state.browseHistory.length - 1] === handle) {
    state.browseHistory.pop()
  }
  browse({ handle: handle || '', zoom: 'children' }, { pushHistory: false, pushBrowser: false })
})

renderHealth()
loadSessions()
