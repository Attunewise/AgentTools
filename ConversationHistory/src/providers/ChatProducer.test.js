const test = require('node:test')
const assert = require('node:assert/strict')
const {
  legacyDocsToAnnotatedChatIR,
  materializeExplicit
} = require('../lib/transcriptIr.js')
const {
  toAnthropicMessages,
  toGemini,
  toOpenAIResponses
} = require('./ChatProducer.js')

test('OpenAI Responses reconstructs encrypted reasoning from Attunewise think signatures', () => {
  const ir = legacyDocsToAnnotatedChatIR('openai-signed', {
    id: 'openai-signed',
    model: 'gpt-5.4'
  }, [{
    id: 'm1',
    data: {
      role: 'user',
      task: 'openai-signed',
      content: 'What happened?',
      models: [{
        model: 'gpt-5.4',
        addedToTranscript: [{
          message: {
            role: 'assistant',
            content: '<think>\n<openai-sig>encrypted-openai-block</openai-sig>\nChecked the todo sync trace.\n</think>\nIt was a stale workspace id.'
          }
        }, {
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              geminiSignature: 'gemini-sig-stays-on-original-call',
              function: {
                name: 'conversation.search',
                arguments: '{"query":"todo sync"}'
              }
            }]
          }
        }]
      }]
    }
  }])

  const materialized = materializeExplicit(ir)
  assert.match(materialized.messages[1].content, /<openai-sig>encrypted-openai-block<\/openai-sig>/)
  assert.equal(materialized.messages[2].tool_calls[0].geminiSignature, 'gemini-sig-stays-on-original-call')

  const produced = toOpenAIResponses(materialized.messages, { model: 'openai.gpt-5.4' })
  const reasoning = produced.request.input.find(item => item.type === 'reasoning')
  assert.ok(reasoning)
  assert.equal(reasoning.encrypted_content, 'encrypted-openai-block')
  assert.deepEqual(reasoning.summary, [{ type: 'summary_text', text: 'Checked the todo sync trace.' }])

  const assistantText = produced.request.input.find(item => item.role === 'assistant')
  assert.ok(assistantText)
  assert.doesNotMatch(JSON.stringify(assistantText), /openai-sig/)
  assert.match(JSON.stringify(assistantText), /Checked the todo sync trace/)

  const gemini = toGemini(materialized.messages, { model: 'gemini-2.5-pro' })
  const toolCallPart = gemini.request.contents
    .flatMap(item => item.parts)
    .find(part => part.functionCall && part.functionCall.name === 'conversation.search')
  assert.ok(toolCallPart)
  assert.equal(toolCallPart.thoughtSignature, 'gemini-sig-stays-on-original-call')
})

test('OpenAI Responses strips dangling encrypted signature tails from visible text', () => {
  const produced = toOpenAIResponses([{
    role: 'assistant',
    content: '<think>partial summary<openai-sig>gAAAAAB-broken-ciphertext</think>\nVisible answer.'
  }], { model: 'openai.gpt-5.4' })

  const payload = JSON.stringify(produced.request.input)
  assert.doesNotMatch(payload, /<openai-sig>/)
  assert.doesNotMatch(payload, /broken-ciphertext/)
  assert.match(payload, /partial summary/)
  assert.match(payload, /Visible answer/)
})

test('Anthropic request reconstructs signed thinking blocks from Attunewise transcript text', () => {
  const ir = legacyDocsToAnnotatedChatIR('claude-signed', {
    id: 'claude-signed',
    model: 'claude-4.8-opus'
  }, [{
    id: 'm1',
    data: {
      role: 'user',
      task: 'claude-signed',
      content: 'What did you inspect?',
      models: [{
        model: 'claude-4.8-opus',
        addedToTranscript: [{
          message: {
            role: 'assistant',
            content: '<think>I inspected the browser trace.<signed>encrypted-claude-signature</signed></think>\nThe active tab was the workspace page.'
          }
        }]
      }]
    }
  }])

  const materialized = materializeExplicit(ir)
  assert.match(materialized.messages[1].content, /<signed>encrypted-claude-signature<\/signed>/)

  const produced = toAnthropicMessages(materialized.messages, { model: 'claude-4.8-opus' })
  const assistant = produced.request.messages.find(message => message.role === 'assistant')
  assert.ok(assistant)
  const thinking = assistant.content.find(part => part.type === 'thinking')
  assert.ok(thinking)
  assert.equal(thinking.thinking, 'I inspected the browser trace.')
  assert.equal(thinking.signature, 'encrypted-claude-signature')
  assert.ok(assistant.content.some(part => part.type === 'text' && /active tab/.test(part.text)))
})
