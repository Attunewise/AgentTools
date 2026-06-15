---
name: agentdoc
description: Check and stamp agent-maintained documentation before git operations that are gated by AgentDoc.
---

# AgentDoc

Use this skill when a repository uses AgentDoc or a git operation reports an AgentDoc gate failure.

The hook is not the check. The agent must inspect the staged change set, inspect or update the relevant bounded documentation sections, then stamp the exact staged fingerprint.

Workflow through MCP tools:

1. Call `agentdoc_start_session` once near the start of the task and keep the returned `agentdoc_session_id`.
2. When a staged change needs checking, call `agentdoc_prepare_review` with that `agentdoc_session_id`.
3. Open the generated review file only if needed. It lives under Git's private `agentdoc/review.json` path for the resolved repository/worktree.
4. Inspect the staged diff and each affected self-contained doc section. Do not load a whole documentation tree when a section file is enough.
5. Update docs if claims changed.
6. Call `agentdoc_record_check` with the same `agentdoc_session_id` and the exact outcome.

If docs still need work, record `needs-doc-update` or do not record a passing check. A gate hook only allows `docs-current` and `docs-updated` for the exact staged fingerprint.

Hook output must stay tiny because command output enters model context. Full details belong in Git-private files.
