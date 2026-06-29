const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { compactSummaryBudget } = require('./pricing.js')
const { processResourceUsage } = require('./resourceUsage.js')
const { hashString, readJson, withFileLock, writeJson } = require('./util.js')

const JOB_SCHEMA = 'session-indexer.indexing-job.v1'
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_POLL_MS = 250

const jobsDir = root => path.join(root, 'jobs')
const jobPath = (root, jobId) => path.join(jobsDir(root), `${jobId}.json`)
const jobLogPath = (root, jobId, stream) => path.join(jobsDir(root), `${jobId}.${stream}.log`)
const jobLockPath = (root, jobId) => path.join(jobsDir(root), `${jobId}.lock`)

const now = () => new Date().toISOString()

const isPidRunning = pid => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (_err) {
    return false
  }
}

const normalizeSessions = sessions => (sessions || []).map(file => path.resolve(file)).sort()

const makeIndexingJobId = ({
  source,
  scope,
  indexDir,
  sourceRoot,
  sessions,
  searchBackend,
  typesenseCollection,
  summaryMode,
  summaryProvider,
  summaryModel,
  summaryReasoningEffort,
  summaryBatchId,
  summaryInputTokenBudget,
  summaryMaxBudgetUsd,
  summaryConcurrency,
  summaryRateLimitMaxRetries,
  summaryRateLimitBackoffMs,
  summaryRateLimitMaxBackoffMs,
  pricingCacheDir,
  maxSummaryNodes,
  sessionMarker
}) => {
  const material = JSON.stringify({
    source,
    scope,
    indexDir: path.resolve(indexDir),
    sourceRoot: sourceRoot ? path.resolve(sourceRoot) : '',
    sessions: normalizeSessions(sessions),
    searchBackend: searchBackend || '',
    typesenseCollection: typesenseCollection || '',
    summaryMode: summaryMode || '',
    summaryProvider: summaryProvider || '',
    summaryModel: summaryModel || '',
    summaryReasoningEffort: summaryReasoningEffort || '',
    summaryBatchId: summaryBatchId || '',
    summaryInputTokenBudget: summaryInputTokenBudget || '',
    summaryMaxBudgetUsd: summaryMaxBudgetUsd || '',
    summaryConcurrency: summaryConcurrency || '',
    summaryRateLimitMaxRetries: summaryRateLimitMaxRetries || '',
    summaryRateLimitBackoffMs: summaryRateLimitBackoffMs || '',
    summaryRateLimitMaxBackoffMs: summaryRateLimitMaxBackoffMs || '',
    pricingCacheDir: pricingCacheDir ? path.resolve(pricingCacheDir) : '',
    maxSummaryNodes: maxSummaryNodes || '',
    sessionMarker: sessionMarker || ''
  })
  return `index-${hashString(material).slice(0, 24)}`
}

const readJobState = ({ root, jobId }) => {
  try {
    return readJson(jobPath(root, jobId))
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return null
  }
}

const normalizeJobState = state => {
  const next = { ...state }
  if (next.status && next.status !== 'error') delete next.error
  if (next.status && next.status !== 'suspended') {
    delete next.message
    delete next.suspendedReason
    delete next.suspension
    delete next.summaryBudget
  }
  return next
}

const writeJobState = ({ root, state }) => {
  return withFileLock(jobLockPath(root, state.jobId), () => {
    const current = readJobState({ root, jobId: state.jobId }) || {}
    writeJson(jobPath(root, state.jobId), normalizeJobState({
      ...current,
      ...state,
      schema: JOB_SCHEMA,
      updatedAt: now()
    }))
  })
}

