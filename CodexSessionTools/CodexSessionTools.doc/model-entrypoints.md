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

The default render should fit on one line, for example:

```text
ok thread=019ebf51 reason=session_marker_match file=...rollout.jsonl
blocked reason=ambiguous_fork
degraded reason=app_server_unavailable
```
