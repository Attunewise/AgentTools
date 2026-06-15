# AgentTools
Coding agent tools designed around minimizing context to economize token use, while simultaneously inhibiting confabulation. 

- [ConversationHistory](ConversationHistory/README.md): hierarchical transcript recovery.
- [Expect](Expect/README.md): Expect-style stream and PTY automation.
- [AgentDoc](AgentDoc/README.md): gated agent documentation checks.
- [CodexSessionTools](CodexSessionTools/README.md): shared Codex JSONL session discovery helpers.
- [WorktreeTools](WorktreeTools/README.md): canonical Git repository/worktree state.

AgentDoc-format architecture docs start at [AgentTools.md](AgentTools.md).

ConversationHistory-specific AgentDoc docs start at [ConversationHistory/ConversationHistory.md](ConversationHistory/ConversationHistory.md).

## Codex Plugin Install

Deploy the local AgentTools plugins into the personal Codex marketplace:

```sh
node scripts/deploy-codex-plugins.js
```

Install or refresh them through the Codex app-server:

```sh
node scripts/install-codex-plugins.js --skip-upgrade
```

Use `node scripts/install-codex-plugins.js --deploy --skip-upgrade` to do both steps in one command.
