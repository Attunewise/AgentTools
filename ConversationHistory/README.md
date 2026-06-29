# Conversation History

- Keeps a hierarchical index of the transcript up to the last compaction record.
- It supports incremental search and browse, with paging and token-budgeted opening.
- Higher zoom levels are compressed/navigation layers.
- The lowest zoom level is lossless, so exact recovery is possible.
- Its purpose is to prevent context-loss confabulation while avoiding dumping giant transcripts into the active context.
After installing this codex plugin when you start a new session that you'd like it index:

```/conversation_history start indexing```

`conversation_history` indexes coding-agent conversation logs into a hierarchical, paged transcript memory. The CLI remains the local runtime and worker harness.

Source adapters:

- Codex JSONL sessions under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

Planned source adapters:

- Claude Code JSONL sessions under `~/.claude/projects/<slug>/<uuid>.jsonl`
- PI sessions under ~/.pi/agent/sessions/
- Antigravity
- Cursor

The IR is coding-tool independent. It preserves model-family-specific reasoning material for OpenAI, Anthropic, and Google/Gemini where session logs expose summaries, encrypted blocks, or signatures.

```sh
npm install
npm test

./bin/session-indexer-mcp

node bin/session-indexer.js inspect --source codex --latest
node bin/session-indexer.js search_server_status
node bin/session-indexer.js start_indexing_session --scope this_session_only --this-chat --session-marker conversation_history-session-... --timeout-ms 30000
node bin/session-indexer.js search --query "emergency handoff"
node bin/session-indexer.js browse --index-id ...
node bin/session-indexer.js browse --index-id ... --handle 'session/.../event/...' --zoom in
node bin/session-indexer.js openLink --link 'tool:conversation_history://open?indexId=...&handle=...'
node bin/session-indexer.js stop_indexing_session --scope this_session_only --this-chat --session-marker conversation_history-session-... --timeout-ms 30000
node bin/session-indexer.js list_models --filter gpt --limit 10
node bin/session-indexer.js get_pricing --model-id openai/gpt-4o-2024-08-06
node bin/session-indexer.js get_cost --model-id openai/gpt-4o-2024-08-06 --session-id ...
node bin/session-indexer.js deploy --target codex
node bin/session-indexer.js deploy --target codex-plugin
node bin/session-indexer.js deploy --target claude-plugin
node bin/session-indexer.js inspect --source claude --latest
node bin/session-indexer.js watch --source codex --latest
```

MCP tools:

- `conversation_search`
- `conversation_browse`
- `conversation_openLink`
- `conversation_index_status` with required `start_at` and `limit`
- `start_indexing_session`
- `stop_indexing_session`
- `reset_session_index`
- `redeploy_session_index_mcp`
- `conversation_list_models`
- `conversation_get_cost`

Token usage is normalized to the models.dev pricing fields: `input`, `output`, `cache_read`, `cache_write`, `reasoning`, and `total`.

Local runtime state defaults to a shared user-level directory: `$SESSION_INDEXER_STATE_DIR`, or otherwise `$XDG_DATA_HOME/session-indexer/.session-indexer` / `~/.local/share/session-indexer/.session-indexer`. That keeps one managed conversation_history Typesense server and collection for all plugin copies and all supported agents on the host. Every indexed record carries a definitive facetable `indexId`, plus facetable `sessionId` and `agent` visibility/filter fields; `--index-dir` is a development/test override. `deploy --target codex` installs the repo as a direct Codex skill. `deploy --target codex-plugin` installs the repo as a local Codex plugin and updates the personal plugin marketplace unless `--no-marketplace` is passed. `deploy --target claude-plugin` installs the repo as a Claude Code plugin under `~/.claude/plugins` and writes a Claude marketplace entry; the deploy output prints the `claude plugin marketplace add` / `claude plugin install` commands to finish installation.

Durable transcript-derived state is JSONL. `sessions/*.ir.jsonl` is a source-pointer header that preserves the published `indexId`, source path/fingerprint, and session metadata; it does not store transcript leaves or generated summaries. `sessions/*.docs.jsonl` stores compact document metadata, and `sessions/*.summary-targets.jsonl` stores completed summary targets. Typesense stores searchable/navigation fields only, not raw leaf content. `openLink` resolves a link to its session and then renders from source JSONL plus completed summary targets, so exact evidence comes from the transcript source rather than the search index.

For team distribution through Codex, the public AgentTools repo at `https://github.com/Attunewise/AgentTools` includes a Git-backed marketplace at `.agents/plugins/marketplace.json`. Add the marketplace from the repo rather than installing from a local path:

```sh
codex plugin marketplace add https://github.com/Attunewise/AgentTools.git
```

Then install `conversation-history` from the Codex plugin marketplace UI. After install, start a new Codex thread so the bundled skills and MCP tools are loaded. To pick up later plugin changes, refresh the marketplace and reinstall the plugin:

```sh
codex plugin marketplace upgrade agenttools
```

The marketplace entry points to `./ConversationHistory` inside the AgentTools repo, so Codex installs a cached copy of the Git version under `~/.codex/plugins/cache/agenttools/conversation-history/<version>/`.

The installed Codex MCP command is `./bin/session-indexer-mcp`. That shell launcher downloads a checksum-verified Node runtime into the installed plugin cache under `.runtime/node` on first start, then execs `bin/session-indexer-mcp.js` with that plugin-local Node.

Deploy defaults to `--mode copy`; symlink installs are only an explicit opt-in development mode. The MCP server is a thin process that spawns the CLI fresh for every tool call, so edits copied into the deployed package take effect on the next tool call without restarting the host. Only edits to `src/mcpServer.js` itself — the MCP tool surface (tool names, input schemas, argument mapping) — require reloading the plugin host. The installed Claude plugin injects `SESSION_INDEXER_DEPLOY_TARGET=claude-plugin` into its MCP launch env so `redeploy_session_index_mcp` redeploys the correct plugin for the host it is running in.

Search uses the existing conversation_history index. There is no fallback search mode exposed to agents.

`search` and `browse` never summarize or import source sessions on demand. Current-session indexing is a background continuity service: start it once for the session, keep it watching new turns, and use `conversation_index_status` to report machine-readable progress when retrieval runs before the index is ready.

When resolving the current session, use `--this-chat --session-marker conversation_history-session-{guid}`. The resolver searches source session files for that literal marker and refuses to choose a session from recency alone. If the marker appears in multiple Codex files because a session was forked, CodexSessionTools uses Codex's thread spawn graph to choose the descendant thread when there is exactly one leaf candidate; otherwise duplicate marker matches still fail closed.

The indexer is makefile-like. Compacted spans are logged internally as summary targets keyed by their source content and summary options. Completed targets are reused on later passes, active targets are claimed in a shared per-session target store, and `indexStatus` reports compact operational state, target counts, active/stale claims, and summarized-token counts without starting work.

Model summarization has a hard budget guard. `--summary-max-budget-usd` defaults to `5`; when enabled, newly claimed summary targets are cost-estimated with models.dev pricing before any provider call. Unknown pricing or an estimate over the cap fails closed.
