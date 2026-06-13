---
id: codex-session-tools.server-architecture
title: Codex session server architecture
scope:
  paths:
    - CodexSessionTools/bin/codex-session-server.js
    - CodexSessionTools/src/server.js
    - CodexSessionTools/src/client.js
    - CodexSessionTools/src/index.js
---

# Codex Session Server Architecture

CodexSessionTools centralizes Codex session truth so AgentDoc, ConversationHistory, and other tools do not each tail Codex files independently.

`CodexSessionServerState` owns a cached snapshot of Codex rollout JSONL files and Codex thread spawn edges. It refreshes the snapshot from `~/.codex/sessions` and the Codex state SQLite database.

The HTTP server exposes compact service endpoints for status, refresh, marker resolution, latest marker discovery, Codex exec runs, app-server thread reads, reconciliation, and diagnostics.

Clients should use `connectOrStartCodexSessionServer` rather than embedding their own watcher. The client validates a server info file, reuses a live server when possible, and starts one server process under a lock when needed.

The server is not repository-scoped. It is a session authority for the current Codex home/session root and can observe any repository or worktree used by Codex sessions.
