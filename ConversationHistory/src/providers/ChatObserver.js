const { Observable, of, concat, from, Subject } = require('rxjs')
const { takeUntil, flatMap } = require('rxjs/operators')
const { openai_uinit, to_openai } = require('./Usage.js')
const { Readable } = require('stream')
let counter = 0

function isStream(data) {
  return data instanceof Readable;  // Checks if data is a readable stream
}

function generateId() {
  const timestamp = Date.now().toString(36); // Base36 timestamp
  const randomPart = Math.floor(Math.random() * 1000).toString(36); // Random number in Base36
  counter = (counter + 1) % 1000; // Increment counter, reset at 1000
  const counterPart = counter.toString(36); // Counter in Base36

  return `${timestamp}-${randomPart}-${counterPart}`;
}

function observableToStream (observable) {
  const stream = new Readable({ objectMode: false })
  stream._read = () => {}
  const subscription = observable.subscribe({
    next: (value) => {
      if (typeof value !== 'string') {
        console.error('invalid value', typeof value, value)
      } else {
        stream.push(value)
      }
    },
    error: (error) => stream.destroy(error),
    complete: () => stream.push(null)
  })
  stream.on('end', () => subscription.unsubscribe())
  stream.on('close', () => subscription.unsubscribe())
  return stream
}

function observableToReadableStream (observable) {
  return new ReadableStream({
    start (controller) {
      const subscription = observable.subscribe({
        next: (value) => controller.enqueue(value),
        error: (error) => controller.error(error),
        complete: () => controller.close()
      })

      return () => subscription.unsubscribe()
    }
  })
}

const insertContent = content => {
  return of(JSON.stringify({
    choices: [{
      id: generateId(),
      index: 0,
      delta: {
        content
      }
    }]
  }))
}

const chatObserver = (response, model, wasStopped, prefill = '', type = 'chat_completion') => {
  let fields = {}
  let usage
  let bufferString = ''
  let streamUsage = openai_uinit()
  let message
  let stopped = false
  if (!wasStopped) {
    throw new Error('No wasStopped')
  }
  return new Observable(subscriber => {
    const run = async () => {
      if (isStream(response.data)) {
        const dataPrefix = 'data: '
        const doneData = `${dataPrefix}[DONE]`
        for await (let chunk of response.data) {
          if (stopped || (wasStopped && wasStopped())) {
            response.data.destroy()
            break
          }
          chunk = chunk.toString()
          bufferString += chunk
          let end = bufferString.lastIndexOf('\n\n')
          let dataString
          if (end > 0) {
            dataString = bufferString.substring(0, end + 2)
            bufferString = bufferString.substring(end + 2)
          }
          if (dataString) {
            try {
              dataString.includes(doneData)
              const dataJsonLines = dataString
                .split(doneData)
                .join('')
                .trim()
                .split(dataPrefix)
                .filter((v) => !!v)
              for (const dataJson of dataJsonLines) {
                let parsed
                try {
                  parsed = JSON.parse(dataJson)
                } catch (err) {
                  console.error(err)
                  continue
                }
                const { error, choices } = parsed
                parsed.model = model
                parsed.object = type
                if (parsed.usage) {
                  streamUsage = normalizeUsage(parsed.usage)
                  usage = parsed.usage = streamUsage
                }
                if (error) {
                  subscriber.next(parsed)
                  continue
                }
                if (choices && choices.length > 0) {
                  const [choice] = choices
                  if (choice.text !== undefined) {
                    choice.delta = {
                      content: choice.text
                    }
                    delete choice.text
                  }
                  if (type === 'chat_completion') {
                    mergeDeltaIntoFields(fields, choice.delta)
                    if (prefill) {
                      if (choice.delta && choice.delta.content) {
                        choice.delta.content = prefill + choice.delta.content
                        prefill = null
                      }
                    }
                    subscriber.next(parsed)
                  }
                }
              }
            } catch (err) {
              console.error(err)
            }
          }
        }
        message = {
          role: 'assistant'
        }
        for (const field in fields) {
          message[field] = fields[field]
        }
      } else {
        message = response.message
        usage = normalizeUsage(response.usage)
      }
      subscriber.next({
        message,
        usage
      })
      subscriber.complete()
    }
    run().catch(err => subscriber.error(err))
    return () => { stopped = true }
  })
}

function nowSeconds () {
  return Math.floor(Date.now() / 1000)
}

function isAsyncIterable (value) {
  return value && typeof value[Symbol.asyncIterator] === 'function'
}

function isReadableStreamLike (value) {
  return value && typeof value.getReader === 'function'
}

function isBytesLike (value) {
  return typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array
}

function isObjectChunk (value) {
  return value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)
}

function responseBody (response) {
  if (!response) return response
  if (response.data !== undefined) return response.data
  if (response.body !== undefined) return response.body
  return response
}

function destroyBody (body) {
  if (!body) return
  if (typeof body.destroy === 'function') {
    body.destroy()
  } else if (typeof body.cancel === 'function') {
    body.cancel().catch(() => {})
  } else if (typeof body.abort === 'function') {
    body.abort()
  }
}

function chunkToString (chunk) {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  return String(chunk)
}

