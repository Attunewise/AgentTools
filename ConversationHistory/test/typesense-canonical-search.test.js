const assert = require('node:assert/strict')
const test = require('node:test')

const { canonicalizeSourceMessageSearchRefs } = require('../src/typesense.js')

const sourceRef = overrides => ({
  agent: 'codex',
  index_id: 'idx-legacy',
  session_id: 'legacy-session',
  role: 'user',
  sourceLineNumber: 42,
  messageId: 'message-42',
  ...overrides
})

test('legacy source search dedupe prefers an openable content leaf over a closed message container', () => {
  const container = sourceRef({
    handle: 'session/legacy-session/event/000042-message/message-42',
    kind: 'message',
    excerpt: 'short legacy excerpt',
    isVerbatim: false,
    content: ''
  })
  const content = sourceRef({
    handle: `${container.handle}/content`,
    kind: 'event_content',
    content: 'the complete legacy source message, whose text differs from the container excerpt',
    isVerbatim: true
  })

  assert.deepEqual(canonicalizeSourceMessageSearchRefs([container, content]), [content])
  assert.deepEqual(canonicalizeSourceMessageSearchRefs([content, container]), [content])
})

test('source search dedupe prefers an openable canonical message over legacy content leaves', () => {
  const message = sourceRef({
    handle: 'session/legacy-session/event/000042-message/message-42',
    kind: 'message',
    content: 'the complete source message',
    isVerbatim: true
  })
  const content = sourceRef({
    handle: `${message.handle}/content`,
    kind: 'event_content',
    content: 'the complete source message',
    isVerbatim: true
  })

  assert.deepEqual(canonicalizeSourceMessageSearchRefs([content, message]), [message])
  assert.deepEqual(canonicalizeSourceMessageSearchRefs([message, content]), [message])
})

test('source search dedupe uses handle order only after openability and node kind', () => {
  const later = sourceRef({
    handle: 'session/legacy-session/event/000042-message/message-42/content-2',
    kind: 'event_content_chunk',
    content: 'second chunk',
    isVerbatim: true
  })
  const earlier = sourceRef({
    handle: 'session/legacy-session/event/000042-message/message-42/content-1',
    kind: 'event_content_chunk',
    content: 'first chunk',
    isVerbatim: true
  })
  const otherLine = sourceRef({
    handle: 'session/legacy-session/event/000043-message/message-43/content',
    kind: 'event_content',
    sourceLineNumber: 43,
    messageId: 'message-43',
    content: 'another source record',
    isVerbatim: true
  })

  assert.deepEqual(canonicalizeSourceMessageSearchRefs([later, otherLine, earlier]), [earlier, otherLine])
})
