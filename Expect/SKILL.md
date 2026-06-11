---
name: expect
description: Drive interactive terminal programs with an Expect-style PTY script. Use when a CLI, REPL, TUI, login prompt, or long-running command needs pattern matching, sends, timeouts, and transcript capture.
---

# Expect

Use this skill when a command is interactive or when matching terminal output in one deterministic script is better than repeated shell/tool round trips.

Expect is not just for ancient terminal login flows. Treat it as a Playwright-style automation adapter for coding-agent TUIs: spawn the real PTY, match rendered terminal state, send real keystrokes, and assert the resulting UI or persisted state.

Run scripts from this skill directory:

```bash
node bin/expect-tool.js run --cmd 'command here' --script-file /tmp/script.expect --workdir /path/to/project
```

For small scripts, `--script` is fine:

```bash
node bin/expect-tool.js run --cmd 'env TERM=dumb PYTHON_BASIC_REPL=1 python3 -i' --script '
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

## TUI Automation Loop

Use `exp_continue` when a TUI keeps redrawing and the script should keep watching after a match. The usual pattern is to send an action once, store progress in `context`, and continue until the success state appears:

```expect
set timeout 20
expect {
  -re {π - [^\x07]+\x07} {
    js {
      if (!context.sentModel) {
        context.sentModel = true
        send("/model openai-codex/gpt-5.4\r")
      }
    }
    exp_continue
  }
  -re {No matching models} {
    js {
      if (!context.switchedScope) {
        context.switchedScope = true
        send("\t")
      }
    }
    exp_continue
  }
  -re {gpt-5\.4} {
    js {
      if (context.switchedScope && !context.selectedModel) {
        context.selectedModel = true
        send("\r")
      }
    }
    exp_continue
  }
  -re {Model: gpt-5\.4} {
    js {
      if (!context.sentQuit) {
        context.sentQuit = true
        send("/quit\r")
      }
    }
    exp_continue
  }
  eof {
    js {
      return {
        ok: true,
        sentModel: context.sentModel,
        selectedModel: context.selectedModel,
        sentQuit: context.sentQuit
      }
    }
  }
  timeout {
    js {
      throw new Error("Timed out. Buffer:" + expect.buffer.slice(-4000))
    }
  }
}
```

Without `exp_continue`, the first matching branch would end the script. With it, the script behaves like a small state machine over the PTY stream.

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

Inside `js { ... }`, these bindings are available:

```ts
declare const context: Record<string, unknown>
declare const expect: {
  buffer: string
  before: string
  match: string
  groups: string[]
  after: string
  stream: "pty"
}
declare function send(text: string): void
```

Prefer one-shot scripts that exit or reach a clear terminal state. Include a `timeout` branch that throws with `expect.buffer` when debugging an uncertain TUI.
