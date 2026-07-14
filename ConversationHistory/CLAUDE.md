# CLAUDE.md — Claude Code working notes for ConversationHistory

See `AGENTS.md` for the full, agent-independent design rules (IR, compaction, MIP,
search/openLink, providers). This file is the Claude-Code-specific layer.

## Workspace isolation

- This checkout lives at `~/Documents/AgentTools/ConversationHistory` inside the
  parent AgentTools Git repository. Run repository-wide Git operations from the
  parent checkout and preserve other in-progress work there.

## Claude Code source adapter

- `src/adapters/claude.js` reads `~/.claude/projects/<slug>/<uuid>.jsonl`.
- It maps user / assistant / `tool_use` / `tool_result` / `thinking` / usage
  records to the shared IR, preserves thinking `signature` blocks, annotates Task
  sidechains (`meta.sidechain`), drops noisy diagnostic `system` rows, and skips
  the `<synthetic>` placeholder model.
- Claude sessions default to summarizing through `claude -p` (the `claude`
  summary provider) unless `--summary-provider` is passed. That provider runs with
  `--bare` (skips Claude Code's heavy agent context — ~15x faster per call), uses a
  models.dev-resolvable model id (`claude-haiku-4-5`, not the bare `haiku` alias),
  retries transient failures (full ~60s backoff on a 429 token-rate limit), and is
  clamped to **concurrency 1** — `claude -p` is not safe to run in parallel (it
  races on shared `~/.claude` state and multiplies the per-minute token rate).
- Use `--source claude --this-chat --session-marker session-indexer-session-{guid}`
  to resolve the current Claude session. A session marker is **required**:
  concurrent agents run in different sessions at once, so the resolver matches the
  literal marker in exactly one source session file and never selects by mtime alone.

## Plugin install + the development loop

- Install for Claude Code: `node bin/session-indexer.js deploy --target claude-plugin`
  (copy mode by default; pass `--mode symlink` explicitly for local development).
  It writes `~/.claude/plugins/conversation-history` plus a Claude marketplace,
  and prints the `claude plugin marketplace add` / `claude plugin install`
  commands.
- The MCP server is a thin wrapper that spawns the CLI fresh for every tool call.
  So with a symlink install, edits to adapters / indexing / store / summarizer /
  CLI take effect on the **next tool call — no Claude Code restart needed**.
- The **only** change that requires reloading the plugin host is editing the MCP
  tool surface in `src/mcpServer.js` (tool names, input schemas, argument
  mapping). Adding a new tool or changing a schema = restart; fixing logic = no
  restart.
- `redeploy_session_index_mcp` targets the host it runs in. The Claude plugin's
  `.claude-plugin/plugin.json` injects `SESSION_INDEXER_DEPLOY_TARGET=claude-plugin`
  into the MCP launch env; the target is never a model-facing argument.

## Testing

- `npm run check` (syntax) and `npm test` (unit) must stay green.
- Index this conversation:
  `node bin/session-indexer.js index --source claude --this-chat --session-marker session-indexer-session-{guid}`
- Then exercise the MCP tools (`conversation_search`, `conversation_openLink`,
  `conversation_index_status`) against this session's index.
