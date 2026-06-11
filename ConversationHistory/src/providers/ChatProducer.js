const { fromChatMessages } = require('./Responses.js')

const clone = value => JSON.parse(JSON.stringify(value))

const compactObject = obj => {
  const out = {}
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      out[key] = obj[key]
    }
  }
  return out
}

const providerKey = provider => {
  return String(provider || 'openai')
    .toLowerCase()
    .replace(/[._\s-]/g, '')
}

const textFromContent = content => {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (part.text !== undefined) return part.text
      if (part.type === 'image_url') return `[image: ${part.image_url && part.image_url.url}]`
      if (part.content !== undefined) return textFromContent(part.content)
      return JSON.stringify(part)
    }).join('\n')
  }
  return JSON.stringify(content)
}

const parseArguments = value => {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch (err) {
    return { invalid_arguments: String(value) }
  }
}

const stringifyArguments = value => {
  if (value === undefined || value === null) return '{}'
  if (typeof value === 'string') return value || '{}'
  return JSON.stringify(value)
}

const providerToolName = (name, provider) => {
  if (!name) return name
  const key = providerKey(provider)
  if (
    key === 'openai' ||
    key === 'openaichat' ||
    key === 'anthropic' ||
    key === 'claude' ||
    key === 'bedrockanthropic' ||
    key === 'converse' ||
    key === 'awsconverse'
  ) {
    return name.replaceAll('.', '__')
  }
  return name
}

const openAITool = (tool, provider = 'openai') => {
  const copied = clone(tool)
  if (copied.function && copied.function.name) {
    copied.function.name = providerToolName(copied.function.name, provider)
  }
  return copied
}

const anthropicTool = tool => {
  const { name, description, parameters } = tool.function || {}
  return compactObject({
    name: providerToolName(name, 'anthropic'),
    description,
    input_schema: parameters || { type: 'object', properties: {} }
  })
}

const geminiTool = tool => {
  const { name, description, parameters } = tool.function || {}
  return compactObject({
    name,
    description,
    parameters: removeUnsupportedJsonSchemaFields(parameters || { type: 'object', properties: {} })
  })
}

const converseTool = tool => {
  const { name, description, parameters } = tool.function || {}
  return {
    toolSpec: compactObject({
      name: providerToolName(name, 'converse'),
      description,
      inputSchema: {
        json: parameters || { type: 'object', properties: {} }
      }
    })
  }
}

const removeUnsupportedJsonSchemaFields = schema => {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(removeUnsupportedJsonSchemaFields)
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'format' || key === '$schema' || key === 'additionalProperties') continue
    out[key] = removeUnsupportedJsonSchemaFields(value)
  }
  return out
}

const openAIToolChoice = (toolChoice, provider = 'openai') => {
  if (!toolChoice || typeof toolChoice === 'string') return toolChoice
  if (toolChoice.type === 'function' && toolChoice.function) {
    return {
      type: 'function',
      function: {
        name: providerToolName(toolChoice.function.name, provider)
      }
    }
  }
  return clone(toolChoice)
}

const anthropicToolChoice = toolChoice => {
  if (!toolChoice || toolChoice === 'auto') return undefined
  if (toolChoice === 'none') return undefined
  if (toolChoice === 'required') return { type: 'any' }
  if (toolChoice.type === 'function' && toolChoice.function) {
    return { type: 'tool', name: providerToolName(toolChoice.function.name, 'anthropic') }
  }
  return toolChoice
}

const geminiToolConfig = toolChoice => {
  if (!toolChoice || toolChoice === 'auto') return undefined
  if (toolChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } }
  }
  if (toolChoice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } }
  }
  if (toolChoice.type === 'function' && toolChoice.function) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.function.name]
      }
    }
  }
  return undefined
}

const openAIChatMessages = (messages, options = {}) => {
  return messages.map(message => {
    const out = clone(message)
    if (out.tool_calls) {
      out.tool_calls = out.tool_calls.map(toolCall => ({
        ...toolCall,
        function: {
          ...toolCall.function,
          name: providerToolName(toolCall.function && toolCall.function.name, 'openai'),
          arguments: stringifyArguments(toolCall.function && toolCall.function.arguments)
        }
      }))
    }
    return out
  })
}

const openAIResponsesContent = (content, role) => {
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') {
        return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part }
      }
      if (part.type === 'text') {
        return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' }
      }
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'image_url') {
        return clone(part)
      }
      return { type: role === 'assistant' ? 'output_text' : 'input_text', text: textFromContent(part) }
    })
  }
  return [{
    type: role === 'assistant' ? 'output_text' : 'input_text',
    text: textFromContent(content)
  }]
}

