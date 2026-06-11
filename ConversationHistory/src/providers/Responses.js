const textFromContent = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part.text === 'string') return part.text
      return part ? JSON.stringify(part) : ''
    }).join('\n')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

const OPENAI_SIG_RE = /<openai-sig>([\s\S]*?)<\/openai-sig>/g
const OPENAI_DANGLING_SIG_RE = /<openai-sig>[\s\S]*?(?=<\/think>|$)/g
const THINK_RE = /<think>([\s\S]*?)<\/think>/g

const stripOpenAISigs = content => {
  if (typeof content !== 'string') return content
  return content.replace(OPENAI_SIG_RE, '').replace(OPENAI_DANGLING_SIG_RE, '')
}

const openAIThinkBlocksFromContent = content => {
  if (typeof content !== 'string') return []
  return Array.from(content.matchAll(THINK_RE)).map(match => ({
    inner: match[1],
    summary: stripOpenAISigs(match[1]).trim()
  }))
}

const openAIReasoningItemsFromContent = content => {
  if (typeof content !== 'string') return []
  const thinkBlocks = openAIThinkBlocksFromContent(content)
  const items = []
  for (const block of thinkBlocks) {
    for (const match of block.inner.matchAll(OPENAI_SIG_RE)) {
      const encrypted_content = match[1]
      if (!encrypted_content) continue
      items.push({
        type: 'reasoning',
        summary: block.summary ? [{ type: 'summary_text', text: block.summary }] : [],
        encrypted_content
      })
    }
  }
  return items
}

const convertAssistantContent = content => {
  if (typeof content !== 'string' || content.length === 0) return []
  const cleaned = stripOpenAISigs(content)
  if (!cleaned || !cleaned.trim()) return []
  return [{ type: 'text', text: cleaned }]
}

const mapContentParts = (content, { role }) => {
  const source = role === 'assistant'
    ? convertAssistantContent(content)
    : Array.isArray(content)
      ? content
      : [{ type: 'text', text: String(content ?? '') }]

  return source.flatMap(part => {
    if (typeof part === 'string') {
      return [{
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: part
      }]
    }
    if (part.type === 'text') {
      return [{
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: part.text ?? String(content ?? '')
      }]
    }
    if (part.type === 'image_url' && role !== 'assistant') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url
      const detail = typeof part.image_url === 'object' ? part.image_url && part.image_url.detail : undefined
      return [{
        type: 'input_image',
        image_url: url,
        ...(detail ? { detail } : {})
      }]
    }
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'input_image') {
      return [part]
    }
    return [{
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: textFromContent(part)
    }]
  })
}

const chatMessageToResponsesItems = message => {
  if (message.role === 'system') return []
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.tool_call_id,
      output: textFromContent(message.content)
    }]
  }

  const out = []
  if (
    (message.role === 'user' || message.role === 'assistant') &&
    message.content !== undefined &&
    message.content !== null &&
    textFromContent(message.content)
  ) {
    const content = mapContentParts(message.content, { role: message.role })
    if (content.length) out.push({ role: message.role, content })
  }
  if (message.role === 'assistant') {
    out.push(...openAIReasoningItemsFromContent(message.content))
  }

  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {}
    out.push({
      type: 'function_call',
      call_id: toolCall.id,
      name: fn.name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
    })
  }
  return out
}

const fromChatMessages = messages => {
  const instructions = messages
    .filter(message => message.role === 'system')
    .map(message => textFromContent(message.content))
    .join('\n')
  const input = messages
    .filter(message => message.role !== 'system')
    .flatMap(chatMessageToResponsesItems)
  return { instructions, input }
}

module.exports = {
  fromChatMessages,
  convertAssistantContent,
  openAIReasoningItemsFromContent,
  stripOpenAISigs
}
