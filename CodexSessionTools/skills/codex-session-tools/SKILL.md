---
name: codex-session-tools
description: Bind a Codex model run to recorded Codex sessions and inspect compact session diagnostics without dumping transcripts.
---

# Codex Session Tools

Use this skill when a task needs proof of the current Codex session, fork-aware marker resolution, or compact diagnostics about Codex session discovery.

These tools are entry points, not evidence channels. They return handles and compact status. Use Conversation History for bounded transcript recovery and normal file or git inspection for source evidence.

Recommended flow:

1. Call `codex_session_start_binding` to create a fresh marker.
2. Call `codex_session_resolve_marker` with that exact marker to bind the current run.
3. Use `codex_session_status` or `codex_session_diagnostics` when resolution is degraded or ambiguous.

`codex_session_latest_marker` is only a hint. It is not proof that the current model run is bound to that session.
