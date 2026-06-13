---
id: codex-session-tools.reconciliation
title: Codex session reconciliation
scope:
  paths:
    - CodexSessionTools/src/reconcile.js
    - CodexSessionTools/src/server.js
    - CodexSessionTools/src/index.js
    - ConversationHistory/src/adapters/codex.js
    - ConversationHistory/src/mcpServer.js
---

# Codex Session Reconciliation

The session server repairs or reconciles inconsistent Codex state before reporting blocked status.

If SQLite points to a missing rollout path, the server can ask Codex app-server to read the thread and recover Codex-owned metadata. If that fails, the server reports a compact blocked reason instead of throwing raw errors to the model.

If a marker appears in multiple rollout files, the resolver uses Codex thread spawn edges to select the single descendant leaf when the graph proves one. If lineage does not identify a single leaf, the result is blocked rather than guessed.

If a marker appears before a large later tool output, literal marker scanning checks the recent tail first and then falls back to a bounded full-file scan. This prevents the active-session marker from being hidden by large output near the end of a rollout.

Reconciliation attempts should be recorded in diagnostics. Model-facing responses should include only a compact status, reason, or warning code.
