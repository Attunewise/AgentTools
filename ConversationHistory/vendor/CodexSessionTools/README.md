# CodexSessionTools

Shared helpers for reading Codex JSONL session logs without loading full transcripts into model context.

AgentDoc-format docs start at [CodexSessionTools.md](CodexSessionTools.md).

The package can:

- discover recent Codex `rollout-*.jsonl` files
- read bounded file windows
- find a session containing a marker
- resolve duplicate marker matches through Codex fork edges when one candidate is the descendant thread
- keep compact model-facing renderers separate from rich internal state
- write bounded diagnostics/repair logs without emitting them by default
- reconcile stale session metadata before reporting blocked state
- extract `session_meta.payload.id`
- extract `turn_context` cwd/workspace roots
- extract function-call `workdir`/`cwd` arguments
- run a local `codex-session-server` process that owns the session snapshot and fork graph
- run `codex exec --json` through Codex itself for non-interactive create/resume flows
- speak to `codex app-server --listen stdio://` for Codex-owned thread lifecycle reads

It contains no AgentDoc-specific policy. AgentDoc uses it to bind an AgentDoc session marker to the Codex session and the repositories/worktrees used by that session.

```sh
node bin/codex-session-server.js --port 0
```

The server exposes compact JSON endpoints: `GET /status`, `POST /refresh`, `POST /resolve-marker`, `POST /latest-marker`, `POST /exec`, `POST /app-server/thread-list`, `POST /app-server/thread-read`, `POST /reconcile-thread`, and `POST /diagnostics`. It returns metadata and bounded match data, not full transcripts.

`POST /exec` is the only supported write path in this package. It invokes Codex, for example:

```json
{
  "cwd": "/repo/worktree",
  "prompt": "update the docs for the staged change"
}
```

For existing sessions, pass `resume_session_id` or `resume_last`. The server does not edit rollout JSONL directly; Codex also maintains thread metadata in its state database, so direct file mutation is not a reliable way to create Desktop-visible session state.

When a caller needs rich-client behavior such as Desktop-visible thread start/resume/fork/read operations, use Codex app-server as the write/control plane. `codex exec` is for non-interactive runs; app-server is the protocol Codex exposes for clients that need conversation history, approvals, and streamed agent events.

Model-facing tools should use `src/render.js` rather than exposing raw server objects. Rich diagnostics belong in `DiagnosticsStore` and are retrieved only through capped diagnostic pages.