async function * iterateBody (body, wasStopped) {
  if (!body) return

  if (isReadableStreamLike(body)) {
    const reader = body.getReader()
    try {
      while (true) {
        if (wasStopped && wasStopped()) {
          await reader.cancel().catch(() => {})
          break
        }
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      if (typeof reader.releaseLock === 'function') {
        reader.releaseLock()
      }
    }
    return
  }

  if (isAsyncIterable(body)) {
    for await (const chunk of body) {
      if (wasStopped && wasStopped()) {
        destroyBody(body)
        break
      }
      yield chunk
    }
    return
  }

  if (isBytesLike(body)) {
    yield body
  }
}

function parseSSEBlock (block) {
  const lines = block.split('\n')
  let event = 'message'
  const data = []
  for (let line of lines) {
    if (!line || line.startsWith(':')) continue
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const colon = line.indexOf(':')
    const field = colon >= 0 ? line.slice(0, colon) : line
    let value = colon >= 0 ? line.slice(colon + 1) : ''
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
  }
  if (!data.length) return null
  return { event, data: data.join('\n') }
}

async function * iterateJsonEvents (body, wasStopped) {
  let buffer = ''
  let sawSSE = false

  for await (const chunk of iterateBody(body, wasStopped)) {
    if (isObjectChunk(chunk)) {
      yield chunk
      continue
    }

    buffer += chunkToString(chunk).replace(/\r\n/g, '\n')
    let end = buffer.indexOf('\n\n')
    while (end >= 0) {
      sawSSE = true
      const raw = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const sse = parseSSEBlock(raw)
      if (sse) {
        if (sse.data === '[DONE]') {
          yield { type: '[DONE]', done: true }
        } else {
          try {
            const parsed = JSON.parse(sse.data)
            if (!parsed.type && sse.event && sse.event !== 'message') {
              parsed.type = sse.event
            }
            yield parsed
          } catch (err) {
            yield { type: 'parse_error', error: err, raw: sse.data, event: sse.event }
          }
        }
      }
      end = buffer.indexOf('\n\n')
    }
  }

  const leftover = buffer.trim()
  if (!leftover) return

  if (sawSSE || leftover.startsWith('event:') || leftover.startsWith('data:')) {
    const sse = parseSSEBlock(leftover)
    if (!sse) return
    if (sse.data === '[DONE]') {
      yield { type: '[DONE]', done: true }
      return
    }
    try {
      const parsed = JSON.parse(sse.data)
      if (!parsed.type && sse.event && sse.event !== 'message') {
        parsed.type = sse.event
      }
      yield parsed
    } catch (err) {
      yield { type: 'parse_error', error: err, raw: sse.data, event: sse.event }
    }
    return
  }

  try {
    yield JSON.parse(leftover)
  } catch (err) {
    yield { type: 'parse_error', error: err, raw: leftover }
  }
}

function normalizeUsage (usage) {
  if (!usage) return undefined

  try {
    const converted = to_openai(usage)
    if (converted && typeof converted === 'object') {
      const keys = Object.keys(converted).filter(k => converted[k] !== undefined)
      if (keys.length) return converted
    }
  } catch (err) {}

  const promptTokens = firstNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokenCount,
    usage.prompt_token_count,
    usage.inputTokens
  )
  const completionTokens = firstNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.candidatesTokenCount,
    usage.candidates_token_count,
    usage.outputTokens
  )
  const totalTokens = firstNumber(
    usage.total_tokens,
    usage.totalTokenCount,
    usage.total_token_count,
    addNumbers(promptTokens, completionTokens)
  )

  const normalized = {}
  if (promptTokens !== undefined) normalized.prompt_tokens = promptTokens
  if (completionTokens !== undefined) normalized.completion_tokens = completionTokens
  if (totalTokens !== undefined) normalized.total_tokens = totalTokens

  if (usage.output_tokens_details) normalized.completion_tokens_details = usage.output_tokens_details
  if (usage.input_tokens_details) normalized.prompt_tokens_details = usage.input_tokens_details
  if (usage.thoughtsTokenCount !== undefined || usage.thoughts_token_count !== undefined) {
    normalized.completion_tokens_details = normalized.completion_tokens_details || {}
    normalized.completion_tokens_details.reasoning_tokens = firstNumber(usage.thoughtsTokenCount, usage.thoughts_token_count)
  }
  const cacheReadTokens = firstNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens)
  const cacheCreationTokens = firstNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens)
  const cachedTokens = firstNumber(
    usage.cachedContentTokenCount,
    usage.cached_content_token_count,
    addDefinedNumbers(cacheReadTokens, cacheCreationTokens)
  )
  if (cachedTokens !== undefined) {
    normalized.prompt_tokens_details = normalized.prompt_tokens_details || {}
    normalized.prompt_tokens_details.cached_tokens = cachedTokens
  }

  normalized.provider_usage = usage
  return Object.keys(normalized).length ? normalized : usage
}

function firstNumber (...values) {
  for (const value of values) {
    if (typeof value === 'number' && !Number.isNaN(value)) return value
  }
  return undefined
}

function addNumbers (a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return undefined
  return a + b
}

function addDefinedNumbers (...values) {
  const nums = values.filter(value => typeof value === 'number' && !Number.isNaN(value))
  if (!nums.length) return undefined
  return nums.reduce((sum, value) => sum + value, 0)
}

function createChunk ({ id, model, delta, finishReason = null, usage, type = 'chat_completion' }) {
  const chunk = {
    id: id || generateId(),
    object: type,
    created: nowSeconds(),
    model,
    choices: [{
      index: 0,
      delta: delta || {},
      finish_reason: finishReason
    }]
  }
  if (usage) chunk.usage = usage
  return chunk
}

