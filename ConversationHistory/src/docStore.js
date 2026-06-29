const path = require('path')
const { readJsonlRows, writeJsonlRows } = require('./util.js')

const DOC_STORE_SCHEMA = 'session-indexer.session-docs.v1'

const docStorePath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.docs.jsonl`)

const storedDoc = doc => {
  const out = { ...(doc || {}) }
  delete out.content
  delete out.searchText
  if (out.isVerbatim) {
    delete out.summary
    delete out.excerpt
    delete out.topics
  }
  return out
}

function * docRows ({ sessionId, docs }) {
  yield {
    recordType: 'session_docs_header',
    schema: DOC_STORE_SCHEMA,
    sessionId
  }
  for (const doc of docs || []) {
    yield {
      recordType: 'session_doc',
      doc: storedDoc(doc)
    }
  }
}

const writeSessionDocs = ({ root, sessionId, docs }) => {
  writeJsonlRows(docStorePath(root, sessionId), docRows({ sessionId, docs }))
}

const readSessionDocs = ({ root, sessionId }) => {
  const docs = []
  for (const row of readJsonlRows(docStorePath(root, sessionId))) {
    if (row.parseError) {
      throw new Error(`invalid session docs JSONL at ${docStorePath(root, sessionId)}:${row.lineNumber}: ${row.parseError}`)
    }
    const record = row.json || {}
    if (record.recordType === 'session_doc' && record.doc) docs.push(record.doc)
  }
  return docs
}

const readSessionDocMap = ({ root, sessionId }) => {
  const map = new Map()
  for (const doc of readSessionDocs({ root, sessionId })) {
    if (doc && doc.handle) map.set(doc.handle, doc)
  }
  return map
}

const adapterNameForSourceKind = kind => {
  const text = String(kind || '').toLowerCase()
  if (text.startsWith('codex')) return 'codex'
  if (text.startsWith('claude')) return 'claude'
  return text
}

const sourceImportOptions = sourceKind => {
  const adapterName = adapterNameForSourceKind(sourceKind)
  if (adapterName === 'codex') {
    return [
      { includeResponseMessages: false },
      { includeResponseMessages: true }
    ]
  }
  return [{}]
}

const nodeContent = node => {
  if (!node || node.children && node.children.length) return ''
  const { modelTextForNode } = require('./mip.js')
  return modelTextForNode(node) || String(node.raw || '')
}

const findSourceNode = ({ tree, doc }) => {
  if (!tree || !tree.byHandle) return null
  const exact = tree.byHandle.get(doc.handle)
  if (nodeContent(exact)) return exact
  const sourceLineNumber = Number(doc.sourceLineNumber || 0)
  if (!Number.isInteger(sourceLineNumber) || sourceLineNumber <= 0) return null
  const candidates = []
  for (const node of tree.byHandle.values()) {
    const lineNumber = Number(node && node.meta && node.meta.source && node.meta.source.lineNumber || 0)
    if (lineNumber === sourceLineNumber && nodeContent(node)) candidates.push(node)
  }
  return candidates.find(node => node.kind === doc.kind) || (candidates.length === 1 ? candidates[0] : null)
}

const hydrateSourceContent = doc => {
  if (!doc || doc.content || !doc.isVerbatim || !doc.sourcePath || !doc.handle) return doc
  try {
    const { adapterFor } = require('./adapters/index.js')
    const { buildMipTree } = require('./mip.js')
    const adapter = adapterFor(adapterNameForSourceKind(doc.sourceKind))
    for (const opts of sourceImportOptions(doc.sourceKind)) {
      const ir = adapter.importFile(doc.sourcePath, opts)
      const tree = buildMipTree(ir)
      const node = findSourceNode({ tree, doc })
      const content = nodeContent(node)
      if (content) return { ...doc, content }
    }
    return doc
  } catch (err) {
    if (err && (
      err.code === 'ENOENT' ||
      /unknown source adapter/i.test(err.message || '')
    )) return doc
    throw err
  }
}

const hydrateDoc = ({ root, doc, includeContent = false }) => {
  if (!doc || !root || !doc.sessionId || !doc.handle) return doc
  let hydrated = doc
  try {
    const stored = readSessionDocMap({ root, sessionId: doc.sessionId }).get(doc.handle)
    hydrated = stored ? { ...doc, ...stored } : doc
  } catch (err) {
    if (err && err.code === 'ENOENT') hydrated = doc
    else throw err
  }
  return includeContent ? hydrateSourceContent(hydrated) : hydrated
}

const hydrateDocs = ({ root, docs }) => (docs || []).map(doc => hydrateDoc({ root, doc }))

module.exports = {
  DOC_STORE_SCHEMA,
  docStorePath,
  hydrateDoc,
  hydrateDocs,
  readSessionDocMap,
  readSessionDocs,
  storedDoc,
  writeSessionDocs
}
