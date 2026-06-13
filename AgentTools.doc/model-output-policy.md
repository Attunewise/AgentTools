---
id: agenttools.model-output-policy
title: Model-facing output policy
scope:
  paths:
    - CodexSessionTools/src/render.js
    - CodexSessionTools/src/diagnostics.js
    - CodexSessionTools/src/mcpServer.js
    - AgentDoc/src/mcpServer.js
    - WorktreeTools/src/index.js
    - WorktreeTools/src/mcpServer.js
---

# Model-Facing Output Policy

Tool responses shown to the model must stay compact and deterministic.

The model must not choose output verbosity or request raw evidence by setting a format flag. Each tool decides its own renderer from server policy.

Default model-facing output should be one line or a few short YAML-style lines. It may include stable ids, a status, a compact reason or warning code, and the minimum actionable path. It must not include full transcripts, full repair evidence, stack traces, raw Git porcelain, or large JSON objects.

Rich diagnostics are stored internally by the server and exposed only through capped diagnostic pages. Diagnostic pages still render compact event summaries rather than raw internal objects.

When state is inconsistent, servers repair or reconcile first. If reconciliation cannot finish safely, the model-facing result should report a compact blocked reason rather than crashing or dumping evidence.

CodexSessionTools and WorktreeTools are model-facing only as entry-point providers. They orient the model to the correct Codex session, repository, worktree, staged fingerprint, or compact diagnostic status.

They must not become evidence channels. CodexSessionTools must not expose raw transcripts; ConversationHistory owns bounded transcript retrieval. WorktreeTools must not expose full diffs or raw porcelain by default; normal git/file inspection owns code evidence when the task requires it.

Example entry-point renders:

```text
ok repo=/path branch=main staged=2 dirty=4 fingerprint=sha256:...
ok thread=019ebf51 reason=session_marker_match file=...rollout.jsonl
blocked reason=ambiguous_fork
degraded reason=app_server_unavailable
```
