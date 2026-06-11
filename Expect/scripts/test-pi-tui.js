#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const { ExpectTool } = require('../src/expectTool.js')

const script = `
set timeout 10
expect {
  -re {π - [^\\x07]+\\x07} {
    send -- "/quit\\r"
    exp_continue
  }
  eof {
    js {
      return { ok: true, exited: true, transcriptTail: expect.buffer.slice(-1200) }
    }
  }
  timeout {
    js {
      throw new Error("Timed out waiting for Pi TUI exit. Buffer:\\n" + expect.buffer.slice(-2000))
    }
  }
}
`

const main = async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-expect-agent-'))
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-expect-work-'))
  try {
    const tool = new ExpectTool()
    const result = await tool.run({
      cmd: `env PI_CODING_AGENT_DIR=${JSON.stringify(agentDir)} PI_OFFLINE=1 TERM=xterm-256color pi --no-session --no-tools --no-skills --no-extensions --offline`,
      workdir,
      script,
      max_output_chars: 8000
    })
    if (!result.process_exited || result.process_exit_code !== 0 || !result.result || !result.result.ok) {
      throw new Error(`Pi TUI smoke failed: ${JSON.stringify(result, null, 2)}`)
    }
    console.log(JSON.stringify({
      schema: 'agent-tools-expect.pi-tui-smoke.v1',
      ok: true,
      process_exit_code: result.process_exit_code,
      transcriptMatched: /pi|π/.test(result.transcript)
    }, null, 2))
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true })
    fs.rmSync(workdir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err.stack || err.message)
  process.exit(1)
})
