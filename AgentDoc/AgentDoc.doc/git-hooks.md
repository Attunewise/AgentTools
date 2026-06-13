---
id: agentdoc.git-hooks
title: AgentDoc git hooks
scope:
  paths:
    - AgentDoc/src/agentdoc.js
    - AgentDoc/bin/agentdoc.js
---

# AgentDoc Git Hooks

The hook never performs the documentation review. It only enforces that a review stamp already exists for the exact staged change set.

The pre-commit hook installed by the `agentdoc_install_hook` MCP tool runs the tiny hook entrypoint:

```sh
node AgentDoc/bin/agentdoc-hook.js
```

On success, `gate` prints nothing. On failure, it prints one short line such as:

```text
AgentDoc required
```

Hook output must stay tiny because an agent running git commands will see that output in context. Detailed review data belongs under Git's private `agentdoc/` path, not stdout or stderr.
