---
id: agenttools.interactive-testing
title: Interactive testing
scope:
  paths:
    - scripts/test-codex-cli-agenttools.js
    - AgentDoc/scripts/test-codex-cli-agentdoc.js
    - artifacts/model-sessions/**
    - .gitignore
---

# Interactive Testing

Interactive tests run the real Codex CLI through Expect and require the model to call MCP tools.

`scripts/test-codex-cli-agenttools.js` exercises all AgentTools model-facing MCP entry points in one Codex CLI run:

- CodexSessionTools: binding, status, marker resolution, app-server health
- WorktreeTools: compact worktree status
- ConversationHistory: top-level catalog browse
- AgentDoc: session start and status

The test writes a fixture report only after the required MCP calls have happened. It then scans recent Codex rollout JSONL files to verify tool-call prefixes appeared in the recorded model session.

Before launching Codex, the harness preflights each configured MCP server over stdio and asserts that the required entry-point tools are listed. After the Codex run, it rejects sessions where any required MCP call returned `isError`.

Interactive test artifacts are copied under `artifacts/model-sessions/`. That directory is ignored because the remote repository is public and raw Codex transcripts can contain private prompts, paths, or tool outputs. The local manifest records copied session paths, hashes, and tool-call summaries for inspection without publishing transcript contents.
