---
id: worktree-tools.git-identity
title: Git identity
scope:
  paths:
    - WorktreeTools/src/index.js
    - WorktreeTools/test/worktree-tools.test.js
---

# Git Identity

WorktreeTools uses Git commands as the authority for repository and worktree identity.

`resolveWorktree` records the repository root, Git dir, common Git dir, linked-worktree status, superproject path, and worktree-private paths for `index` and `HEAD`.

Linked worktrees are detected when `git_dir` and `common_git_dir` differ. Worktree-private files must be resolved with `git rev-parse --git-path` rather than by joining paths under `.git`.

`worktree_id` is a stable hash of canonical Git identity facts: real repository root, real Git dir, real common Git dir, superproject, and worktree-private `index` and `HEAD` paths. It intentionally excludes mutable state such as dirty counts, staged files, branch name, and current `HEAD`.

Use `worktreeGuard` to compare an intended tool target against an expected `worktree_id`. A mismatch means the write target is foreign. A match says only that identity is correct; dirty and staged state are separate perceptions from `statusCounts` and `stagedFingerprint`.

`stagedFingerprint` hashes the current `HEAD` and cached binary staged diff. This creates a stable fingerprint for commit gates such as AgentDoc.

`statusCounts` reads `git status --porcelain=v2 -z --branch` and summarizes staged, unstaged, untracked, and dirty counts for compact model-facing status.
