---
id: codex-session-tools.model-entrypoints
title: Model entry points
scope:
  paths:
    - CodexSessionTools/src/mcpServer.js
    - CodexSessionTools/src/render.js
    - CodexSessionTools/src/server.js
    - CodexSessionTools/src/client.js
---

# Model Entry Points

CodexSessionTools is primarily an internal session authority. The model-facing layer must expose only orientation handles.

Allowed entry points:

- server health and app-server availability
- current or marker-based Codex session binding
- fork-aware session resolution
- compact reconciliation status
- capped diagnostics pages

Disallowed model-facing evidence:

- raw rollout JSONL
- full transcript text
- full app-server thread payloads
- unbounded repair evidence
- raw stack traces

ConversationHistory owns bounded transcript retrieval. CodexSessionTools only tells the model which Codex session or thread handle should be used by that next bounded tool.

`codex_session_latest_marker` is a hint-only tool. It can help recover a recent marker family, but it is not proof that the current model run is bound to that session. Current-session binding requires a fresh `codex_session_start_binding` marker followed by `codex_session_resolve_marker` for that exact marker.

The default render should fit on one line, for example:

```text
ok thread=019ebf51 reason=session_marker_match file=...rollout.jsonl
hint proof=0 marker=codex-session-... warn=not_current_session_binding
blocked reason=ambiguous_fork
degraded reason=app_server_unavailable
```
