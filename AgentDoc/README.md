# AgentDoc

AgentDoc is a small gate for responsible agent-maintained documentation. Large .md files bloat the models context and cost the user tokens, meanwhile compaction causes the model to forget about documentation and let it rot. We organize docs in incremental sections that an agent can ingest without regret and check on git operations that the agent has paid attention to keeping them up to date.

The git hook does not check docs. It only rejects an operation unless the AgentDoc MCP server has already recorded that the agent checked the exact staged change set.

```sh
npm install
npm test
node bin/agentdoc-mcp.js
npm run test:codex-cli
```

Use compact documentation sets:

```text
Something.md
Something.doc/
  focused-self-contained-section.md
```

`Something.md` is an index only. Self-contained section files live under `Something.doc/` and may include frontmatter scopes so AgentDoc can map changed files to relevant docs.

AgentDoc writes stamps and review files under Git's private `agentdoc/` path, normally inside `.git/agentdoc/`, so proof files do not become commit noise.

Git enforcement uses a tiny hook entrypoint that prints one short line on failure. Review preparation and check recording are MCP tools, not a user-facing command workflow.

An AgentDoc MCP session starts with `agentdoc_start_session`. The returned id is recorded in the Codex transcript, and AgentDoc uses `CodexSessionTools` to find that Codex session log and resolve the repositories/worktrees used by the session.

`npm run test:codex-cli` drives the real interactive Codex CLI through a PTY. It creates a temporary repository, configures the AgentDoc MCP server for that session, forces the first commit attempt to fail on the AgentDoc hook, and verifies Codex recovers by updating or checking docs before committing.
