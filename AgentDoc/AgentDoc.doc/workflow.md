---
id: agentdoc.workflow
title: AgentDoc workflow
scope:
  paths:
    - AgentDoc/bin/**
    - AgentDoc/src/**
    - AgentDoc/test/**
---

# AgentDoc Workflow

AgentDoc separates enforcement from review.

The `agentdoc_start_session` MCP tool returns an `agentdoc_session_id`. That id is recorded in the Codex transcript as a tool result. AgentDoc resolves the transcript through CodexSessionTools, including forked Codex sessions where Codex's thread graph identifies a child session as the current descendant.

AgentDoc gets Git and linked-worktree facts through WorktreeTools. AgentDoc still owns documentation policy, review files, stamps, and hooks.

The AgentDoc MCP server exposes its tool list before starting shared session monitoring. Tool calls lazily start the AgentDoc state and CodexSessionTools binding, which avoids startup races when AgentDoc is launched alongside other MCP servers in one Codex session.

The `agentdoc_prepare_review` MCP tool computes the staged fingerprint, discovers documentation sections, maps changed paths to scoped sections, and writes a bounded review file under Git's private `agentdoc/review.json` path.

The agent then checks the staged code diff and the affected documentation sections. If documentation claims changed, the agent updates the relevant self-contained section files.

The `agentdoc_record_check` MCP tool writes the local proof stamp only after that review. Passing results are `docs-current` and `docs-updated`; blocking results are `needs-doc-update` and `blocked`.

The hook verifier reads the latest stamp, compares it to the exact current staged fingerprint, and exits nonzero when the stamp is missing, stale, invalid, or blocking.

Stamps and review files are written through `git rev-parse --git-path`, so linked Git worktrees get worktree-private `agentdoc/` state rather than sharing a stamp with the main worktree.

The Codex CLI integration test drives the interactive `codex` TUI through a PTY. It creates a temporary repository, configures the AgentDoc MCP server for that session, requires a first commit attempt before AgentDoc is used, and then verifies Codex recovers from the hook failure by updating or checking documentation and committing successfully.
