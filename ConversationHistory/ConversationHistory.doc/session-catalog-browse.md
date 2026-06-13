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

Calling `conversation_browse` without `index_id` returns a manifest-backed session catalog. This path must not import transcripts, start indexing, query Typesense, read every IR file, or inspect full session trees. It reads only the persisted manifest and returns a compact page.

The catalog rows include the minimum fields needed to decide where to drill down:

- title and short summary
- last modified time
- agent
- session id and index id
- turn, event, document, token, and compaction counts
- a drill hint: `browse.index_id` plus `browse.topic_id: "root"`

The page shape uses `level: "sessions"` and `page.start`, `page.limit`, `page.returned`, `page.total`, and optional `page.next_start`.

When `index_id` is supplied, `conversation_browse` drills into that one transcript hierarchy and uses returned `topic_id` values for navigation. `session_id` remains a visibility filter rather than the canonical browse identity.

Newly written indexes persist `turnCount` and `shortSummary` in the manifest so catalog pages do not have to read IR files. Older sessions may omit these fields until reindexed.
