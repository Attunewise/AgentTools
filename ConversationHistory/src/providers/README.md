# Cloud Provider Adapters

`Cloud/providers` is the boundary between Attune's OpenAI-ish transcript IR and
real model transports. Everything outside this folder should think in terms of
assembled/materialized chat IR; everything inside this folder may know about
OpenAI Responses, Chat Completions, Anthropic Messages, Bedrock event streams,
Gemini, AWS Converse, Codex credentials, and provider-specific usage shapes.

The contract is deliberately two-directional:

```txt
Annotated transcript IR
  -> explicit materializer
  -> OpenAI-ish chat messages/tools
  -> ChatProducer
  -> provider HTTP request
  -> provider stream/response
  -> ChatObserver/providerObserver
  -> OpenAI-ish assistant/tool message + normalized usage
  -> transcript persistence
```

The transcript layer owns persistence, masks, addresses, versions, and tool
dispatch. Provider adapters only translate request/response formats and perform
transport.

## Request Side: Producers

[ChatProducer.js](./ChatProducer.js) converts OpenAI Chat Completions-shaped
messages and OpenAI-style tool definitions into provider request bodies.

Current producers:

- `toOpenAIChat`: OpenAI Chat Completions shape.
- `toOpenAIResponses`: OpenAI Responses shape using [Responses.js](./Responses.js)
  to convert chat messages into `{ instructions, input }`.
- `toOpenAICodexResponses`: Codex-flavored OpenAI Responses request. Adds Codex
  defaults like `store`, `stream`, `include`, prompt cache key, and tool choice.
- `toAnthropicMessages`: Anthropic Messages request shape.
- `toBedrockAnthropic`: Bedrock wrapper around Anthropic Messages.
- `toGemini`: Gemini `generateContent` request shape.
- `toAwsConverse`: AWS Converse request shape.

Provider tool names are normalized with `providerToolName`. Dots become double
underscores for providers that reject dotted tool names, so an IR tool named
`datetime.now` may be sent as `datetime__now`. Tool dispatch must normalize names
back before selecting an adapter.

Important: producers receive already-materialized input. They must not decide
what masks mean, silently omit masked IR, repair transcript shape, or invent
conversation semantics.

## Response Side: Observers

[ChatObserver.js](./ChatObserver.js) normalizes provider streams and non-stream
responses back into OpenAI-ish chat messages and OpenAI-ish usage objects.

The main entry point is:

```js
providerObserver(provider, response, model, wasStopped, options)
```

Current observers include:

- OpenAI/Chat-style SSE.
- OpenAI Responses event streams.
- Anthropic Messages streams, including text and tool-use blocks.
- Gemini streams.
- AWS Converse streams.

Observers emit provider chunks for UI streaming and eventually emit a terminal:

```js
{
  message: {
    role: 'assistant',
    content?: string | Array<unknown>,
    tool_calls?: Array<ToolCall>
  },
  usage: {
    prompt_tokens?: number,
    completion_tokens?: number,
    total_tokens?: number
  }
}
```

The run loop persists only the final assistant/tool messages by default. Making
partial streaming chunks persistent is a separate explicit mode.

## Concrete Real Transports

[OpenAICodexResponsesProvider.js](./OpenAICodexResponsesProvider.js) calls the
ChatGPT/Codex backend through the Codex OAuth credentials in `~/.codex/auth.json`.
It uses `ChatProducer('openai-codex-responses')` and returns a web `ReadableStream`
plus the produced request metadata.

[BedrockAnthropicProvider.js](./BedrockAnthropicProvider.js) calls AWS Bedrock
Anthropic models. It uses `ChatProducer('bedrockAnthropic')`, resolves AWS
credentials from environment variables or the local `bin/print_bedrock_*`
scripts, and adapts Bedrock's event stream into Anthropic-style SSE so the
shared observer path can consume it.

These are the first real LLM transports to keep working while the provider
registry becomes more pluggable.

## Provider Registry

The UI-visible model/provider list lives in the `modelProviders` collection, not
inside this folder. A provider record describes display names, selected model,
capabilities, pricing, and source. This folder supplies the executable adapter
for records whose selected model is actually run.

Current local records include:

- `openai-codex`: built-in cloud provider using `OpenAICodexResponsesProvider`.
- `bedrock-anthropic`: built-in cloud provider using `BedrockAnthropicProvider`.
- `models-dev`: placeholder for a pluggable model registry source such as
  `anomalyco/models.dev`.

Future local providers may point at OpenAI-compatible URLs. Desktop-hosted local
models are addressed through the desktop protocol, for example:

```text
desktop://host/v1/chat/completions
```

Those should look like provider choices to the UI, but route through Desktop
rather than directly through Cloud HTTP.

## How The Run Loop Uses Providers

[Cloud/server.js](../server.js) currently does the following in `runTranscript`:

1. Append an optional user message with timestamp and `utcOffset` annotations.
2. Assemble annotated IR from persistent collections.
3. Materialize explicit OpenAI-ish messages and tools.
4. Call `callProvider(providerName, materialized, options)`.
5. Observe the provider response with `providerObserver`.
6. Persist the final assistant message and usage.
7. Dispatch any tool calls.
8. Persist tool results.
9. Repeat for a bounded number of tool rounds.

The first smoke path proved this with `datetime.now`.

## Next Hookup Work

The next real-LLM step should be small and boring:

1. Replace the hardcoded provider selection in `callProvider` with a registry
   lookup from the transcript's `modelProviderRef` and selected model.
2. Keep the current OpenAI Codex and Bedrock Anthropic classes as the first
   executable registry backends.
3. Add one common provider interface:

   ```js
   provider.chat(messages, {
     model,
     tools,
     tool_choice,
     max_tokens,
     temperature,
     sessionId,
     signal,
     stream
   })
   ```

4. Preserve the explicit materializer boundary before provider calls.
5. Preserve observer normalization after provider calls.
6. Route `desktop://...` model providers through the shared desktop protocol
   instead of trying to call them from this folder directly.

Anything related to masks, transcript search, version pointers, or tool-call
dispatch belongs outside `Cloud/providers`. Providers are translators and
transports; the IR remains the source of truth.
