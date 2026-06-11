const { EventEmitter } = require('events')

const DEFAULT_TIMEOUT_SECONDS = 10
const MAX_BUFFER_CHARS = 200_000

class TclTokenizer {
  constructor(source) {
    this.source = String(source || '')
    this.index = 0
  }

  eof() {
    return this.index >= this.source.length
  }

  skipWhitespace() {
    while (!this.eof()) {
      const char = this.source[this.index]
      if (/\s/.test(char)) {
        this.index += 1
        continue
      }
      if (char === '#') {
        while (!this.eof() && this.source[this.index] !== '\n') this.index += 1
        continue
      }
      break
    }
  }

  readWord() {
    this.skipWhitespace()
    if (this.eof()) return null

    const char = this.source[this.index]
    if (char === '{') return this.readBraceWord()
    if (char === '"') return this.readQuoteWord()
    return this.readBareWord()
  }

  readBraceWord() {
    let depth = 0
    const start = this.index
    this.index += 1
    depth += 1

    while (!this.eof()) {
      const char = this.source[this.index]
      const previous = this.source[this.index - 1]
      if (char === '{' && previous !== '\\') {
        depth += 1
      } else if (char === '}' && previous !== '\\') {
        depth -= 1
        if (depth === 0) {
          const value = this.source.slice(start + 1, this.index)
          this.index += 1
          return value
        }
      }
      this.index += 1
    }

    throw new Error('Unclosed Tcl brace block')
  }

  readQuoteWord() {
    this.index += 1
    let value = ''

    while (!this.eof()) {
      const char = this.source[this.index]
      if (char === '"') {
        this.index += 1
        return this.decodeEscapes(value)
      }
      if (char === '\\' && this.index + 1 < this.source.length) {
        value += char + this.source[this.index + 1]
        this.index += 2
        continue
      }
      value += char
      this.index += 1
    }

    throw new Error('Unclosed Tcl quoted string')
  }

  readBareWord() {
    const start = this.index
    while (!this.eof()) {
      const char = this.source[this.index]
      if (/\s/.test(char)) break
      this.index += 1
    }
    return this.source.slice(start, this.index)
  }

  decodeEscapes(value) {
    return String(value)
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}

const readAllWords = source => {
  const tokenizer = new TclTokenizer(source)
  const words = []
  while (true) {
    const word = tokenizer.readWord()
    if (word == null) break
    words.push(word)
  }
  return words
}

const parseAction = source => {
  const words = readAllWords(source)
  const commands = []
  let expContinue = false
  let continueTimer = false

  for (let index = 0; index < words.length;) {
    const command = words[index++]
    if (command === 'js') {
      const javascript = words[index++]
      if (javascript == null) throw new Error('js action requires a braced JavaScript block')
      commands.push({ type: 'js', javascript })
      continue
    }

    if (command === 'exp_continue') {
      expContinue = true
      if (words[index] === '-continue_timer') {
        continueTimer = true
        index += 1
      }
      continue
    }

    if (command === 'send') {
      if (words[index] === '--') index += 1
      const text = words[index++]
      if (text == null) throw new Error('send requires text')
      commands.push({ type: 'send', text })
      continue
    }

    if (command === 'exit') {
      const code = Number(words[index++] || 0)
      commands.push({ type: 'exit', code: Number.isFinite(code) ? code : 0 })
      continue
    }

    throw new Error(`Unsupported expect action command: ${command}`)
  }

  return {
    commands,
    expContinue,
    continueTimer
  }
}

const parseExpectBlock = blockSource => {
  const words = readAllWords(blockSource)
  const patterns = []

  for (let index = 0; index < words.length;) {
    const word = words[index++]
    if (word === '-re' || word === '-ex') {
      const pattern = words[index++]
      const action = words[index++]
      if (pattern == null || action == null) throw new Error(`${word} pattern requires a pattern and action block`)
      patterns.push({
        type: word === '-re' ? 'regex' : 'exact',
        pattern,
        action: parseAction(action)
      })
      continue
    }

    if (word === 'timeout' || word === 'eof' || word === 'default') {
      const action = words[index++]
      if (action == null) throw new Error(`${word} requires an action block`)
      patterns.push({
        type: word,
        pattern: word,
        action: parseAction(action)
      })
      continue
    }

    const action = words[index++]
    if (action == null) throw new Error(`glob pattern ${word} requires an action block`)
    patterns.push({
      type: 'glob',
      pattern: word,
      action: parseAction(action)
    })
  }

  return patterns
}

const globToRegExp = pattern => {
  const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  return new RegExp(escaped.replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]'))
}

const parseExpectScript = source => {
  const words = readAllWords(source)
  const script = {
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    expectBlocks: []
  }

  for (let index = 0; index < words.length;) {
    const command = words[index++]
    if (command === 'set') {
      const name = words[index++]
      const value = words[index++]
      if (name === 'timeout') {
        const timeout = Number(value)
        if (!Number.isFinite(timeout)) throw new Error(`Invalid timeout: ${value}`)
        script.timeoutSeconds = timeout
      }
      continue
    }

    if (command === 'expect') {
      const block = words[index++]
      if (block == null) throw new Error('expect requires a braced pattern block')
      script.expectBlocks.push(parseExpectBlock(block))
      continue
    }

    throw new Error(`Unsupported expect command: ${command}`)
  }

  if (script.expectBlocks.length === 0) throw new Error('Expect script must contain at least one expect block')
  return script
}

class HybridExpectStream {
  constructor({ write, kill, maxBufferChars = MAX_BUFFER_CHARS } = {}) {
    this.write = write || (() => {})
    this.kill = kill || (() => {})
    this.maxBufferChars = maxBufferChars
    this.buffer = ''
    this.transcript = ''
    this.ended = false
    this.emitter = new EventEmitter()
  }

