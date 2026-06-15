---
name: expect
description: Drive interactive terminal programs with an Expect-style PTY script. Use when a CLI, REPL, TUI, login prompt, or long-running command needs pattern matching, sends, timeouts, and transcript capture.
---

# Expect

Use this skill when a command is interactive or when matching terminal output in one deterministic script is better than repeated shell/tool round trips.

Expect is a Playwright-style automation adapter for coding-agent TUIs: spawn the real PTY, match rendered terminal state, send real keystrokes, and assert the resulting UI or persisted state.

Run scripts from this skill directory with the plugin's CLI:

```bash
node ../../bin/expect-tool.js run --cmd 'command here' --script-file /tmp/script.expect --workdir /path/to/project
```

Use `--log-file /path/to/transcript.log` when the full raw PTY transcript should be saved without returning it through the model context. Programmatic callers can pass `log_path`.

For small scripts, `--script` is fine:

```bash
node ../../bin/expect-tool.js run --cmd 'env TERM=dumb PYTHON_BASIC_REPL=1 python3 -i' --script '
set timeout 10
expect {
  -re {>>> $} {
    send -- "print(2 + 2)\r"
    exp_continue
  }
  -re {4\r?\n>>> $} {
    js {
      send("exit()\r")
      return { ok: true, match: expect.match }
    }
  }
}
'
```

Use `exp_continue` when a TUI keeps redrawing and the script should keep watching after a match. Include a `timeout` branch that throws with `expect.buffer` when debugging an uncertain TUI.

Supported Expect syntax:

- `set timeout N`
- `expect { ... }`
- `-re {pattern} { ... }`
- `-ex {literal} { ... }`
- glob patterns like `{foo*bar} { ... }`
- `timeout { ... }`
- `eof { ... }`
- `default { ... }`
- `exp_continue`
- `exp_continue -continue_timer`
- `send -- "text\r"`
- `js { ... }`
