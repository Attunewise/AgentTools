# Agent Tools Expect

Standalone Expect-style PTY runner for agent skills, to automate TUI's and other terminal interactions with minimal token use.

```bash
npm install
node bin/expect-tool.js run --cmd 'python3 -i' --script-file script.expect
node bin/expect-tool.js run --cmd 'python3 -i' --script-file script.expect --log-file /tmp/expect-transcript.log
node scripts/deploy-skills.js --target all --mode copy --force
```

Use `--log-file` when the raw PTY transcript should be retained without sending it back through the model context. Programmatic callers can pass `log_path`.

Inside `js { ... }`, scripts can call `expect.exp_continue()` to keep matching when continuation depends on runtime state. Returning the value is optional; both `return expect.exp_continue()` and a bare `expect.exp_continue()` request continuation. Pass `{ continue_timer: true }` to match `exp_continue -continue_timer`. Returning any ordinary JavaScript value ends the current expect block with that value.

The deployed skill is a normal `SKILL.md` directory and works with Codex, Pi, and Claude Code.
