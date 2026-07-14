---
id: conversation-history.session-catalog-browse
title: Session catalog browse
scope:
  paths:
    - ConversationHistory/src/store.js
    - ConversationHistory/src/cli.js
    - ConversationHistory/src/mcpServer.js
    - ConversationHistory/test/session-indexer.test.js
---

# Session Catalog Browse

ConversationHistory supports a top-level browse above individual sessions.

The CLI `browse` command without `--index-id` returns a manifest-backed session catalog. In the MCP surface, `conversation_browse` is current-session scoped and does not expose the shared catalog as a fallback. If the MCP cannot resolve the current thread through its response marker, it returns `conversation_history.async_operation.v1`; callers poll `conversation_history_poll` until binding resolves or is blocked. If no published current-session index exists, browse returns `current_session_not_indexed` and the caller must invoke `start_indexing_session` explicitly. If a published index exists, browse serves it while an explicitly started background worker catches up on newer tail records.

The catalog path must not import transcripts, start indexing, query Typesense, read every IR file, or inspect full session trees. It reads only the persisted manifest and returns a compact page. Current-session MCP browse may return a pending marker-binding operation, but it must never start or reuse indexing as a retrieval side effect.

The catalog rows include the minimum fields needed to decide where to drill down:

- title and short summary
- last modified time
- agent
- session id and index id
- turn, event, document, token, and compaction counts
- a drill hint: `browse.index_id` plus `browse.topic_id: "root"`

The page shape uses `level: "sessions"` and `page.start`, `page.limit`, `page.returned`, `page.total`, and optional `page.next_start`.

When `index_id` is supplied at the CLI layer, browse drills into that one transcript hierarchy and uses returned `topic_id` values for navigation. The MCP surface hides raw `index_id`, `session_id`, `topic_id`, and resource links from the model and instead exposes compact handles such as `root` and `event/...` for follow-up navigation.

Newly written indexes persist `turnCount` and `shortSummary` in the manifest so catalog pages do not have to read IR files. Older sessions may omit these fields until reindexed.
