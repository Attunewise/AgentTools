const { compactText, preview } = require('./util.js')

const topicText = topic => {
  if (topic == null) return ''
  if (typeof topic === 'string') return compactText(topic)
  if (typeof topic === 'object') {
    return compactText(
      topic.text ||
      topic.one_line ||
      topic.summary ||
      topic.topic ||
      topic.label ||
      topic.one_word ||
      ''
    )
  }
  return compactText(String(topic))
}

const normalizeTopics = (topics = [], { max = 8, maxChars = 220 } = {}) => {
  const seen = new Set()
  const out = []
  for (const topic of Array.isArray(topics) ? topics : []) {
    const text = preview(topicText(topic), maxChars)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (max && out.length >= max) break
  }
  return out
}

const topicsText = topics => normalizeTopics(topics, { max: 0 }).join('\n')

const topicIdForHandle = ({ handle, topicIndex = -1 } = {}) => {
  if (!handle) return ''
  const payload = Buffer.from(JSON.stringify({
    h: String(handle),
    i: Number.isInteger(topicIndex) ? topicIndex : -1
  }), 'utf8').toString('base64url')
  return `topic:v1:${payload}`
}

const parseTopicId = topicId => {
  const text = String(topicId || '')
  const prefix = 'topic:v1:'
  if (!text.startsWith(prefix)) return null
  try {
    const parsed = JSON.parse(Buffer.from(text.slice(prefix.length), 'base64url').toString('utf8'))
    if (!parsed || typeof parsed.h !== 'string' || !parsed.h) return null
    return {
      handle: parsed.h,
      topicIndex: Number.isInteger(parsed.i) ? parsed.i : -1
    }
  } catch (_err) {
    return null
  }
}

module.exports = {
  normalizeTopics,
  parseTopicId,
  topicIdForHandle,
  topicText,
  topicsText
}
