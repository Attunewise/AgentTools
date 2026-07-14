const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { StringDecoder } = require('string_decoder')

const CHARS_PER_TOKEN = 4

const expandHome = value => {
  if (!value) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

const stableStringify = value => {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch (_err) {
    return String(value)
  }
}

const hashString = value => crypto.createHash('sha256').update(String(value)).digest('hex')

const compactText = value => String(value || '').replace(/\s+/g, ' ').trim()

const preview = (value, max = 240) => {
  const text = compactText(typeof value === 'string' ? value : stableStringify(value))
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

const formatAgo = (date, now = new Date()) => {
  const time = date instanceof Date ? date.getTime() : Date.parse(date)
  if (!Number.isFinite(time)) return null
  const seconds = Math.max(0, Math.floor((now.getTime() - time) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

const estimateTokens = value => Math.max(1, Math.ceil(stableStringify(value).length / CHARS_PER_TOKEN))

const safeId = value => String(value || '')
  .replace(/[^A-Za-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 96) || 'item'

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const syncDir = dir => {
  try {
    const fd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (_err) {}
}

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(tmp, file)
    syncDir(path.dirname(file))
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch (_unlinkErr) {}
    throw err
  }
}

const writeJsonlRows = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, 'w')
    for (const row of rows || []) {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`)
    }
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
    syncDir(path.dirname(file))
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch (_closeErr) {}
    }
    try {
      fs.unlinkSync(tmp)
    } catch (_unlinkErr) {}
    throw err
  }
}

const sleepSync = ms => {
  if (ms <= 0) return
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

const lockOwner = () => ({
  pid: process.pid,
  hostname: os.hostname(),
  acquiredAt: new Date().toISOString()
})

const withFileLock = (lockPath, fn, opts = {}) => {
  const timeoutMs = opts.timeoutMs === undefined ? 30000 : Number(opts.timeoutMs)
  const pollMs = opts.pollMs === undefined ? 50 : Number(opts.pollMs)
  const staleMs = opts.staleMs === undefined ? 10 * 60 * 1000 : Number(opts.staleMs)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  while (true) {
    try {
      fs.mkdirSync(lockPath)
      try {
        writeJson(path.join(lockPath, 'owner.json'), lockOwner())
      } catch (err) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true })
        } catch (_cleanupErr) {}
        throw err
      }
      try {
        return fn()
      } finally {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true })
        } catch (_err) {}
      }
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err
      try {
        const stat = fs.statSync(lockPath)
        if (Number.isFinite(staleMs) && staleMs >= 0 && Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (_statErr) {}
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock: ${lockPath}`)
      }
      sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }
}

const processIsAlive = pid => {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (_err) {
    return false
  }
}

const readLockOwner = lockPath => {
  try {
    return readJson(path.join(lockPath, 'owner.json'))
  } catch (_err) {
    return null
  }
}

const asyncDelay = ms => new Promise(resolve => setTimeout(resolve, ms))

const withAsyncFileLock = async (lockPath, fn, opts = {}) => {
  const timeoutMs = opts.timeoutMs === undefined ? 30000 : Number(opts.timeoutMs)
  const pollMs = opts.pollMs === undefined ? 50 : Number(opts.pollMs)
  const staleMs = opts.staleMs === undefined ? 10 * 60 * 1000 : Number(opts.staleMs)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const token = crypto.randomBytes(16).toString('hex')
  const owner = {
    ...lockOwner(),
    token
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  while (true) {
    try {
      fs.mkdirSync(lockPath)
      try {
        writeJson(path.join(lockPath, 'owner.json'), owner)
      } catch (err) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true })
        } catch (_cleanupErr) {}
        throw err
      }
      break
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err
      try {
        const stat = fs.statSync(lockPath)
        const currentOwner = readLockOwner(lockPath)
        const locallyAlive = currentOwner &&
          currentOwner.hostname === os.hostname() &&
          processIsAlive(currentOwner.pid)
        if (!locallyAlive && Number.isFinite(staleMs) && staleMs >= 0 && Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (_statErr) {}
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock: ${lockPath}`)
      }
      await asyncDelay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }
  const heartbeatMs = Number.isFinite(staleMs) && staleMs > 0
    ? Math.max(1000, Math.floor(staleMs / 3))
    : 60 * 1000
  const heartbeat = setInterval(() => {
    try {
      const currentOwner = readLockOwner(lockPath)
      if (currentOwner && currentOwner.token === token) {
        const now = new Date()
        fs.utimesSync(lockPath, now, now)
      }
    } catch (_err) {}
  }, heartbeatMs)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    try {
      const currentOwner = readLockOwner(lockPath)
      if (currentOwner && currentOwner.token === token) {
        fs.rmSync(lockPath, { recursive: true, force: true })
      }
    } catch (_err) {}
  }
}

function * readLines(file, opts = {}) {
  const chunkSize = Math.max(1, Number(opts.chunkSize || 1024 * 1024))
  const fd = fs.openSync(file, 'r')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.allocUnsafe(chunkSize)
  let carry = ''
  let lineNumber = 0
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!bytesRead) break
      carry += decoder.write(buffer.subarray(0, bytesRead))
      let start = 0
      while (true) {
        const end = carry.indexOf('\n', start)
        if (end < 0) break
        let line = carry.slice(start, end)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        lineNumber += 1
        yield { lineNumber, line }
        start = end + 1
      }
      carry = carry.slice(start)
    }
    carry += decoder.end()
    if (carry) {
      if (carry.endsWith('\r')) carry = carry.slice(0, -1)
      lineNumber += 1
      yield { lineNumber, line: carry }
    }
  } finally {
    fs.closeSync(fd)
  }
}

const parseJsonlLine = ({ lineNumber, line }) => {
  if (!line.trim()) return null
  try {
    return { lineNumber, raw: line, json: JSON.parse(line) }
  } catch (err) {
    return { lineNumber, raw: line, parseError: err.message }
  }
}

function * readJsonlRows(file, opts = {}) {
  for (const item of readLines(file, opts)) {
    const row = parseJsonlLine(item)
    if (row) yield row
  }
}

const readJsonl = file => Array.from(readJsonlRows(file))

const readFileTail = (file, maxBytes = 512 * 1024) => {
  const stat = fs.statSync(file)
  const size = Math.min(stat.size, maxBytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size)
    fs.readSync(fd, buffer, 0, size, stat.size - size)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const readJsonlTail = (file, maxBytes = 512 * 1024) => {
  const text = readFileTail(file, maxBytes)
  const lines = text.split('\n')
  if (lines.length && !text.startsWith('{')) lines.shift()
  const rows = []
  for (let index = 0; index < lines.length; index++) {
    const row = parseJsonlLine({ lineNumber: index + 1, line: lines[index] })
    if (row) rows.push(row)
  }
  return rows
}

const walkFiles = (root, predicate = () => true) => {
  const out = []
  const visit = dir => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_err) {
      return
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && predicate(file)) out.push(file)
    }
  }
  visit(root)
  return out.sort()
}

const newestFile = files => files
  .map(file => {
    try {
      const stat = fs.statSync(file)
      return { file, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch (_err) {
      return null
    }
  })
  .filter(Boolean)
  .sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size)[0]

module.exports = {
  CHARS_PER_TOKEN,
  compactText,
  estimateTokens,
  expandHome,
  formatAgo,
  hashString,
  newestFile,
  preview,
  readFileTail,
  readJson,
  readJsonl,
  readJsonlRows,
  readJsonlTail,
  readLines,
  safeId,
  stableStringify,
  withAsyncFileLock,
  withFileLock,
  walkFiles,
  writeJson,
  writeJsonlRows
}
