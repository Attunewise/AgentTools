const fs = require('node:fs')

const compactError = err => ({
  code: err && err.code || 'error',
  message: err && err.message ? String(err.message).slice(0, 240) : String(err).slice(0, 240)
})

const reconcileThreadRecord = async (thread, options = {}) => {
  const diagnostics = options.diagnostics || null
  const appServer = options.appServer || null
  const attempts = []
  const rolloutPath = thread && (thread.rollout_path || thread.rolloutPath || thread.path)
  if (rolloutPath && fs.existsSync(rolloutPath)) {
    return {
      ok: true,
      status: 'resolved',
      warning: null,
      thread,
      rollout_path: rolloutPath,
      attempts
    }
  }

  if (rolloutPath) {
    attempts.push({ code: 'rollout_path_missing', status: 'detected' })
    if (diagnostics) diagnostics.append('repairs', {
      code: 'rollout_path_missing',
      status: 'detected',
      thread_id: thread && thread.id
    })
  }

  if (appServer && thread && thread.id && typeof appServer.threadRead === 'function') {
    try {
      const read = await appServer.threadRead(thread.id, { includeTurns: false })
      attempts.push({ code: 'app_server_thread_read', status: 'succeeded' })
      return {
        ok: true,
        status: 'degraded',
        warning: rolloutPath ? 'repaired_missing_rollout_via_app_server' : 'resolved_via_app_server',
        thread: read && read.thread || read,
        rollout_path: rolloutPath || (read && read.thread && read.thread.path) || null,
        attempts
      }
    } catch (err) {
      attempts.push({ code: 'app_server_thread_read', status: 'failed', error: compactError(err) })
      if (diagnostics) diagnostics.append('repairs', {
        code: 'app_server_thread_read',
        status: 'failed',
        thread_id: thread.id
      })
    }
  }

  return {
    ok: false,
    status: 'blocked',
    reason: rolloutPath ? 'rollout_missing_after_repair' : 'thread_missing_rollout_path',
    thread,
    rollout_path: rolloutPath || null,
    attempts
  }
}

module.exports = {
  compactError,
  reconcileThreadRecord
}
