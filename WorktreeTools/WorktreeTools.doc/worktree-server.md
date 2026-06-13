---
id: worktree-tools.server
title: Worktree server
scope:
  paths:
    - WorktreeTools/bin/worktree-server.js
    - WorktreeTools/src/server.js
    - WorktreeTools/src/index.js
---

# Worktree Server

WorktreeServer centralizes coherent Git/worktree state for AgentTools processes.

The server exposes status and snapshot endpoints. A snapshot resolves a path inside a repository to canonical worktree identity, staged fingerprint data, staged files, branch/upstream values, and compact status counts.

The server caches snapshots by repository root and may watch worktree-private Git paths such as the index and HEAD. Watch failures do not crash the server; a later snapshot revalidates through Git.

Model-facing callers should use compact entry-point renders. Full Git evidence belongs in explicit file/git inspection or capped diagnostics, not default tool output.