function emitContentDelta (subscriber, state, text) {
  if (!text) return
  if (state.prefill) {
    text = state.prefill + text
    state.prefill = null
  }
  state.fields.content = (state.fields.content || '') + text
  subscriber.next(createChunk({
    id: state.id,
    model: state.model,
    type: state.type,
    delta: { content: text }
  }))
}

function ensureToolCall (state, toolIndex) {
  if (!state.fields.tool_calls) state.fields.tool_calls = []
  if (!state.fields.tool_calls[toolIndex]) {
    state.fields.tool_calls[toolIndex] = {
      index: toolIndex,
      id: generateId(),
      type: 'function',
      function: { name: '', arguments: '' }
    }
  }
  if (!state.fields.tool_calls[toolIndex].function) {
    state.fields.tool_calls[toolIndex].function = { name: '', arguments: '' }
  }
  return state.fields.tool_calls[toolIndex]
}

function setToolCall (state, toolIndex, patch) {
  const toolCall = ensureToolCall(state, toolIndex)
  if (patch.id !== undefined) toolCall.id = patch.id
  if (patch.type !== undefined) toolCall.type = patch.type
  if (patch.function) {
    if (patch.function.name !== undefined) toolCall.function.name = patch.function.name
    if (patch.function.arguments !== undefined) toolCall.function.arguments = patch.function.arguments
  }
  return toolCall
}

function appendToolCallArguments (state, toolIndex, argsDelta) {
  const toolCall = ensureToolCall(state, toolIndex)
  toolCall.function.arguments = (toolCall.function.arguments || '') + (argsDelta || '')
  return toolCall
}

function emitToolCallDelta (subscriber, state, toolIndex, delta) {
  subscriber.next(createChunk({
    id: state.id,
    model: state.model,
    type: state.type,
    delta: {
      tool_calls: [{
        index: toolIndex,
        ...delta
      }]
    }
  }))
}

function mergeDeltaIntoFields (fields, delta) {
  if (!delta) return
  for (const field in delta) {
    if (delta[field] === null || delta[field] === undefined) continue
    if (typeof delta[field] === 'string') {
      if (!fields[field]) fields[field] = ''
      fields[field] += delta[field]
    } else if (Array.isArray(delta[field])) {
      if (!fields[field]) fields[field] = []
      for (const element of delta[field]) {
        let { index } = element
        if (index === undefined || index === null) index = 0
        if (!fields[field][index]) fields[field][index] = { index }
        for (const elemField in element) {
          if (elemField === 'index') continue
          if (typeof element[elemField] !== 'object' || element[elemField] === null) {
            if (fields[field][index][elemField] === undefined) fields[field][index][elemField] = element[elemField]
          } else {
            if (!fields[field][index][elemField]) fields[field][index][elemField] = {}
            for (const elemField1 in element[elemField]) {
              if (fields[field][index][elemField][elemField1] === undefined) {
                fields[field][index][elemField][elemField1] = ''
              }
              fields[field][index][elemField][elemField1] += element[elemField][elemField1]
            }
          }
        }
      }
    }
  }
}

function finalMessageFromState (state) {
  const message = { role: 'assistant' }
  if (state.fields.content !== undefined) message.content = state.fields.content
  if (state.fields.tool_calls && state.fields.tool_calls.length) {
    message.tool_calls = state.fields.tool_calls.filter(Boolean)
    if (message.content === undefined || message.content === '') message.content = null
  }
  if (state.fields.reasoning_content) message.reasoning_content = state.fields.reasoning_content
  return message
}

function stringifyArguments (value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (err) {
    return String(value)
  }
}

function openAIResponseItemToToolCall (item, index) {
  if (!item) return null
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return null
  return {
    index,
    id: item.call_id || item.id || generateId(),
    type: 'function',
    function: {
      name: item.name || '',
      arguments: stringifyArguments(item.arguments !== undefined ? item.arguments : item.input)
    }
  }
}

function messageFromOpenAIResponse (response) {
  const message = { role: 'assistant' }
  let content = ''
  const toolCalls = []
  const output = response && Array.isArray(response.output) ? response.output : []

  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text' && part.text) content += part.text
        if (part.type === 'refusal' && part.refusal) content += part.refusal
      }
    }
    const toolCall = openAIResponseItemToToolCall(item, toolCalls.length)
    if (toolCall) toolCalls.push(toolCall)
  }

  if (!content && typeof response.output_text === 'string') content = response.output_text
  if (content) message.content = content
  if (toolCalls.length) {
    message.tool_calls = toolCalls
    if (!message.content) message.content = null
  }
  return message
}

