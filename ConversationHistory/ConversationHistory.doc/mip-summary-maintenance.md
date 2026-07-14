---
id: conversation-history.mip-summary-maintenance
title: MIP summary maintenance
scope:
  paths:
    - ConversationHistory/src/summarizer.js
    - ConversationHistory/src/store.js
    - ConversationHistory/src/mip.js
    - ConversationHistory/test/session-indexer.test.js
---

# MIP Summary Maintenance

Summary-target maintenance may run ahead of compaction, but the public hierarchy remains bounded by the latest compaction record. The product path is raw source leaves, compacted spans, recursively summarized parents, then paged search/browse/open.

Level one consumes a contiguous batch of canonical user/assistant turns and paired tool calls/results once that raw tail reaches the configured token threshold. It uses the exact turn-preserving creation prompt. A completed level-one batch is immutable; a smaller remainder stays raw until a later append makes it ready.

A new parent uses a separate creation prompt over its complete ordered child-summary set. It does not receive a fake `(none)` existing summary. An existing parent uses the update prompt below. These are separate inference contracts and content-addressing inputs.

Completing a level-one batch repairs only the open rightmost spine. Each affected higher-level node keeps a stable logical handle and creates a new content-addressed target from:

- the previous summary for that node;
- explicit append-or-replace-suffix metadata and only that child-summary suffix;
- the ordered child target hashes;
- cumulative underlying token and start/end/duration metadata;
- the parent-update prompt, provider, model, and summary options.

Unchanged left branches reuse their completed targets without inference. Maintenance proceeds bottom-up and updates the session root last in the same cycle. Replaying an unchanged transcript produces no model calls.

The update model returns a complete replacement summary, not a patch. Replacement suffix evidence supersedes stale statements from the previous summary. A shortened child sequence or a target without usable child-revision lineage takes the parent-creation path over all current children so removed evidence cannot survive through an empty delta.

Provider compaction records remain source/rendering boundaries and are never summary input. They may close a partial legacy batch, but a ready live tail does not wait for a compaction record. The renderer and retrieval layer consume the already-maintained spine rather than starting a summary rebuild.
