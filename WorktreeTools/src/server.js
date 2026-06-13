const fs = require('node:fs')
const path = require('node:path')

const {
  safeSnapshotWorktree,
  snapshotWorktree
} = require('./index.js')

class WorktreeServerState {
  constructor(options = {}) {
    this.watch = options.watch !== false
    this.cache = new Map()
    this.watchers = new Map()
    this.events = []
    this.startedAt = new Date().toISOString()
  }

  pushEvent(reason) {
    this.events.push({
      at: new Date().toISOString(),
      reason
    })
    this.events = this.events.slice(-50)
  }

  snapshot(cwd = process.cwd()) {
    const result = safeSnapshotWorktree(cwd)
    const root = result.snapshot && result.snapshot.root
    if (root) {
      this.cache.set(root, result.snapshot)
      this.watchWorktree(result.snapshot)
    }
    this.pushEvent(`snapshot:${root || cwd}`)
    return result
  }

  refresh(cwd = process.cwd()) {
    return this.snapshot(cwd)
  }

  watchWorktree(snapshot) {
    if (!this.watch || !snapshot || !snapshot.root || this.watchers.has(snapshot.root)) return
    const files = [
      snapshot.private_paths && snapshot.private_paths.index,
      snapshot.private_paths && snapshot.private_paths.head,
      path.join(snapshot.common_git_dir, 'packed-refs'),
      path.join(snapshot.common_git_dir, 'worktrees')
    ].filter(Boolean)
    const watchers = []
    for (const file of files) {
      try {
        const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? file : path.dirname(file)
        const watcher = fs.watch(target, () => {
          try {
            const refreshed = snapshotWorktree(snapshot.root)
            this.cache.set(snapshot.root, refreshed)
            this.pushEvent(`watch:${snapshot.root}`)
          } catch (err) {
            this.pushEvent(`watch-error:${snapshot.root}:${err && err.code || 'error'}`)
          }
        })
        if (watcher.unref) watcher.unref()
        watchers.push(watcher)
      } catch (_) {
        // Missing git internals are common around worktree changes; refresh will revalidate later.
      }
    }
    this.watchers.set(snapshot.root, watchers)
  }

  status() {
    return {
      schema: 'worktree-tools.server-state.v1',
      started_at: this.startedAt,
      watch: this.watch,
      cached_worktree_count: this.cache.size,
      cached_roots: Array.from(this.cache.keys()),
      recent_events: this.events
    }
  }

  stop() {
    for (const watchers of this.watchers.values()) {
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch (_) {
          // Already closed.
        }
      }
    }
    this.watchers.clear()
  }
}

module.exports = {
  WorktreeServerState
}
