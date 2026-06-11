const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const numberOrNull = value => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const processResourceUsage = pid => {
  const numericPid = Number(pid)
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null
  try {
    const output = childProcess.execFileSync('ps', [
      '-o', 'pid=',
      '-o', 'ppid=',
      '-o', 'stat=',
      '-o', '%cpu=',
      '-o', '%mem=',
      '-o', 'rss=',
      '-o', 'vsz=',
      '-o', 'etime=',
      '-p', String(numericPid)
    ], {
      encoding: 'utf8',
      timeout: 1000
    }).trim()
    if (!output) return null
    const parts = output.split(/\s+/)
    const rssKiB = numberOrNull(parts[5])
    const vszKiB = numberOrNull(parts[6])
    return {
      pid: numberOrNull(parts[0]) || numericPid,
      parentPid: numberOrNull(parts[1]),
      status: parts[2] || '',
      cpuPercent: numberOrNull(parts[3]),
      memoryPercent: numberOrNull(parts[4]),
      rssBytes: rssKiB === null ? null : rssKiB * 1024,
      virtualMemoryBytes: vszKiB === null ? null : vszKiB * 1024,
      elapsed: parts[7] || '',
      sampledAt: new Date().toISOString()
    }
  } catch (_err) {
    return null
  }
}

const directorySizeBytes = dir => {
  if (!dir) return null
  let total = 0
  const stack = [dir]
  let sawPath = false
  while (stack.length) {
    const current = stack.pop()
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (err) {
      if (err && err.code === 'ENOENT') continue
      throw err
    }
    sawPath = true
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      let entries
      try {
        entries = fs.readdirSync(current)
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) continue
        throw err
      }
      for (const entry of entries) stack.push(path.join(current, entry))
    } else {
      total += stat.size
    }
  }
  return sawPath ? total : null
}

module.exports = {
  directorySizeBytes,
  processResourceUsage
}