function openaiResponsesObserver (response, model, wasStopped, prefill = '', type = 'chat_completion') {
  if (!wasStopped) throw new Error('No wasStopped')
  let stopped = false

  return new Observable(subscriber => {
    const run = async () => {
      const resolved = await Promise.resolve(response)
      const body = responseBody(resolved)
      const state = {
        id: generateId(),
        model,
        type,
        prefill,
        fields: {},
        usage: undefined,
        outputIndexToToolIndex: {},
        nextToolIndex: 0
      }

      const isStreamish = isBytesLike(body) || isReadableStreamLike(body) || isAsyncIterable(body) || isStream(body)
      if (!isStreamish || (isObjectChunk(body) && !isAsyncIterable(body))) {
        const finalResponse = body && body.response ? body.response : body
        const usage = normalizeUsage(finalResponse && finalResponse.usage)
        subscriber.next({ message: messageFromOpenAIResponse(finalResponse), usage })
        subscriber.complete()
        return
      }

      let completedResponse
      for await (const event of iterateJsonEvents(body, () => stopped || wasStopped())) {
        if (stopped || wasStopped()) break
        if (!event || event.done || event.type === '[DONE]') continue
        if (event.type === 'parse_error') {
          subscriber.next({ error: event.error, raw: event.raw })
          continue
        }

        if (event.response_id) state.id = event.response_id
        if (event.response && event.response.id) state.id = event.response.id
        if (event.response && event.response.model) state.model = event.response.model
        if (event.model) state.model = event.model

        if (event.error || event.type === 'error') {
          subscriber.next({ id: state.id, object: 'error', model: state.model, error: event.error || event })
          continue
        }

        switch (event.type) {
          case 'response.output_text.delta': {
            emitContentDelta(subscriber, state, event.delta || '')
            break
          }
          case 'response.refusal.delta': {
            subscriber.next(createChunk({
              id: state.id,
              model: state.model,
              type: state.type,
              delta: { refusal: event.delta || '' }
            }))
            break
          }
          case 'response.output_item.added': {
            const item = event.item
            const outputIndex = event.output_index || 0
            if (item && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
              const toolIndex = state.outputIndexToToolIndex[outputIndex] !== undefined
                ? state.outputIndexToToolIndex[outputIndex]
                : state.nextToolIndex++
              state.outputIndexToToolIndex[outputIndex] = toolIndex
              const toolCall = openAIResponseItemToToolCall(item, toolIndex)
              setToolCall(state, toolIndex, toolCall)
              emitToolCallDelta(subscriber, state, toolIndex, {
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments || ''
                }
              })
            }
            break
          }
          case 'response.function_call_arguments.delta': {
            const outputIndex = event.output_index || 0
            const toolIndex = state.outputIndexToToolIndex[outputIndex] !== undefined
              ? state.outputIndexToToolIndex[outputIndex]
              : state.nextToolIndex++
            state.outputIndexToToolIndex[outputIndex] = toolIndex
            appendToolCallArguments(state, toolIndex, event.delta || '')
            emitToolCallDelta(subscriber, state, toolIndex, {
              function: { arguments: event.delta || '' }
            })
            break
          }
          case 'response.function_call_arguments.done': {
            const outputIndex = event.output_index || 0
            const toolIndex = state.outputIndexToToolIndex[outputIndex] !== undefined
              ? state.outputIndexToToolIndex[outputIndex]
              : state.nextToolIndex++
            state.outputIndexToToolIndex[outputIndex] = toolIndex
            const toolCall = ensureToolCall(state, toolIndex)
            if (event.arguments !== undefined) toolCall.function.arguments = event.arguments
            break
          }
          case 'response.output_item.done': {
            const item = event.item
            const outputIndex = event.output_index || 0
            if (item && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
              const toolIndex = state.outputIndexToToolIndex[outputIndex] !== undefined
                ? state.outputIndexToToolIndex[outputIndex]
                : state.nextToolIndex++
              state.outputIndexToToolIndex[outputIndex] = toolIndex
              setToolCall(state, toolIndex, openAIResponseItemToToolCall(item, toolIndex))
            }
            break
          }
          case 'response.completed': {
            completedResponse = event.response
            if (completedResponse && completedResponse.usage) {
              state.usage = normalizeUsage(completedResponse.usage)
            }
            break
          }
          case 'response.incomplete':
          case 'response.failed':
          case 'response.cancelled': {
            completedResponse = event.response || completedResponse
            if (completedResponse && completedResponse.usage) {
              state.usage = normalizeUsage(completedResponse.usage)
            }
            break
          }
          default: {
            break
          }
        }
      }

      let message = completedResponse ? messageFromOpenAIResponse(completedResponse) : finalMessageFromState(state)
      if (completedResponse && !message.content && !message.tool_calls) {
        message = finalMessageFromState(state)
      }
      const usage = state.usage || normalizeUsage(completedResponse && completedResponse.usage)
      subscriber.next({ message, usage })
      subscriber.complete()
    }
    run().catch(err => subscriber.error(err))
    return () => { stopped = true; destroyBody(responseBody(response)) }
  })
}

function geminiTextFromChunk (chunk) {
  if (!chunk) return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.text === 'function') return chunk.text()
  let text = ''
  for (const candidate of chunk.candidates || []) {
    const parts = candidate.content && candidate.content.parts ? candidate.content.parts : []
    for (const part of parts) {
      if (part && typeof part.text === 'string') text += part.text
    }
  }
  return text
}

function geminiFunctionCallsFromChunk (chunk) {
  const calls = []
  if (!chunk) return calls
  for (const candidate of chunk.candidates || []) {
    const parts = candidate.content && candidate.content.parts ? candidate.content.parts : []
    for (const part of parts) {
      const functionCall = part.functionCall || part.function_call
      if (functionCall) calls.push(functionCall)
    }
  }
  return calls
}

function geminiFinishReason (chunk) {
  const candidate = chunk && chunk.candidates && chunk.candidates[0]
  if (!candidate) return null
  const reason = candidate.finishReason || candidate.finish_reason
  if (!reason) return null
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT') return 'content_filter'
  return String(reason).toLowerCase()
}

function messageFromGeminiResponse (response) {
  const message = { role: 'assistant' }
  const content = geminiTextFromChunk(response)
  const functionCalls = geminiFunctionCallsFromChunk(response)
  if (content) message.content = content
  if (functionCalls.length) {
    message.tool_calls = functionCalls.map((call, index) => ({
      index,
      id: call.id || call.callId || generateId(),
      type: 'function',
      function: {
        name: call.name || '',
        arguments: stringifyArguments(call.args || call.arguments)
      }
    }))
    if (!message.content) message.content = null
  }
  return message
}

