---
id: worktree-tools.model-entrypoints
title: Model entry points
scope:
  paths:
    - WorktreeTools/src/mcpServer.js
    - WorktreeTools/src/index.js
    - WorktreeTools/src/server.js
    - WorktreeTools/bin/worktree-server.js
---

# Model Entry Points

WorktreeTools is a Git/worktree authority, not a replacement for code inspection.

Allowed model-facing entry points:

- canonical repository root
- canonical worktree id
- linked-worktree status
- branch and upstream names
- staged fingerprint
- staged, unstaged, untracked, and dirty counts
- capped staged path summaries
- identity guard result for an intended target workdir

Disallowed default output:

- full diffs
- raw porcelain
- full `.git` internals
- unbounded staged file lists
- hook or command stderr dumps

AgentDoc uses these handles to stamp the correct worktree-private staged fingerprint. When a task needs source evidence, the model should inspect the relevant files or run explicit git commands with bounded output.

Use `worktree_guard` before write-like operations when the agent has an expected worktree id from session start, resume, or a previous `worktree_status` call. The guard answers only identity: whether the target workdir resolves to the expected worktree. It must not report dirty, staged, or branch state; use `worktree_status` or `worktree_staged_fingerprint` for that.

A dirty expected worktree is still the expected worktree. Do not treat dirty state as evidence that the worktree is foreign.

The default render should stay compact:

```text
ok repo=/path id=sha256:... branch=main staged=2 dirty=4 fingerprint=sha256:...
matched id=sha256:... repo=/path
blocked reason=worktree_mismatch actual=sha256:... expected=sha256:...
blocked reason=not_git_repo
```
