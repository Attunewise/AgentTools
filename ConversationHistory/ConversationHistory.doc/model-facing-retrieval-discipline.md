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

1. Search or browse the current session's indexed hierarchy.
2. If a tool returns `conversation_history.async_operation.v1`, call `conversation_history_poll` with the returned `operationId` until it returns the real response or a terminal blocked/not_found state.
3. Browse one selected hierarchy by returned handles.
4. Open the smallest relevant handle with a bounded `budget_tokens`.
5. Increase the budget on the same handle only when the response reports omitted text.

The model should not receive raw manifests, full transcript files, full trees, backend configuration, search server internals, implementation stack traces, or unbounded diagnostic objects.

MCP output strips implementation details before returning `content` or `structuredContent`. Catalog browsing is especially strict because users can have hundreds or thousands of sessions; returning a page must stay cheap even when the index is large.

MCP search, browse, openLink, and status calls default to the current Codex session. The MCP resolves that scope by emitting a server-generated response marker and matching the source session JSONL that contains it. Duplicate marker matches are disambiguated through CodexSessionTools thread ancestry when possible and fail closed otherwise. If the MCP cannot prove the current session yet, it returns a pending async operation instead of falling back to the shared catalog or throwing a scope error.

Search, browse, and openLink require a ready current-session index. If the current session has not been indexed, is actively indexing, or is not up to date enough to satisfy the request, the MCP returns a pending async operation and starts or reuses background current-session indexing. Polling rechecks marker binding and index readiness, then returns the original operation's real response. Index errors and suspended indexing return terminal blocked async results. Retrieval must not perform inline summarization or unbounded transcript import in the tool call itself.

OpenLink is the only normal path for source text. Exact source recovery is indicated by `isVerbatim`; absent or summary-level text must not be treated as lossless evidence.
