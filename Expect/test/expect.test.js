const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ExpectTool } = require('../src/expectTool.js')
const { parseExpectScript } = require('../src/hybridExpect.js')
const { run: deploySkills } = require('../scripts/deploy-skills.js')

test('parses expect syntax with regex, send, js, timeout, and exp_continue', () => {
  const parsed = parseExpectScript(`
set timeout 5
expect {
  -re {Name: $} {
    send -- "Ada\\r"
    exp_continue
  }
  timeout {
    js {
      throw new Error("timeout")
    }
  }
}
`)

  assert.equal(parsed.timeoutSeconds, 5)
  assert.equal(parsed.expectBlocks.length, 1)
  assert.equal(parsed.expectBlocks[0][0].type, 'regex')
  assert.equal(parsed.expectBlocks[0][0].action.commands[0].type, 'send')
  assert.equal(parsed.expectBlocks[0][0].action.expContinue, true)
})

test('runs an expect script against a PTY command', async () => {
  const tool = new ExpectTool()
  const program = "process.stdout.write('Name: '); process.stdin.once('data', d => { console.log('Hello ' + d.toString().trim()); });"
  const cmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`
  const result = await tool.run({
    cmd,
    script: `
set timeout 5
expect {
  -re {Name: $} {
    send -- "Ada\\r"
    exp_continue
  }
  -re {Hello Ada\\r?\\n} {
    js {
      return { ok: true, match: expect.match }
    }
  }
  timeout {
    js {
      throw new Error("Timed out waiting for greeting. Buffer:\\n" + expect.buffer)
    }
  }
}
`
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.result, { ok: true, match: 'Hello Ada\r\n' })
  assert.match(result.transcript, /Name: Ada/)
  assert.match(result.transcript, /Hello Ada/)
})

test('writes full raw PTY transcript to log_path while returned transcript stays bounded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-expect-log-'))
  try {
    const logPath = path.join(root, 'transcript.log')
    const program = "console.log('alpha'); console.log('beta');"
    const cmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`
    const tool = new ExpectTool()
    const result = await tool.run({
      cmd,
      log_path: logPath,
      max_output_chars: 6,
      script: `
set timeout 5
expect {
  -re {beta\\r?\\n} {
    js {
      return { ok: true }
    }
  }
}
`
    })

    assert.equal(result.log_path, logPath)
    assert.equal(result.transcript.length <= 6, true)
    const logged = fs.readFileSync(logPath, 'utf8')
    assert.match(logged, /alpha/)
    assert.match(logged, /beta/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deploy helper installs skill copies to selected harness directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-expect-deploy-'))
  const priorCodexHome = process.env.CODEX_HOME
  const priorPiAgentDir = process.env.PI_AGENT_DIR
  const priorClaudeHome = process.env.CLAUDE_HOME
  process.env.CODEX_HOME = path.join(root, 'codex')
  process.env.PI_AGENT_DIR = path.join(root, 'pi-agent')
  process.env.CLAUDE_HOME = path.join(root, 'claude')
  try {
    const result = deploySkills({
      target: 'all',
      mode: 'copy',
      force: true,
      install: false
    })
    assert.equal(result.deployed.length, 3)
    assert.ok(fs.existsSync(path.join(root, 'codex', 'skills', 'expect', 'SKILL.md')))
    assert.ok(fs.existsSync(path.join(root, 'pi-agent', 'skills', 'expect', 'SKILL.md')))
    assert.ok(fs.existsSync(path.join(root, 'claude', 'skills', 'expect', 'SKILL.md')))
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = priorCodexHome
    if (priorPiAgentDir === undefined) delete process.env.PI_AGENT_DIR
    else process.env.PI_AGENT_DIR = priorPiAgentDir
    if (priorClaudeHome === undefined) delete process.env.CLAUDE_HOME
    else process.env.CLAUDE_HOME = priorClaudeHome
    fs.rmSync(root, { recursive: true, force: true })
  }
})