const toOpenAIResponses = (messages, options = {}) => {
  const { instructions, input } = fromChatMessages(openAIChatMessages(messages, options))
  const request = compactObject({
    ...copyCommonOptions(options, ['messages', 'tools', 'tool_choice', 'response_format']),
    model: options.model,
    instructions,
    input,
    tools: options.tools ? options.tools.map(tool => {
      const { type = 'function' } = tool
      const { name, description, parameters } = tool.function || {}
      return compactObject({
        type,
        name: providerToolName(name, 'openai'),
        description,
        parameters
      })
    }) : undefined,
    tool_choice: openAIToolChoice(options.tool_choice, 'openai')
  })
  return {
    provider: 'openai',
    kind: 'openai.responses',
    request,
    metadata: {
      sourceFormat: 'openai.chat.completions'
    }
  }
}

const parseThinkingBlocks = content => {
  const text = textFromContent(content)
  if (!text) return []
  const parts = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<think>', cursor)
    if (start < 0) {
      pushAnthropicText(parts, text.slice(cursor))
      break
    }
    pushAnthropicText(parts, text.slice(cursor, start))
    const end = text.indexOf('</think>', start + 7)
    if (end < 0) {
      pushAnthropicText(parts, text.slice(start + 7))
      break
    }
    const inner = text.slice(start + 7, end)
    const sigStart = inner.lastIndexOf('<signed>')
    const sigEnd = inner.lastIndexOf('</signed>')
    if (sigStart >= 0 && sigEnd > sigStart) {
      parts.push({
        type: 'thinking',
        thinking: inner.slice(0, sigStart),
        signature: inner.slice(sigStart + 8, sigEnd)
      })
    }
    cursor = end + 8
  }
  return parts
}

const pushAnthropicText = (parts, text) => {
  if (!text || !text.trim()) return
  const last = parts[parts.length - 1]
  if (last && last.type === 'text') {
    last.text += text
  } else {
    parts.push({ type: 'text', text })
  }
}

const anthropicContent = (content, role) => {
  if (role === 'assistant') {
    const parsed = parseThinkingBlocks(content)
    if (parsed.length) return parsed
  }
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (typeof part === 'string') {
        pushAnthropicText(parts, part)
      } else if (part.type === 'text') {
        pushAnthropicText(parts, part.text || '')
      } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
        parts.push({
          type: 'image',
          source: {
            type: 'url',
            url: part.image_url.url
          }
        })
      } else if (part.type) {
        parts.push(clone(part))
      } else {
        pushAnthropicText(parts, textFromContent(part))
      }
    }
    return parts.length ? parts : [{ type: 'text', text: 'n/a' }]
  }
  return [{ type: 'text', text: textFromContent(content) || 'n/a' }]
}

const toAnthropicMessages = (messages, options = {}) => {
  const sys = messages.filter(message => message.role === 'system')
  const nonSys = messages.filter(message => message.role !== 'system')
  const out = []
  let prefill = ''

  const isJson = options.response_format && options.response_format.type === 'json_object'
  const sourceMessages = nonSys.slice()
  const last = sourceMessages[sourceMessages.length - 1]
  if (last && last.role === 'assistant' && !last.tool_calls) {
    prefill = textFromContent(last.content)
  } else if (isJson) {
    prefill = '{'
    sourceMessages.push({ role: 'assistant', content: prefill })
  }

  for (const message of sourceMessages) {
    if (message.role === 'tool') {
      pushCoalesced(out, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: anthropicContent(message.content, 'user')
        }]
      })
      continue
    }

    const content = anthropicContent(message.content, message.role)
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: providerToolName(toolCall.function && toolCall.function.name, 'anthropic'),
          input: parseArguments(toolCall.function && toolCall.function.arguments)
        })
      }
    }
    pushCoalesced(out, {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content
    })
  }

  const request = compactObject({
    ...copyCommonOptions(options, ['messages', 'tools', 'tool_choice', 'response_format']),
    model: options.model,
    system: sys.map(message => ({ type: 'text', text: textFromContent(message.content) })),
    messages: out,
    tools: options.tools ? options.tools.map(anthropicTool) : undefined,
    tool_choice: options.tool_choice === 'none' ? undefined : anthropicToolChoice(options.tool_choice),
    max_tokens: options.max_tokens || options.max_completion_tokens || 4096
  })
  if (options.tool_choice === 'none') {
    delete request.tools
    delete request.tool_choice
  }
  applyAnthropicCacheControl(request, options.cache_control)
  return {
    provider: 'anthropic',
    kind: 'anthropic.messages',
    request,
    prefill,
    isJson,
    metadata: {
      sourceFormat: 'openai.chat.completions'
    }
  }
}

