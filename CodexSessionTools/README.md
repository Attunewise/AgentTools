# CodexSessionTools

Shared helpers for reading Codex JSONL session logs without loading full transcripts into model context.

The package can:

- discover recent Codex `rollout-*.jsonl` files
- read bounded file windows
- find a session containing a marker
- extract `session_meta.payload.id`
- extract `turn_context` cwd/workspace roots
- extract function-call `workdir`/`cwd` arguments

It contains no AgentDoc-specific policy. AgentDoc uses it to bind an AgentDoc session marker to the Codex session and the repositories/worktrees used by that session.
