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

const hydrateDoc = ({ root, doc }) => {
  if (!doc || !root || !doc.sessionId || !doc.handle) return doc
  try {
    const stored = readSessionDocMap({ root, sessionId: doc.sessionId }).get(doc.handle)
    return stored ? { ...doc, ...stored } : doc
  } catch (err) {
    if (err && err.code === 'ENOENT') return doc
    throw err
  }
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
