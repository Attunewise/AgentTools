---
name: conversation_history
description: Recover prior conversation context from a hierarchical, paged transcript index whose lowest zoom level is lossless.
metadata:
  short-description: Hierarchical paged transcript recovery
---

# Conversation History

Active context can compact. conversation_history keeps the conversation outside the context window as a hierarchy.

Search finds candidate regions. Browse moves through the hierarchy by topic and zoom. OpenLink spends a bounded token budget on source text.

Higher zoom levels are compact navigation. The lowest zoom level is lossless. Trust opened source when `isVerbatim` is true.

Keep recovery incremental: search or browse first, open the smallest relevant link, and increase `budget_tokens` on the same link when `omittedTokenCount` is nonzero. Do not fill gaps from memory when the transcript can be recovered.

If the tools are not visible, call `tool_search` for `conversation_history conversation_search conversation_browse conversation_openLink conversation_index_status`.

## Functions

- `conversation_search`: search existing transcript indexes. Inputs include `query`, `session_id` as a visibility filter, `index_id`, `topic`, `within`, `filter`, `start_at`, `limit`, `agent`, and `index_dir`.
- `conversation_browse`: navigate an indexed hierarchy by definitive `index_id`. Inputs include `index_id`, optional `session_id` visibility filter, `topic_id`, `zoom`, `start`, `limit`, `agent`, and `index_dir`.
- `conversation_openLink`: open a search or browse link with a token budget. Inputs include `link`, `budget_tokens`, `agent`, and `index_dir`. Outputs include `isVerbatim` and `omittedTokenCount`.
- `conversation_index_status`: inspect indexed-session status. Inputs include `start_at`, `limit`, `session_id`, and `index_dir`.
- `start_indexing_session`: start or reuse background indexing.
- `stop_indexing_session`: stop background indexing.
- `reset_session_index`: clear persisted indexes.
- `redeploy_session_index_mcp`: refresh the plugin/MCP installation.