const applyAnthropicCacheControl = (request, cacheControl) => {
  if (!cacheControl) return
  if (request.system && request.system.length) {
    request.system[request.system.length - 1].cache_control = cacheControl
  }
  if (request.tools && request.tools.length) {
    request.tools[request.tools.length - 1].cache_control = cacheControl
  }
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]
    if (!message.content || !message.content.length) continue
    const block = message.content[message.content.length - 1]
    if (block.type === 'text') {
      block.cache_control = cacheControl
      return
    }
  }
}

const pushCoalesced = (messages, message) => {
  const last = messages[messages.length - 1]
  if (last && last.role === message.role) {
    last.content = last.content.concat(message.content)
  } else {
    messages.push(message)
  }
}

const geminiParts = content => {
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return { text: part }
      if (part.type === 'text') return { text: part.text || '' }
      if (part.text !== undefined) return { text: part.text }
      if (part.type === 'image_url' && part.image_url && part.image_url.url) {
        return { text: `[image: ${part.image_url.url}]` }
      }
      return { text: textFromContent(part) }
    }).filter(part => part.text || part.functionCall || part.functionResponse)
  }
  return [{ text: textFromContent(content) || 'n/a' }]
}

const toGemini = (messages, options = {}) => {
  const sys = messages.filter(message => message.role === 'system')
  const nonSys = messages.filter(message => message.role !== 'system')
  const contents = []
  let previousFunctionResponse

  for (const message of nonSys) {
    if (message.role !== 'tool') {
      previousFunctionResponse = null
    }

    if (message.role === 'tool') {
      const name = findToolCallName(messages, message.tool_call_id)
      const part = {
        functionResponse: {
          name,
          response: {
            name,
            content: textFromContent(message.content)
          }
        }
      }
      if (previousFunctionResponse) {
        previousFunctionResponse.parts.push(part)
      } else {
        previousFunctionResponse = { role: 'user', parts: [part] }
        contents.push(previousFunctionResponse)
      }
      continue
    }

    if (message.tool_calls) {
      contents.push({
        role: 'model',
        parts: message.tool_calls.map(toolCall => compactObject({
          thoughtSignature: toolCall.geminiSignature,
          functionCall: {
            name: toolCall.function && toolCall.function.name,
            args: parseArguments(toolCall.function && toolCall.function.arguments)
          }
        }))
      })
      continue
    }

    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: geminiParts(message.content)
    })
  }

  const request = compactObject({
    contents: contents.filter(item => item.parts && item.parts.length),
    systemInstruction: sys.length ? {
      parts: sys.map(message => ({ text: textFromContent(message.content) }))
    } : undefined,
    tools: options.tools ? [{
      function_declarations: options.tools.map(geminiTool)
    }] : undefined,
    toolConfig: geminiToolConfig(options.tool_choice),
    generationConfig: compactObject({
      temperature: options.temperature,
      topP: options.top_p,
      topK: options.top_k,
      maxOutputTokens: options.max_tokens || options.max_completion_tokens,
      responseMimeType: options.response_format && options.response_format.type === 'json_object'
        ? 'application/json'
        : undefined
    })
  })
  return {
    provider: 'gemini',
    kind: 'gemini.generateContent',
    request,
    metadata: {
      sourceFormat: 'openai.chat.completions'
    }
  }
}

const findToolCallName = (messages, toolCallId) => {
  for (const message of messages) {
    for (const toolCall of message.tool_calls || []) {
      if (toolCall.id === toolCallId) {
        return toolCall.function && toolCall.function.name
      }
    }
  }
  return toolCallId
}

const converseContent = content => {
  return [{ text: textFromContent(content) || 'n/a' }]
}

const toAwsConverse = (messages, options = {}) => {
  const sys = messages.filter(message => message.role === 'system')
  const nonSys = messages.filter(message => message.role !== 'system')
  const out = []
  let previousToolResult

  for (const message of nonSys) {
    if (message.role !== 'tool') {
      previousToolResult = null
    }
    if (message.role === 'tool') {
      const part = {
        toolResult: {
          toolUseId: message.tool_call_id,
          content: converseContent(message.content)
        }
      }
      if (previousToolResult) {
        previousToolResult.content.push(part)
      } else {
        previousToolResult = { role: 'user', content: [part] }
        out.push(previousToolResult)
      }
      continue
    }
    if (message.tool_calls) {
      const content = []
      if (message.content) content.push(...converseContent(message.content))
      for (const toolCall of message.tool_calls) {
        content.push({
          toolUse: {
            toolUseId: toolCall.id,
            name: providerToolName(toolCall.function && toolCall.function.name, 'converse'),
            input: parseArguments(toolCall.function && toolCall.function.arguments)
          }
        })
      }
      out.push({ role: 'assistant', content })
      continue
    }
    out.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: converseContent(message.content)
    })
  }

  const request = compactObject({
    modelId: options.modelId,
    messages: out,
    system: sys.flatMap(message => converseContent(message.content)),
    toolConfig: options.tools ? { tools: options.tools.map(converseTool) } : undefined,
    inferenceConfig: compactObject({
      maxTokens: options.max_tokens || options.max_completion_tokens,
      temperature: options.temperature,
      topP: options.top_p
    })
  })
  return {
    provider: 'aws',
    kind: 'aws.converse',
    request,
    metadata: {
      sourceFormat: 'openai.chat.completions'
    }
  }
}

