---
name: worktree-tools
description: Resolve compact Git repository/worktree identity and staged-state handles without dumping raw Git evidence.
---

# Worktree Tools

Use this skill when a task needs canonical repository or worktree identity, staged fingerprints, or a guard before writing to a worktree.

These tools are entry points, not diff viewers. They return compact handles and counts. Use normal git commands or file inspection when the task requires source evidence.

Useful MCP tools:

- `worktree_status`: return compact repository/worktree identity and dirty/staged counts.
- `worktree_staged_fingerprint`: return the staged fingerprint and capped staged path summary.
- `worktree_guard`: compare an intended workdir against an expected worktree identity before a risky write.