function geminiObserver (response, model, wasStopped, prefill = '', type = 'chat_completion') {
  if (!wasStopped) throw new Error('No wasStopped')
  let stopped = false

  return new Observable(subscriber => {
    const run = async () => {
      const resolved = await Promise.resolve(response)
      const body = responseBody(resolved)
      const state = {
        id: generateId(),
        model,
        type,
        prefill,
        fields: {},
        usage: undefined,
        nextToolIndex: 0
      }

      const isStreamish = isBytesLike(body) || isReadableStreamLike(body) || isAsyncIterable(body) || isStream(body)
      if (!isStreamish || (isObjectChunk(body) && !isAsyncIterable(body))) {
        const usage = normalizeUsage(body && (body.usageMetadata || body.usage_metadata || body.usage))
        subscriber.next({ message: messageFromGeminiResponse(body), usage })
        subscriber.complete()
        return
      }

      let lastChunk
      for await (const chunk of iterateJsonEvents(body, () => stopped || wasStopped())) {
        if (stopped || wasStopped()) break
        if (!chunk || chunk.done || chunk.type === '[DONE]') continue
        if (chunk.type === 'parse_error') {
          subscriber.next({ error: chunk.error, raw: chunk.raw })
          continue
        }

        lastChunk = chunk
        const usage = chunk.usageMetadata || chunk.usage_metadata || chunk.usage
        if (usage) state.usage = normalizeUsage(usage)

        const text = geminiTextFromChunk(chunk)
        if (text) emitContentDelta(subscriber, state, text)

        for (const call of geminiFunctionCallsFromChunk(chunk)) {
          const toolIndex = state.nextToolIndex++
          const toolCall = {
            index: toolIndex,
            id: call.id || call.callId || generateId(),
            type: 'function',
            function: {
              name: call.name || '',
              arguments: stringifyArguments(call.args || call.arguments)
            }
          }
          setToolCall(state, toolIndex, toolCall)
          emitToolCallDelta(subscriber, state, toolIndex, {
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments
            }
          })
        }

        const finishReason = geminiFinishReason(chunk)
        if (finishReason) {
          subscriber.next(createChunk({
            id: state.id,
            model: state.model,
            type: state.type,
            delta: {},
            finishReason,
            usage: state.usage
          }))
        }
      }

      const message = state.fields.content || (state.fields.tool_calls && state.fields.tool_calls.length)
        ? finalMessageFromState(state)
        : messageFromGeminiResponse(lastChunk || body)
      subscriber.next({ message, usage: state.usage })
      subscriber.complete()
    }
    run().catch(err => subscriber.error(err))
    return () => { stopped = true; destroyBody(responseBody(response)) }
  })
}

function anthropicUsageToOpenAI (messageUsage, deltaUsage) {
  const merged = { ...(messageUsage || {}), ...(deltaUsage || {}) }
  return normalizeUsage(merged)
}

function anthropicStopReason (reason) {
  if (!reason) return null
  if (reason === 'end_turn') return 'stop'
  if (reason === 'max_tokens') return 'length'
  if (reason === 'stop_sequence') return 'stop'
  if (reason === 'tool_use') return 'tool_calls'
  return reason
}

function messageFromAnthropicMessage (message) {
  const out = { role: 'assistant' }
  let content = ''
  const toolCalls = []
  for (const block of (message && message.content) || []) {
    if (block.type === 'text' && block.text) content += block.text
    if (block.type === 'tool_use') {
      toolCalls.push({
        index: toolCalls.length,
        id: block.id || generateId(),
        type: 'function',
        function: {
          name: block.name || '',
          arguments: stringifyArguments(block.input)
        }
      })
    }
    if (block.type === 'thinking' && block.thinking) {
      out.reasoning_content = (out.reasoning_content || '') + block.thinking
    }
  }
  if (content) out.content = content
  if (toolCalls.length) {
    out.tool_calls = toolCalls
    if (!out.content) out.content = null
  }
  return out
}

