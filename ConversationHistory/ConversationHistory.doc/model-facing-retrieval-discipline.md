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

1. Browse the compact session catalog or search indexed summaries.
2. Browse one selected hierarchy by `index_id` and returned `topic_id` values.
3. Open the smallest relevant link with a bounded `budget_tokens`.
4. Increase the budget on the same link only when the response reports omitted text.

The model should not receive raw manifests, full transcript files, full trees, backend configuration, search server internals, implementation stack traces, or unbounded diagnostic objects.

MCP output strips implementation details before returning `content` or `structuredContent`. Catalog browsing is especially strict because users can have hundreds or thousands of sessions; returning a page must stay cheap even when the index is large.

Search can span all indexed sessions, but it is still bounded by `start_at` and `limit`. It must not index on demand.

OpenLink is the only normal path for source text. Exact source recovery is indicated by `isVerbatim`; absent or summary-level text must not be treated as lossless evidence.
