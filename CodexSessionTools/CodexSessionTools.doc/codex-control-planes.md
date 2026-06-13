---
id: codex-session-tools.control-planes
title: Codex control planes
scope:
  paths:
    - CodexSessionTools/src/appServerClient.js
    - CodexSessionTools/src/exec.js
    - CodexSessionTools/src/server.js
    - CodexSessionTools/bin/codex-session-server.js
---

# Codex Control Planes

CodexSessionTools uses three Codex-facing mechanisms, each with a narrow job.

Direct JSONL and SQLite reads are the observation path. JSONL rollouts provide exact transcript facts, markers, tool calls, and path events. Codex state SQLite provides thread metadata, rollout paths, source kinds, and fork edges.

`codex exec --json` is the non-interactive write path. It creates or resumes Codex-owned sessions through the Codex CLI and emits JSONL events. The session server refreshes its snapshot after the run finishes.

`codex app-server --listen stdio://` is the private thread lifecycle control plane. The app-server client initializes a stdio child process and can call thread APIs such as `thread/list` and `thread/read` without opening a WebSocket or disturbing the Codex Desktop app.

The server must not hand-edit rollout JSONL to create or modify sessions. Codex also maintains thread metadata in SQLite, so direct rollout mutation can create inconsistent session state.
