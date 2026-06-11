# Agent Tools Expect

Standalone Expect-style PTY runner for agent skills, to automate TUI's and other terminal interactions with minimal token use.

```bash
npm install
node bin/expect-tool.js run --cmd 'python3 -i' --script-file script.expect
node scripts/deploy-skills.js --target all --mode copy --force
```

The deployed skill is a normal `SKILL.md` directory and works with Codex, Pi, and Claude Code.
