const { execFileSync } = require('child_process')
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand
} = require('@aws-sdk/client-bedrock-runtime')
const { Readable } = require('stream')
const path = require('path')
const { ChatProducer } = require('./ChatProducer.js')

const DEFAULT_MODEL = 'us.anthropic.claude-opus-4-7'
const DEFAULT_REGION = 'us-east-1'

const CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' }

class BedrockAnthropicProvider {
  constructor (options = {}) {
    this.cwd = options.cwd || __dirname
    this.model = options.model || DEFAULT_MODEL
    this.region = options.region || DEFAULT_REGION
    this.producer = new ChatProducer('bedrockAnthropic', {
      options: options.producerOptions || {}
    })
  }

  async chat (messages, options = {}) {
    const produced = this.producer.produce(messages, {
      model: options.model || this.model,
      max_tokens: options.max_tokens || options.max_completion_tokens || 1800,
      tools: options.tools,
      tool_choice: options.tool_choice,
      ...cacheOptions(options)
    })
    const data = options.stream === false
      ? anthropicMessageToSseStream(await invokeBedrock({
          cwd: this.cwd,
          region: options.region || this.region,
          model: options.model || this.model,
          request: produced.request,
          signal: options.signal
        }))
      : await invokeBedrockStream({
          cwd: this.cwd,
          region: options.region || this.region,
          model: options.model || this.model,
          request: produced.request,
          signal: options.signal
        })
    return {
      data,
      request: produced
    }
  }
}

const cacheOptions = options => {
  if (options.cache_control === false) return {}
  return {
    cache_control: options.cache_control || CACHE_CONTROL
  }
}

const bedrockClient = ({ cwd, region }) => new BedrockRuntimeClient({
  region,
  credentials: resolveCredentials(cwd)
})

const invokeBedrockStream = async ({ cwd, region, model, request, signal }) => {
  const client = bedrockClient({ cwd, region })
  const response = await client.send(new InvokeModelWithResponseStreamCommand({
    modelId: model,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(request))
  }), { abortSignal: signal })

  return bedrockAnthropicEventStreamToSseStream(response.body)
}

const invokeBedrock = async ({ cwd, region, model, request, signal }) => {
  const client = bedrockClient({ cwd, region })
  const response = await client.send(new InvokeModelCommand({
    modelId: model,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(request))
  }), { abortSignal: signal })

  return JSON.parse(Buffer.from(response.body).toString('utf8'))
}

const resolveCredentials = cwd => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ||
    runScript(path.join(cwd, 'bin', 'print_bedrock_access_key_id.sh'))
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ||
    runScript(path.join(cwd, 'bin', 'print_bedrock_secret_access_key.sh'))
  const credentials = { accessKeyId, secretAccessKey }
  if (process.env.AWS_SESSION_TOKEN) credentials.sessionToken = process.env.AWS_SESSION_TOKEN
  return credentials
}

const bedrockAnthropicEventStreamToSseStream = eventStream => {
  return Readable.from(iterBedrockAnthropicSse(eventStream))
}

async function * iterBedrockAnthropicSse (eventStream) {
  if (!eventStream || !eventStream[Symbol.asyncIterator]) {
    throw new Error('Bedrock response did not include a streaming body')
  }

  for await (const event of eventStream) {
    const payloads = bedrockEventPayloads(event)
    for (const payload of payloads) {
      const eventName = payload.type || 'message'
      yield `event: ${eventName}\n`
      yield `data: ${JSON.stringify(payload)}\n\n`
    }
  }
}

const bedrockEventPayloads = event => {
  if (event && event.chunk && event.chunk.bytes) {
    return parseJsonPayloads(Buffer.from(event.chunk.bytes).toString('utf8'))
  }

  const errorKey = [
    'internalServerException',
    'modelStreamErrorException',
    'serviceUnavailableException',
    'throttlingException',
    'validationException'
  ].find(key => event && event[key])

  if (errorKey) {
    const detail = event[errorKey]
    const message = detail && (detail.message || detail.originalMessage)
      ? detail.message || detail.originalMessage
      : JSON.stringify(detail || event)
    throw new Error(`Bedrock stream ${errorKey}: ${message}`)
  }

  return []
}

const parseJsonPayloads = text => {
  const trimmed = text.trim()
  if (!trimmed) return []

  try {
    return [JSON.parse(trimmed)]
  } catch (singleError) {
    const out = []
    for (const line of trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
      try {
        out.push(JSON.parse(line))
      } catch (lineError) {
        throw new Error(`Invalid Bedrock Anthropic stream JSON: ${lineError.message}: ${line}`)
      }
    }
    return out
  }
}

const anthropicMessageToSseStream = message => {
  const chunks = []
  const id = message.id || `msg_${Date.now()}`
  const model = message.model || DEFAULT_MODEL
  const usage = message.usage || {}

  pushEvent(chunks, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0
      }
    }
  })

  for (let index = 0; index < (message.content || []).length; index++) {
    const block = message.content[index]
    pushEvent(chunks, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: block.type === 'tool_use'
        ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
        : { type: 'text', text: '' }
    })
    if (block.type === 'tool_use') {
      pushEvent(chunks, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input || {})
        }
      })
    } else {
      pushEvent(chunks, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'text_delta',
          text: block.text || ''
        }
      })
    }
    pushEvent(chunks, 'content_block_stop', {
      type: 'content_block_stop',
      index
    })
  }

  pushEvent(chunks, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason || null,
      stop_sequence: message.stop_sequence || null
    },
    usage: {
      output_tokens: usage.output_tokens || 0
    }
  })
  pushEvent(chunks, 'message_stop', { type: 'message_stop' })

  return Readable.from(chunks)
}

const pushEvent = (chunks, event, data) => {
  chunks.push(`event: ${event}\n`)
  chunks.push(`data: ${JSON.stringify(data)}\n\n`)
}

const runScript = script => execFileSync(script, { encoding: 'utf8' }).trim()

module.exports = {
  BedrockAnthropicProvider,
  anthropicMessageToSseStream,
  bedrockAnthropicEventStreamToSseStream,
  CACHE_CONTROL
}
