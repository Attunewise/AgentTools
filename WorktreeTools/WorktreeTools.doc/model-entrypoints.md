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
- linked-worktree status
- branch and upstream names
- staged fingerprint
- staged, unstaged, untracked, and dirty counts
- capped staged path summaries

Disallowed default output:

- full diffs
- raw porcelain
- full `.git` internals
- unbounded staged file lists
- hook or command stderr dumps

AgentDoc uses these handles to stamp the correct worktree-private staged fingerprint. When a task needs source evidence, the model should inspect the relevant files or run explicit git commands with bounded output.

The default render should stay compact:

```text
ok repo=/path branch=main staged=2 dirty=4 fingerprint=sha256:...
blocked reason=not_git_repo
```