const listJobStates = ({ root }) => {
  let files = []
  try {
    files = fs.readdirSync(jobsDir(root))
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return []
  }
  return files
    .filter(file => file.endsWith('.json'))
    .flatMap(file => {
      try {
        return [readJson(path.join(jobsDir(root), file))]
      } catch (err) {
        if (err && err.code === 'ENOENT') return []
        throw err
      }
    })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const publicSuspension = suspension => {
  if (!suspension || typeof suspension !== 'object') return suspension
  const summaryBudget = compactSummaryBudget(suspension.summaryBudget)
  return {
    ...suspension,
    ...(summaryBudget ? { summaryBudget } : {})
  }
}

const publicProgress = progress => {
  if (!progress || typeof progress !== 'object') return progress || {}
  const summaryBudget = compactSummaryBudget(progress.summaryBudget)
  return {
    ...progress,
    ...(summaryBudget ? { summaryBudget } : {})
  }
}

const publicJobState = state => {
  if (!state) return null
  const running = isPidRunning(state.pid)
  const resourceUsage = running ? processResourceUsage(state.pid) : null
  const summaryBudget = compactSummaryBudget(state.summaryBudget)
  const stateReady = state.ready === true || (state.ready !== false && state.status === 'ready')
  const status = running
    ? state.status === 'ready' && !stateReady
      ? 'indexing'
      : state.status
    : ['error', 'stopped', 'suspended'].includes(state.status) ? state.status : 'stale'
  const ready = status === 'ready' && running
  return {
    jobId: state.jobId,
    scope: state.scope,
    source: state.source,
    searchBackend: state.searchBackend,
    typesenseCollection: state.typesenseCollection,
    summaryMode: state.summaryMode,
    summaryProvider: state.summaryProvider,
    summaryModel: state.summaryModel,
    summaryReasoningEffort: state.summaryReasoningEffort,
    summaryBatchId: state.summaryBatchId,
    summaryInputTokenBudget: state.summaryInputTokenBudget,
    summaryMaxBudgetUsd: state.summaryMaxBudgetUsd,
    summaryConcurrency: state.summaryConcurrency,
    summaryRateLimitMaxRetries: state.summaryRateLimitMaxRetries,
    summaryRateLimitBackoffMs: state.summaryRateLimitBackoffMs,
    summaryRateLimitMaxBackoffMs: state.summaryRateLimitMaxBackoffMs,
    pricingCacheDir: state.pricingCacheDir,
    indexDir: state.indexDir,
    sourceRoot: state.sourceRoot,
    sessions: state.sessions || [],
    sessionMarker: state.sessionMarker,
    waitForSessionMarker: state.waitForSessionMarker,
    pid: state.pid,
    status,
    ready,
    suspendedReason: state.suspendedReason,
    suspension: publicSuspension(state.suspension),
    summaryBudget,
    message: state.message,
    ...(resourceUsage ? { resourceUsage } : {}),
    progress: publicProgress(state.progress),
    error: state.error,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    log: state.log
  }
}

const waitForJob = async ({ root, jobId, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS }) => {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let state = readJobState({ root, jobId })
  while (Date.now() <= deadline) {
    state = readJobState({ root, jobId })
    const publicState = publicJobState(state)
    if (publicState && ['ready', 'error', 'stopped', 'stale', 'suspended'].includes(publicState.status)) return publicState
    if (timeoutMs <= 0) break
    await sleep(pollMs)
  }
  return publicJobState(readJobState({ root, jobId }))
}

const startIndexingJob = async ({
  binPath,
  root,
  jobId,
  source,
  scope,
  searchBackend,
  typesenseCollection,
  summaryMode,
  summaryProvider,
  summaryModel,
  summaryReasoningEffort,
  summaryBatchId,
  summaryInputTokenBudget,
  summaryMaxBudgetUsd,
  summaryConcurrency,
  summaryRateLimitMaxRetries,
  summaryRateLimitBackoffMs,
  summaryRateLimitMaxBackoffMs,
  pricingCacheDir,
  maxSummaryNodes,
  sourceRoot,
  sessionMarker,
  waitForSessionMarker,
  sessions,
  workerArgs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS
}) => {
  const existing = readJobState({ root, jobId })
  if (existing && isPidRunning(existing.pid)) {
    return {
      reused: true,
      job: await waitForJob({ root, jobId, timeoutMs, pollMs })
    }
  }

  fs.mkdirSync(jobsDir(root), { recursive: true })
  const stdout = fs.openSync(jobLogPath(root, jobId, 'out'), 'w')
  const stderr = fs.openSync(jobLogPath(root, jobId, 'err'), 'w')
  writeJobState({
    root,
    state: {
      jobId,
      scope,
      source,
      searchBackend,
      typesenseCollection,
      summaryMode,
      summaryProvider,
      summaryModel,
      summaryReasoningEffort,
      summaryBatchId,
      summaryInputTokenBudget,
      summaryMaxBudgetUsd,
      summaryConcurrency,
      summaryRateLimitMaxRetries,
      summaryRateLimitBackoffMs,
      summaryRateLimitMaxBackoffMs,
      pricingCacheDir,
      maxSummaryNodes,
      indexDir: root,
      sourceRoot,
      sessionMarker,
      waitForSessionMarker: Boolean(waitForSessionMarker),
      sessions: normalizeSessions(sessions),
      status: 'starting',
      ready: false,
      progress: {
        phase: 'starting',
        indexed: 0,
        total: sessions.length
      },
      startedAt: now(),
      log: {
        stdout: jobLogPath(root, jobId, 'out'),
        stderr: jobLogPath(root, jobId, 'err')
      }
    }
  })

  const child = childProcess.spawn(process.execPath, [binPath, ...workerArgs], {
    detached: true,
    stdio: ['ignore', stdout, stderr]
  })
  child.unref()
  fs.closeSync(stdout)
  fs.closeSync(stderr)
  writeJobState({
    root,
    state: {
      jobId,
      pid: child.pid,
      status: 'starting'
    }
  })

  return {
    reused: false,
    job: await waitForJob({ root, jobId, timeoutMs, pollMs })
  }
}

const sessionIntersects = (state, sessions) => {
  const needles = new Set(normalizeSessions(sessions))
  return (state.sessions || []).some(file => needles.has(path.resolve(file)))
}

const matchingJobs = ({ root, scope, sessions }) => {
  const states = listJobStates({ root })
  if (scope === 'all') return states
  return states.filter(state => state.scope === 'this_session_only' && sessionIntersects(state, sessions))
}

const stateMentionsSessionId = (state, sessionId) => {
  if (!sessionId) return false
  if (state.sessionId === sessionId) return true
  return Boolean(state.result && (state.result.sessions || []).some(session => session && session.sessionId === sessionId))
}

const stateMentionsSourcePath = (state, sourcePath) => {
  if (!sourcePath) return false
  const target = path.resolve(sourcePath)
  return (state.sessions || []).some(file => path.resolve(file) === target)
}

const matchingSessionJobs = ({ root, sessionId, sourcePath }) => {
  return listJobStates({ root }).filter(state =>
    stateMentionsSessionId(state, sessionId) ||
    stateMentionsSourcePath(state, sourcePath)
  )
}

const jobArtifactPaths = (root, jobId) => [
  jobPath(root, jobId),
  jobLogPath(root, jobId, 'out'),
  jobLogPath(root, jobId, 'err'),
  jobLockPath(root, jobId)
]

const removePathIfExists = file => {
  try {
    fs.rmSync(file, { recursive: true, force: false })
    return true
  } catch (err) {
    if (err && err.code === 'ENOENT') return false
    throw err
  }
}

const removeJobArtifactsForSession = ({ root, sessionId, sourcePath }) => {
  const jobs = matchingSessionJobs({ root, sessionId, sourcePath })
  const running = jobs.filter(state => isPidRunning(state.pid))
  if (running.length) {
    throw new Error(`cannot reset session ${sessionId}: indexing job is still running (${running.map(state => state.jobId).join(', ')})`)
  }
  return jobs.map(state => {
    const removedFiles = jobArtifactPaths(root, state.jobId).filter(removePathIfExists)
    return {
      jobId: state.jobId,
      removedFiles
    }
  }).filter(item => item.removedFiles.length)
}

const stopIndexingJobs = async ({ root, scope, sessions = [], timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS }) => {
  const jobs = matchingJobs({ root, scope, sessions })
  const stopped = []
  for (const state of jobs) {
    if (isPidRunning(state.pid)) {
      writeJobState({
        root,
        state: {
          jobId: state.jobId,
          status: 'stop_requested',
          progress: {
            ...(state.progress || {}),
            phase: 'stop_requested'
          }
        }
      })
      try {
        process.kill(state.pid, 'SIGTERM')
      } catch (err) {
        if (!err || err.code !== 'ESRCH') throw err
      }
    }
  }

  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (const state of jobs) {
    let current = readJobState({ root, jobId: state.jobId }) || state
    while (Date.now() <= deadline && isPidRunning(current.pid) && current.status !== 'stopped') {
      await sleep(pollMs)
      current = readJobState({ root, jobId: state.jobId }) || current
    }
    if (!isPidRunning(current.pid) && current.status !== 'stopped') {
      writeJobState({
        root,
        state: {
          jobId: state.jobId,
          status: 'stopped',
          progress: {
            ...(current.progress || {}),
            phase: 'stopped'
          }
        }
      })
      current = readJobState({ root, jobId: state.jobId }) || current
    }
    stopped.push(publicJobState(current))
  }
  return stopped
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  isPidRunning,
  JOB_SCHEMA,
  jobsDir,
  listJobStates,
  makeIndexingJobId,
  publicJobState,
  readJobState,
  removeJobArtifactsForSession,
  startIndexingJob,
  stopIndexingJobs,
  waitForJob,
  writeJobState
}
