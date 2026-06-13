---
id: worktree-tools.agentdoc-integration
title: AgentDoc integration
scope:
  paths:
    - AgentDoc/src/agentdoc.js
    - AgentDoc/src/server.js
    - AgentDoc/test/agentdoc.test.js
    - WorktreeTools/src/index.js
---

# AgentDoc Integration

AgentDoc uses WorktreeTools for Git truth while preserving AgentDoc-specific documentation policy.

Repository resolution, linked-worktree detection, worktree-private Git paths, staged file lists, current HEAD, and staged fingerprints come from WorktreeTools.

AgentDoc stamps and review files are written under paths returned by `git rev-parse --git-path`. This keeps linked worktrees isolated so one worktree cannot accidentally satisfy another worktree's documentation gate.

AgentDoc still owns documentation discovery, scope matching, hook installation, review file contents, and stamp validation. WorktreeTools only supplies coherent Git/worktree facts.