  append(chunk) {
    if (!chunk) return
    const text = String(chunk)
    this.buffer += text
    this.transcript += text
    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxBufferChars)
    }
    this.emitter.emit('change')
  }

  end() {
    this.ended = true
    this.emitter.emit('change')
  }

  waitForChange(timeoutMs) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        cleanup()
        resolve('timeout')
      }, timeoutMs)
      const onChange = () => {
        cleanup()
        resolve('change')
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.emitter.off('change', onChange)
      }
      this.emitter.on('change', onChange)
    })
  }
}

const matchPattern = (buffer, pattern) => {
  if (pattern.type === 'exact') {
    const index = buffer.indexOf(pattern.pattern)
    if (index < 0) return null
    return {
      index,
      end: index + pattern.pattern.length,
      match: pattern.pattern,
      groups: []
    }
  }

  let regex
  if (pattern.type === 'regex') regex = new RegExp(pattern.pattern)
  else if (pattern.type === 'glob') regex = globToRegExp(pattern.pattern)
  else return null

  const match = regex.exec(buffer)
  if (!match) return null
  return {
    index: match.index,
    end: match.index + match[0].length,
    match: match[0],
    groups: match.slice(1)
  }
}

class ExpectExit extends Error {
  constructor(code) {
    super(`Expect script exited with code ${code}`)
    this.code = code
  }
}

const executeAction = async ({ action, stream, match, context, console }) => {
  let jsResult
  const expect = {
    buffer: stream.buffer.slice(0, match.end),
    before: stream.buffer.slice(0, match.index),
    match: match.match,
    groups: match.groups,
    after: stream.buffer.slice(match.end),
    stream: 'pty'
  }
  const send = value => stream.write(String(value))

  for (const command of action.commands) {
    if (command.type === 'send') {
      send(command.text)
      continue
    }
    if (command.type === 'exit') throw new ExpectExit(command.code)
    if (command.type === 'js') {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const fn = new AsyncFunction('context', 'expect', 'send', 'console', command.javascript)
      jsResult = await fn(context, expect, send, console)
    }
  }

  return {
    jsResult,
    expect
  }
}

const runExpectBlock = async ({ patterns, timeoutSeconds, stream, context, console }) => {
  const timeoutPattern = patterns.find(pattern => pattern.type === 'timeout')
  const eofPattern = patterns.find(pattern => pattern.type === 'eof')
  const defaultPattern = patterns.find(pattern => pattern.type === 'default')
  const normalPatterns = patterns.filter(pattern => !['timeout', 'eof', 'default'].includes(pattern.type))
  let timeoutDeadline = Date.now() + (timeoutSeconds * 1000)

  while (true) {
    for (const pattern of normalPatterns) {
      const match = matchPattern(stream.buffer, pattern)
      if (!match) continue
      const actionResult = await executeAction({ action: pattern.action, stream, match, context, console })
      stream.buffer = stream.buffer.slice(match.end)
      if (pattern.action.expContinue) {
        if (!pattern.action.continueTimer) timeoutDeadline = Date.now() + (timeoutSeconds * 1000)
        continue
      }
      return {
        type: 'match',
        pattern: pattern.pattern,
        match: actionResult.expect,
        result: actionResult.jsResult
      }
    }

    if (stream.ended) {
      const pattern = eofPattern || defaultPattern
      if (!pattern) return { type: 'eof', result: null }
      const actionResult = await executeAction({
        action: pattern.action,
        stream,
        match: { index: stream.buffer.length, end: stream.buffer.length, match: '', groups: [] },
        context,
        console
      })
      return {
        type: 'eof',
        pattern: pattern.pattern,
        match: actionResult.expect,
        result: actionResult.jsResult
      }
    }

    const remainingMs = Math.max(0, timeoutDeadline - Date.now())
    const reason = await stream.waitForChange(remainingMs)
    if (reason === 'timeout') {
      const pattern = timeoutPattern || defaultPattern
      if (!pattern) return { type: 'timeout', result: null }
      const actionResult = await executeAction({
        action: pattern.action,
        stream,
        match: { index: stream.buffer.length, end: stream.buffer.length, match: '', groups: [] },
        context,
        console
      })
      if (pattern.action.expContinue) {
        if (!pattern.action.continueTimer) timeoutDeadline = Date.now() + (timeoutSeconds * 1000)
        continue
      }
      return {
        type: 'timeout',
        pattern: pattern.pattern,
        match: actionResult.expect,
        result: actionResult.jsResult
      }
    }
  }
}

const runExpectScript = async ({ script, stream, context = {}, console = global.console }) => {
  const parsed = typeof script === 'string' ? parseExpectScript(script) : script
  let lastResult = null
  try {
    for (const patterns of parsed.expectBlocks) {
      lastResult = await runExpectBlock({
        patterns,
        timeoutSeconds: parsed.timeoutSeconds,
        stream,
        context,
        console
      })
    }
  } catch (err) {
    if (err instanceof ExpectExit) {
      return {
        exitCode: err.code,
        result: null,
        transcript: stream.transcript,
        remainingBuffer: stream.buffer
      }
    }
    throw err
  }

  return {
    exitCode: 0,
    result: lastResult && lastResult.result,
    match: lastResult && lastResult.match,
    type: lastResult && lastResult.type,
    transcript: stream.transcript,
    remainingBuffer: stream.buffer
  }
}

module.exports = {
  HybridExpectStream,
  parseExpectScript,
  runExpectScript
}
