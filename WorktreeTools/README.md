# WorktreeTools

Shared helpers and a small local server for canonical Git repository/worktree state.

AgentDoc-format docs start at [WorktreeTools.md](WorktreeTools.md).

The package owns:

- repo root discovery
- linked worktree detection
- `git_dir` and `common_git_dir`
- worktree-private git paths via `git rev-parse --git-path`
- staged change fingerprints
- porcelain status counts
- compact model-facing rendering

Use Git as the authority. Do not infer linked-worktree paths from `.git` file contents by hand.

```sh
node bin/worktree-server.js --port 0
```

Endpoints:

- `GET /status`
- `POST /snapshot` with `{ "cwd": "/path/in/repo" }`
- `POST /shutdown`

Default compact render example:

```text
ok repo=/Users/.../AgentTools branch=main staged=2 dirty=3 linked=1
```

Full Git evidence stays in structured server state and tests. Model-facing callers should use compact renderers.
