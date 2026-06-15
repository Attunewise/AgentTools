---
id: conversation-history.model-facing-retrieval-discipline
title: Model-facing retrieval discipline
scope:
  paths:
    - ConversationHistory/src/mcpServer.js
    - ConversationHistory/src/store.js
    - ConversationHistory/src/mip.js
    - ConversationHistory/src/typesense.js
---

# Model-Facing Retrieval Discipline

ConversationHistory must make transcript recovery incremental.

The model-facing sequence is:

1. Search the current session's indexed summaries, or explicitly request all-session search when the user asks for cross-session history.
2. Browse one selected hierarchy by `index_id` and returned `topic_id` values.
3. Open the smallest relevant link with a bounded `budget_tokens`.
4. Increase the budget on the same link only when the response reports omitted text.

The model should not receive raw manifests, full transcript files, full trees, backend configuration, search server internals, implementation stack traces, or unbounded diagnostic objects.

MCP output strips implementation details before returning `content` or `structuredContent`. Catalog browsing is especially strict because users can have hundreds or thousands of sessions; returning a page must stay cheap even when the index is large.

MCP search, browse, and status calls default to the current Codex session when the caller omits `session_id` and `index_id`. The MCP resolves that scope from `CODEX_THREAD_ID` through Codex app-server metadata. If it cannot prove the current session, it returns an empty scoped result instead of falling back to the shared catalog. All-session search or catalog/status browsing requires the explicit `all_sessions` flag and remains bounded by `start_at`/`start` and `limit`. Retrieval must not index on demand.

OpenLink is the only normal path for source text. Exact source recovery is indicated by `isVerbatim`; absent or summary-level text must not be treated as lossless evidence.