function anthropicObserver (response, model, wasStopped, prefill = '', type = 'chat_completion', options = {}) {
  if (!wasStopped) throw new Error('No wasStopped')
  let stopped = false

  return new Observable(subscriber => {
    const run = async () => {
      const resolved = await Promise.resolve(response)
      const body = responseBody(resolved)
      const state = {
        id: generateId(),
        model,
        type,
        prefill,
        fields: {},
        usage: undefined,
        messageUsage: undefined,
        deltaUsage: undefined,
        blockIndexToToolIndex: {},
        nextToolIndex: 0,
        contentBlocks: {}
      }

      const isStreamish = isBytesLike(body) || isReadableStreamLike(body) || isAsyncIterable(body) || isStream(body)
      if (!isStreamish || (isObjectChunk(body) && !isAsyncIterable(body))) {
        const usage = anthropicUsageToOpenAI(body && body.usage)
        subscriber.next({ message: messageFromAnthropicMessage(body), usage })
        subscriber.complete()
        return
      }

      let finalAnthropicMessage
      for await (const event of iterateJsonEvents(body, () => stopped || wasStopped())) {
        if (stopped || wasStopped()) break
        if (!event || event.done || event.type === '[DONE]') continue
        if (event.type === 'parse_error') {
          subscriber.next({ error: event.error, raw: event.raw })
          continue
        }

        if (event.type === 'error') {
          subscriber.next({ id: state.id, object: 'error', model: state.model, error: event.error || event })
          continue
        }

        switch (event.type) {
          case 'message_start': {
            finalAnthropicMessage = event.message
            if (event.message && event.message.id) state.id = event.message.id
            if (event.message && event.message.model) state.model = event.message.model
            if (event.message && event.message.usage) {
              state.messageUsage = event.message.usage
              state.usage = anthropicUsageToOpenAI(state.messageUsage, state.deltaUsage)
            }
            break
          }
          case 'content_block_start': {
            const block = event.content_block || event.contentBlock || {}
            state.contentBlocks[event.index] = { ...block, input_json: '' }
            if (block.type === 'tool_use') {
              const toolIndex = state.nextToolIndex++
              state.blockIndexToToolIndex[event.index] = toolIndex
              const toolCall = {
                index: toolIndex,
                id: block.id || generateId(),
                type: 'function',
                function: {
                  name: block.name || '',
                  arguments: block.input && Object.keys(block.input).length ? stringifyArguments(block.input) : ''
                }
              }
              setToolCall(state, toolIndex, toolCall)
              emitToolCallDelta(subscriber, state, toolIndex, {
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments
                }
              })
            }
            break
          }
          case 'content_block_delta': {
            const delta = event.delta || {}
            const block = state.contentBlocks[event.index] || {}
            state.contentBlocks[event.index] = block

            if (delta.type === 'text_delta') {
              block.text = (block.text || '') + (delta.text || '')
              emitContentDelta(subscriber, state, delta.text || '')
            } else if (delta.type === 'input_json_delta') {
              const toolIndex = state.blockIndexToToolIndex[event.index] !== undefined
                ? state.blockIndexToToolIndex[event.index]
                : state.nextToolIndex++
              state.blockIndexToToolIndex[event.index] = toolIndex
              block.input_json = (block.input_json || '') + (delta.partial_json || '')
              appendToolCallArguments(state, toolIndex, delta.partial_json || '')
              emitToolCallDelta(subscriber, state, toolIndex, {
                function: { arguments: delta.partial_json || '' }
              })
            } else if (delta.type === 'thinking_delta') {
              block.thinking = (block.thinking || '') + (delta.thinking || '')
              state.fields.reasoning_content = (state.fields.reasoning_content || '') + (delta.thinking || '')
              if (options.emitThinking) {
                subscriber.next(createChunk({
                  id: state.id,
                  model: state.model,
                  type: state.type,
                  delta: { reasoning_content: delta.thinking || '' }
                }))
              }
            } else if (delta.type === 'signature_delta') {
              block.signature = delta.signature
            }
            break
          }
          case 'content_block_stop': {
            const block = state.contentBlocks[event.index]
            if (block && block.type === 'tool_use') {
              const toolIndex = state.blockIndexToToolIndex[event.index]
              const toolCall = ensureToolCall(state, toolIndex)
              if (block.input_json !== undefined) toolCall.function.arguments = block.input_json
            }
            break
          }
          case 'message_delta': {
            if (event.usage) {
              state.deltaUsage = event.usage
              state.usage = anthropicUsageToOpenAI(state.messageUsage, state.deltaUsage)
            }
            const finishReason = anthropicStopReason(event.delta && event.delta.stop_reason)
            if (finishReason) {
              subscriber.next(createChunk({
                id: state.id,
                model: state.model,
                type: state.type,
                delta: {},
                finishReason,
                usage: state.usage
              }))
            }
            break
          }
          case 'message_stop': {
            break
          }
          default: {
            break
          }
        }
      }

      const message = state.fields.content || (state.fields.tool_calls && state.fields.tool_calls.length) || state.fields.reasoning_content
        ? finalMessageFromState(state)
        : messageFromAnthropicMessage(finalAnthropicMessage || body)
      subscriber.next({ message, usage: state.usage })
      subscriber.complete()
    }
    run().catch(err => subscriber.error(err))
    return () => { stopped = true; destroyBody(responseBody(response)) }
  })
}

function awsConverseBody (response) {
  const body = responseBody(response)
  if (body && body.stream !== undefined) return body.stream
  if (body && body.outputStream !== undefined) return body.outputStream
  if (body && body.output_stream !== undefined) return body.output_stream
  return body
}

function normalizeAwsConverseUsage (usage) {
  if (!usage) return undefined

  const normalized = normalizeUsage(usage) || {}

  if (usage.inputTokens !== undefined) normalized.prompt_tokens = usage.inputTokens
  if (usage.outputTokens !== undefined) normalized.completion_tokens = usage.outputTokens
  if (usage.totalTokens !== undefined) normalized.total_tokens = usage.totalTokens

  if (usage.cacheReadInputTokens !== undefined) {
    normalized.prompt_tokens_details = normalized.prompt_tokens_details || {}
    normalized.prompt_tokens_details.cached_tokens = usage.cacheReadInputTokens
  }

  normalized.provider_usage = usage
  return normalized
}

function awsConverseStopReason (reason) {
  if (!reason) return null
  if (reason === 'end_turn') return 'stop'
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'max_tokens') return 'length'
  if (reason === 'stop_sequence') return 'stop'
  if (reason === 'guardrail_intervened' || reason === 'content_filtered') return 'content_filter'
  if (reason === 'model_context_window_exceeded') return 'length'
  return reason
}

function awsToolUseId (toolUse) {
  return toolUse.toolUseId || toolUse.tool_use_id || toolUse.id || generateId()
}