const toBedrockAnthropic = (messages, options = {}) => {
  const produced = toAnthropicMessages(messages, options)
  produced.provider = 'bedrock'
  produced.kind = 'bedrock.anthropic.messages'
  produced.request = {
    anthropic_version: options.anthropic_version || 'bedrock-2023-05-31',
    ...produced.request
  }
  if (options.anthropic_beta) {
    produced.request.anthropic_beta = options.anthropic_beta
  }
  delete produced.request.model
  return produced
}

const copyCommonOptions = (options, excluded = []) => {
  const skip = new Set(excluded.concat([
    'modelId',
    'anthropic_version',
    'anthropic_beta',
    'cache_control',
    'textVerbosity',
    'sessionId',
    'prompt_cache_key',
    'store',
    'stream',
    'include',
    'parallel_tool_calls'
  ]))
  const out = {}
  for (const [key, value] of Object.entries(options || {})) {
    if (skip.has(key)) continue
    out[key] = value
  }
  return out
}

const toOpenAIChat = (messages, options = {}) => {
  const request = compactObject({
    ...copyCommonOptions(options, ['messages', 'tools', 'tool_choice']),
    model: options.model,
    messages: openAIChatMessages(messages, options),
    tools: options.tools ? options.tools.map(tool => openAITool(tool, 'openai')) : undefined,
    tool_choice: openAIToolChoice(options.tool_choice, 'openai')
  })
  return {
    provider: 'openai',
    kind: 'openai.chat.completions',
    request,
    metadata: {
      sourceFormat: 'openai.chat.completions'
    }
  }
}

const toOpenAICodexResponses = (messages, options = {}) => {
  const produced = toOpenAIResponses(messages, options)
  produced.provider = 'openai-codex'
  produced.kind = 'openai.codex.responses'
  produced.request = {
    ...produced.request,
    store: options.store === true,
    stream: options.stream !== false,
    text: options.text || { verbosity: options.textVerbosity || 'low' },
    include: options.include || ['reasoning.encrypted_content'],
    prompt_cache_key: options.prompt_cache_key || options.sessionId,
    tool_choice: produced.request.tool_choice || 'auto',
    parallel_tool_calls: options.parallel_tool_calls !== false
  }
  delete produced.request.max_output_tokens
  delete produced.request.max_tokens
  delete produced.request.max_completion_tokens
  return {
    ...produced,
    request: compactObject(produced.request)
  }
}

const producerForProvider = provider => {
  const key = providerKey(provider)
  if (key === 'openairesponses' || key === 'responses' || key === 'responseapi') return toOpenAIResponses
  if (key === 'anthropic' || key === 'claude') return toAnthropicMessages
  if (key === 'bedrockanthropic' || key === 'bedrockclaude') return toBedrockAnthropic
  if (key === 'gemini' || key === 'google' || key === 'googleai' || key === 'googlegenai') return toGemini
  if (key === 'converse' || key === 'awsconverse') return toAwsConverse
  if (key === 'codex' || key === 'openaicodex' || key === 'openaicodexresponses' || key === 'codexresponses') return toOpenAICodexResponses
  if (key === 'openai' || key === 'openaichat' || key === 'chatcompletions') return toOpenAIChat
  return toOpenAIChat
}

const chatProducer = (provider, messages, options = {}, context = {}) => {
  const producer = context.producer || producerForProvider(provider)
  return producer(messages, options, context)
}

class ChatProducer {
  constructor(provider, defaults = {}) {
    this.provider = provider
    this.defaults = defaults
    this.producer = defaults.producer || producerForProvider(provider)
  }

  produce(messages, options = {}, context = {}) {
    return this.producer(messages, { ...this.defaults.options, ...options }, context)
  }
}

module.exports = {
  ChatProducer,
  chatProducer,
  producerForProvider,
  toOpenAIChat,
  toOpenAIResponses,
  toAnthropicMessages,
  toBedrockAnthropic,
  toGemini,
  toAwsConverse,
  toOpenAICodexResponses,
  textFromContent,
  providerToolName
}
