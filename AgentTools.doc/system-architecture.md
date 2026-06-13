---
id: agenttools.system-architecture
title: AgentTools system architecture
scope:
  paths:
    - CodexSessionTools/**
    - WorktreeTools/**
    - AgentDoc/src/server.js
    - AgentDoc/src/mcpServer.js
    - ConversationHistory/src/mcpServer.js
---

# AgentTools System Architecture

AgentTools separates session truth, Git truth, and model-facing rendering.

CodexSessionTools owns Codex session observation. It watches Codex rollout JSONL files, reads Codex state SQLite metadata, resolves markers, uses Codex app-server for Codex-owned thread reads, and uses `codex exec` for non-interactive Codex-owned runs.

WorktreeTools owns Git repository and worktree identity. It resolves repository roots, linked worktrees, private Git paths, staged fingerprints, branch state, and compact status summaries through Git commands rather than filesystem guesses.

Their model-facing MCP surfaces are intentionally narrow entry points. CodexSessionTools gives session bindings and repair/health handles. WorktreeTools gives canonical repository/worktree identity and staged-state handles. They do not replace ConversationHistory for transcript evidence or ordinary file/git inspection for source evidence.

AgentDoc depends on both authorities. CodexSessionTools binds an AgentDoc marker to the active Codex session. WorktreeTools resolves the repository/worktree where documentation checks, stamps, and hooks apply.

ConversationHistory uses CodexSessionTools for current-session discovery so transcript indexing follows the real Codex session, including fork descendants when lineage is known.

Direct mutation of Codex rollout JSONL is not a supported write path. Codex-owned writes go through `codex exec` or Codex app-server. Direct Git state writes are avoided; Git state is queried and validated through Git itself.