function awsReasoningText (reasoningContent) {
  if (!reasoningContent) return ''
  if (typeof reasoningContent.text === 'string') return reasoningContent.text
  if (reasoningContent.reasoningText && typeof reasoningContent.reasoningText.text === 'string') {
    return reasoningContent.reasoningText.text
  }
  if (reasoningContent.reasoning_text && typeof reasoningContent.reasoning_text.text === 'string') {
    return reasoningContent.reasoning_text.text
  }
  return ''
}

function messageFromAwsConverseResponse (response) {
  const outputMessage = response && response.output && response.output.message
    ? response.output.message
    : response && response.message
      ? response.message
      : response && response.output && response.output.content
        ? response.output
        : response

  const message = { role: (outputMessage && outputMessage.role) || 'assistant' }
  const blocks = Array.isArray(outputMessage && outputMessage.content) ? outputMessage.content : []
  let content = ''
  const toolCalls = []

  for (const block of blocks) {
    if (!block) continue

    if (typeof block.text === 'string') {
      content += block.text
    }

    if (block.citationsContent && Array.isArray(block.citationsContent.content)) {
      for (const citationPart of block.citationsContent.content) {
        if (citationPart && typeof citationPart.text === 'string') content += citationPart.text
      }
    }

    const reasoningText = awsReasoningText(block.reasoningContent || block.reasoning_content)
    if (reasoningText) {
      message.reasoning_content = (message.reasoning_content || '') + reasoningText
    }

    const toolUse = block.toolUse || block.tool_use
    if (toolUse) {
      toolCalls.push({
        index: toolCalls.length,
        id: awsToolUseId(toolUse),
        type: 'function',
        function: {
          name: toolUse.name || '',
          arguments: stringifyArguments(toolUse.input)
        }
      })
    }
  }

  if (content) message.content = content
  if (toolCalls.length) {
    message.tool_calls = toolCalls
    if (!message.content) message.content = null
  }

  return message
}

function awsConverseObserver (response, model, wasStopped, prefill = '', type = 'chat_completion', options = {}) {
  if (!wasStopped) throw new Error('No wasStopped')

  let stopped = false
  let currentBody

  return new Observable(subscriber => {
    const run = async () => {
      const resolved = await Promise.resolve(response)
      const body = awsConverseBody(resolved)
      currentBody = body

      const state = {
        id: generateId(),
        model,
        type,
        prefill,
        fields: {},
        usage: undefined,
        role: 'assistant',
        stopReason: undefined,
        blockIndexToToolIndex: {},
        nextToolIndex: 0,
        contentBlocks: {}
      }

      const isStreamish = isBytesLike(body) || isReadableStreamLike(body) || isAsyncIterable(body) || isStream(body)

      if (!isStreamish || (isObjectChunk(body) && !isAsyncIterable(body))) {
        const usage = normalizeAwsConverseUsage(body && body.usage)
        subscriber.next({
          message: messageFromAwsConverseResponse(body),
          usage
        })
        subscriber.complete()
        return
      }

      for await (const event of iterateJsonEvents(body, () => stopped || wasStopped())) {
        if (stopped || wasStopped()) break
        if (!event || event.done || event.type === '[DONE]') continue

        if (event.type === 'parse_error') {
          subscriber.next({ error: event.error, raw: event.raw })
          continue
        }

        const errorKey = [
          'internalServerException',
          'modelStreamErrorException',
          'serviceUnavailableException',
          'throttlingException',
          'validationException'
        ].find(key => event[key])

        if (errorKey) {
          subscriber.next({
            id: state.id,
            object: 'error',
            model: state.model,
            error: event[errorKey],
            provider_error_type: errorKey
          })
          continue
        }

        const messageStart = event.messageStart || event.message_start
        if (messageStart) {
          state.role = messageStart.role || 'assistant'
          subscriber.next(createChunk({
            id: state.id,
            model: state.model,
            type: state.type,
            delta: { role: state.role }
          }))
          continue
        }

        const contentBlockStart = event.contentBlockStart || event.content_block_start
        if (contentBlockStart) {
          const blockIndex = contentBlockStart.contentBlockIndex ?? contentBlockStart.content_block_index ?? 0
          const start = contentBlockStart.start || {}

          state.contentBlocks[blockIndex] = {
            start,
            text: '',
            toolUseInput: '',
            reasoning: ''
          }

          const toolUse = start.toolUse || start.tool_use
          if (toolUse) {
            const toolIndex = state.nextToolIndex++
            state.blockIndexToToolIndex[blockIndex] = toolIndex

            const toolCall = {
              index: toolIndex,
              id: awsToolUseId(toolUse),
              type: 'function',
              function: {
                name: toolUse.name || '',
                arguments: stringifyArguments(toolUse.input)
              }
            }

            setToolCall(state, toolIndex, toolCall)

            emitToolCallDelta(subscriber, state, toolIndex, {
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
              }
            })
          }

          continue
        }

        const contentBlockDelta = event.contentBlockDelta || event.content_block_delta
        if (contentBlockDelta) {
          const blockIndex = contentBlockDelta.contentBlockIndex ?? contentBlockDelta.content_block_index ?? 0
          const delta = contentBlockDelta.delta || {}

          const block = state.contentBlocks[blockIndex] || {
            text: '',
            toolUseInput: '',
            reasoning: ''
          }
          state.contentBlocks[blockIndex] = block

          if (typeof delta.text === 'string') {
            block.text += delta.text
            emitContentDelta(subscriber, state, delta.text)
          }

          const reasoning = delta.reasoningContent || delta.reasoning_content
          const reasoningText = awsReasoningText(reasoning)

          if (reasoningText) {
            block.reasoning += reasoningText
            state.fields.reasoning_content = (state.fields.reasoning_content || '') + reasoningText

            if (options.emitReasoning || options.emitThinking) {
              subscriber.next(createChunk({
                id: state.id,
                model: state.model,
                type: state.type,
                delta: { reasoning_content: reasoningText }
              }))
            }
          }

          const toolUse = delta.toolUse || delta.tool_use
          if (toolUse && toolUse.input !== undefined) {
            const toolIndex = state.blockIndexToToolIndex[blockIndex] !== undefined
              ? state.blockIndexToToolIndex[blockIndex]
              : state.nextToolIndex++

            state.blockIndexToToolIndex[blockIndex] = toolIndex
            block.toolUseInput += toolUse.input || ''

            appendToolCallArguments(state, toolIndex, toolUse.input || '')

            emitToolCallDelta(subscriber, state, toolIndex, {
              function: { arguments: toolUse.input || '' }
            })
          }

          continue
        }

        const contentBlockStop = event.contentBlockStop || event.content_block_stop
        if (contentBlockStop) {
          const blockIndex = contentBlockStop.contentBlockIndex ?? contentBlockStop.content_block_index ?? 0
          const block = state.contentBlocks[blockIndex]
          const toolIndex = state.blockIndexToToolIndex[blockIndex]

          if (block && toolIndex !== undefined) {
            const toolCall = ensureToolCall(state, toolIndex)
            toolCall.function.arguments = block.toolUseInput || toolCall.function.arguments || ''
          }

          continue
        }

        const messageStop = event.messageStop || event.message_stop
        if (messageStop) {
          state.stopReason = messageStop.stopReason || messageStop.stop_reason

          subscriber.next(createChunk({
            id: state.id,
            model: state.model,
            type: state.type,
            delta: {},
            finishReason: awsConverseStopReason(state.stopReason),
            usage: state.usage
          }))

          continue
        }

        const metadata = event.metadata || event.meta
        if (metadata) {
          if (metadata.usage) state.usage = normalizeAwsConverseUsage(metadata.usage)
          continue
        }
      }

      const message = finalMessageFromState(state)
      message.role = state.role || message.role || 'assistant'

      subscriber.next({
        message,
        usage: state.usage
      })
      subscriber.complete()
    }

    run().catch(err => subscriber.error(err))

    return () => {
      stopped = true
      destroyBody(currentBody)
    }
  })
}

