---
name: conversation_history
description: Recover prior conversation context from a hierarchical, paged transcript index whose lowest zoom level is lossless.
metadata:
  short-description: Hierarchical paged transcript recovery
---

# Conversation History

Active context can compact. conversation_history keeps the conversation outside the context window as a hierarchy.

Search finds candidate regions. Browse moves through the hierarchy by handle and zoom. OpenLink spends a bounded token budget on source text.

Higher zoom levels are compact navigation. The lowest zoom level is lossless. Trust opened source when `isVerbatim` is true.

Keep recovery incremental: search or browse first, open the smallest relevant link, and increase `budget_tokens` on the same link when `omittedTokenCount` is nonzero. Do not fill gaps from memory when the transcript can be recovered.

If the tools are not visible, call `tool_search` for `conversation_history conversation_search conversation_browse conversation_openLink conversation_index_status`.

## Functions

- `conversation_search`: search the current-session index. Inputs include `query`, `within`, `filter`, `start_at`, `limit`, and `agent`.
- `conversation_browse`: navigate the current-session hierarchy. Inputs include `handle`, `zoom`, `start`, `limit`, and `agent`.
- `conversation_openLink`: open a search or browse handle with a token budget. Inputs include `handle`, `budget_tokens`, and `agent`. Outputs include `isVerbatim` and `omittedTokenCount`.
- `conversation_index_status`: inspect current-session index status. Inputs include `start_at` and `limit`.
- `start_indexing_session`: start or reuse background indexing.
- `stop_indexing_session`: stop background indexing.
- `reset_session_index`: clear persisted indexes.
- `redeploy_session_index_mcp`: refresh the plugin/MCP installation.