function observerForProvider (provider) {
  const name = String(provider || '').toLowerCase().replace(/[._-]/g, '')
  if (name === 'openairesponses' || name === 'responses' || name === 'responseapi') return openaiResponsesObserver
  if (name === 'gemini' || name === 'google' || name === 'googleai' || name === 'googlegenai') return geminiObserver
  if (name === 'anthropic' || name === 'claude') return anthropicObserver
  if (name === 'converse') {
    return awsConverseObserver
  }
  return chatObserver
}

function providerObserver (provider, response, model, wasStopped, options = {}) {
  const observer = options.observer || observerForProvider(provider)
  return observer(response, model, wasStopped, options.prefill || '', options.type || 'chat_completion', options)
}

const toolCallAdapter = (provider, rsp, wasStopped, processToolCalls, adapterOptions = {}) => {
  return {
    chat: async (messages, options) => {
      const { model } = options
      const response = await provider.chat(messages, options)
      const stopper = new Subject()
      const stop = () => {
        stopper.next()
        stopper.complete()
      }
      const checkStopped = () => {
        if (wasStopped()) {
          stop()
          return true
        }
        return false
      }
      const observe = response => {
        if (adapterOptions.observer) {
          return adapterOptions.observer(response, model, wasStopped, adapterOptions.prefill || '', adapterOptions.type || 'chat_completion', adapterOptions)
        }
        if (adapterOptions.provider) {
          return providerObserver(adapterOptions.provider, response, model, wasStopped, adapterOptions)
        }
        return chatObserver(response, model, wasStopped, adapterOptions.prefill || '', adapterOptions.type || 'chat_completion')
      }
      const process = response => {
        return observe(response).pipe(flatMap(x => {
          if (checkStopped()) {
            return []
          }
          if (!x.message) {
            rsp.write('data: ')
            rsp.write(JSON.stringify(x))
            rsp.write('\n\n')
          } else {
            const { message, usage } = x
            const { tool_calls } = message
            if (tool_calls) {
              const sendProgress = json => {
                rsp.write('data: ')
                rsp.write(JSON.stringify(json))
                rsp.write('\n\n')
              }
              const responses = from(processToolCalls(model, message, usage, wasStopped, sendProgress))
              if (checkStopped()) {
                return []
              }
              messages.push(message)
              return concat(of(message),
                responses.pipe(flatMap(results => {
                  messages = messages.concat(results)
                  return concat(from(results), from(provider.chat(messages, options)).pipe(flatMap(response1 => {
                    return process(response1)
                  })))
                })))
            }
            return of(x)
          }
          return []
        }))
      }
      return process(response).pipe(takeUntil(stopper))
    }
  }
}

module.exports = {
  chatObserver,
  openaiResponsesObserver,
  responsesObserver: openaiResponsesObserver,
  geminiObserver,
  anthropicObserver,
  converseObserver: awsConverseObserver,
  providerObserver,
  observerForProvider,
  observableToStream,
  observableToReadableStream,
  insertContent,
  toolCallAdapter,
  normalizeUsage,
  iterateJsonEvents
}
