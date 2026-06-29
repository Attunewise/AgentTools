const path = require('path')
const fs = require('fs')
const { LOCAL_STATE_DIR } = require('./paths.js')
const {
  directorySizeBytes,
  processResourceUsage
} = require('./resourceUsage.js')
const {
  formatAgo,
  hashString,
  preview,
  readJson,
  readJsonlRows,
  withFileLock,
  writeJson,
  writeJsonlRows
} = require('./util.js')
const {
  applyCompactionSearchScope,
  buildMipTree,
  compactedRetrievalHandles,
  collectIndexDocuments,
  indexIdForIR,
  openLink,
  modelTextForNode,
  nodeSourceFields,
  parseSessionLink
} = require('./mip.js')
const { adapterFor } = require('./adapters/index.js')
const {
  docStorePath,
  writeSessionDocs
} = require('./docStore.js')
const {
  DEFAULT_SUMMARY_MODE,
  applyStoredSummaryJobs,
  prepareCompactedSummaryLayer,
  summarizeTree
} = require('./summarizer.js')
const {
  browseTypesense,
  deleteSessionDocuments,
  exactDocument,
  importDocuments,
  openLinkTypesense,
  resolveTypesenseConfig,
  searchTypesense
} = require('./typesense.js')
const {
  isPidRunning,
  listJobStates,
  publicJobState,
  removeJobArtifactsForSession
} = require('./indexing.js')

const DEFAULT_INDEX_DIR = LOCAL_STATE_DIR
const DEFAULT_SEARCH_BACKEND = 'typesense'

const manifestPath = root => path.join(root, 'manifest.json')
const manifestLockPath = root => path.join(root, 'manifest.lock')
const irPath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.ir.jsonl`)
const legacyIrPath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.ir.json`)
const treePath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.tree.json`)
const summaryTargetsPath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.summary-targets.jsonl`)
const legacySummaryTargetsPath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.summary-targets.json`)
const summaryTargetsLockPath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.summary-targets.lock`)
const SUMMARY_TARGETS_SCHEMA = 'session-indexer.summary-targets.v1'
const DEFAULT_SUMMARY_CLAIM_TTL_MS = 30 * 60 * 1000

const emptyManifest = () => ({
  schema: 'session-indexer.manifest.v1',
  updatedAt: null,
  sessions: {}
})

const readManifest = root => {
  try {
    return readJson(manifestPath(root))
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return emptyManifest()
  }
}

const emptySummaryTargets = sessionId => ({
  schema: SUMMARY_TARGETS_SCHEMA,
  sessionId,
  updatedAt: null,
  targets: {}
})

const readSummaryTargetsJsonl = ({ file, sessionId }) => {
  const store = emptySummaryTargets(sessionId)
  for (const row of readJsonlRows(file)) {
    if (row.parseError) {
      throw new Error(`invalid summary target JSONL at ${file}:${row.lineNumber}: ${row.parseError}`)
    }
    const record = row.json || {}
    if (record.recordType === 'summary_targets_header') {
      store.schema = record.schema || store.schema
      store.sessionId = record.sessionId || store.sessionId
      store.updatedAt = record.updatedAt || store.updatedAt
    } else if (record.recordType === 'summary_target' && record.target && record.target.targetId) {
      store.targets[record.target.targetId] = record.target
    }
  }
  return store
}

const readSummaryTargets = ({ root = DEFAULT_INDEX_DIR, sessionId }) => {
  const jsonl = summaryTargetsPath(root, sessionId)
  if (fs.existsSync(jsonl)) return readSummaryTargetsJsonl({ file: jsonl, sessionId })
  try {
    const stored = readJson(legacySummaryTargetsPath(root, sessionId))
    return {
      ...emptySummaryTargets(sessionId),
      ...stored,
      targets: stored.targets || {}
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return emptySummaryTargets(sessionId)
  }
}

function * summaryTargetRows ({ sessionId, store }) {
  const updatedAt = new Date().toISOString()
  yield {
    recordType: 'summary_targets_header',
    schema: SUMMARY_TARGETS_SCHEMA,
    sessionId,
    updatedAt
  }
  for (const target of Object.values(store.targets || {})) {
    yield {
      recordType: 'summary_target',
      target: {
        ...target,
        updatedAt: target.updatedAt || updatedAt
      }
    }
  }
}

const writeSummaryTargets = ({ root = DEFAULT_INDEX_DIR, sessionId, store }) => {
  writeJsonlRows(summaryTargetsPath(root, sessionId), summaryTargetRows({
    sessionId,
    store: {
      ...emptySummaryTargets(sessionId),
      ...store,
      targets: store.targets || {}
    }
  }))
  unlinkIfExists(legacySummaryTargetsPath(root, sessionId))
}

const summaryOwnerId = () => `${process.pid}-${Date.now()}-${hashString(`${process.pid}:${Date.now()}:${Math.random()}`).slice(0, 10)}`

const ownerProcessIsAlive = ownerId => {
  const pid = Number(String(ownerId || '').split('-')[0])
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (_err) {
    return false
  }
}

const isClaimActive = (target, now = Date.now()) => {
  if (!target || target.status !== 'claimed') return false
  if (!ownerProcessIsAlive(target.ownerId)) return false
  const expiresAt = Date.parse(target.claimExpiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
}

const completedSummaryJobs = ({ root = DEFAULT_INDEX_DIR, sessionId }) => {
  const store = readSummaryTargets({ root, sessionId })
  return Object.values(store.targets || {})
    .filter(target => target.status === 'completed' && target.job)
    .map(target => target.job)
}

const reserveSummaryJobs = ({ root = DEFAULT_INDEX_DIR, sessionId, ownerId, claimTtlMs = DEFAULT_SUMMARY_CLAIM_TTL_MS }) => jobs => {
  return withFileLock(summaryTargetsLockPath(root, sessionId), () => {
    const store = readSummaryTargets({ root, sessionId })
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const claimExpiresAt = new Date(nowMs + claimTtlMs).toISOString()
    const claimedTargetIds = []
    const reusableJobs = []
    const skippedJobs = []
    for (const job of jobs || []) {
      if (!job.targetId) continue
      const current = store.targets[job.targetId]
      if (current && current.status === 'completed' && current.job) {
        reusableJobs.push(current.job)
        continue
      }
      if (isClaimActive(current, nowMs) && current.ownerId !== ownerId) {
        skippedJobs.push({
          ...job,
          status: 'claimed_elsewhere',
          ownerId: current.ownerId,
          claimExpiresAt: current.claimExpiresAt
        })
        continue
      }
      store.targets[job.targetId] = {
        targetId: job.targetId,
        targetMaterialHash: job.targetMaterialHash,
        status: 'claimed',
        ownerId,
        claimedAt: now,
        claimExpiresAt,
        updatedAt: now,
        job: {
          ...job,
          status: 'claimed',
          ownerId,
          claimExpiresAt
        }
      }
      claimedTargetIds.push(job.targetId)
    }
    writeSummaryTargets({ root, sessionId, store })
    return {
      claimedTargetIds,
      reusableJobs,
      skippedJobs
    }
  })
}

const commitSummaryJobs = ({ root = DEFAULT_INDEX_DIR, sessionId, ownerId, jobs }) => {
  return withFileLock(summaryTargetsLockPath(root, sessionId), () => {
    const store = readSummaryTargets({ root, sessionId })
    const now = new Date().toISOString()
    for (const job of jobs || []) {
      if (!job || !job.targetId) continue
      const current = store.targets[job.targetId]
      if (job.reused || job.status === 'claimed_elsewhere') continue
      if (current && current.ownerId && current.ownerId !== ownerId && isClaimActive(current)) continue
      if (job.error) {
        store.targets[job.targetId] = {
          ...(current || {}),
          targetId: job.targetId,
          targetMaterialHash: job.targetMaterialHash,
          status: 'error',
          ownerId,
          error: job.error,
          updatedAt: now,
          job: {
            ...job,
            status: 'error'
          }
        }
      } else if (job.status === 'completed' && job.summary) {
        store.targets[job.targetId] = {
          ...(current || {}),
          targetId: job.targetId,
          targetMaterialHash: job.targetMaterialHash,
          status: 'completed',
          ownerId,
          completedAt: job.completedAt || now,
          updatedAt: now,
          job: {
            ...job,
            status: 'completed',
            completedAt: job.completedAt || now
          }
        }
      }
    }
    writeSummaryTargets({ root, sessionId, store })
    return store
  })
}

const currentTargetIdsForSession = session => new Set(
  (session && (session.compactions || session.summaryIndex && session.summaryIndex.compactionLog) || [])
    .flatMap(compaction => compaction.targets || [])
    .map(target => target.targetId)
    .filter(Boolean)
)

const countTargets = (targets, nowMs) => {
  const activeClaims = targets.filter(target => isClaimActive(target, nowMs))
  return {
    targetCount: targets.length,
    completedTargetCount: targets.filter(target => target.status === 'completed').length,
    claimedTargetCount: activeClaims.length,
    staleClaimCount: targets.filter(target => target.status === 'claimed' && !isClaimActive(target, nowMs)).length,
    failedTargetCount: targets.filter(target => target.status === 'error').length
  }
}

const targetStoreSummary = ({ root = DEFAULT_INDEX_DIR, sessionId, currentTargetIds, now = new Date() }) => {
  const store = readSummaryTargets({ root, sessionId })
  const targets = Object.values(store.targets || {})
  const nowMs = now.getTime()
  const totals = countTargets(targets, nowMs)
  const currentSet = currentTargetIds && currentTargetIds.size ? currentTargetIds : null
  const currentTargets = currentSet ? targets.filter(target => currentSet.has(target.targetId)) : targets
  const currentTotals = countTargets(currentTargets, nowMs)
  return {
    schema: store.schema,
    updatedAt: store.updatedAt || null,
    updatedAgo: store.updatedAt ? formatAgo(store.updatedAt, now) : null,
    ...totals,
    currentTargetCount: currentSet ? currentSet.size : currentTotals.targetCount,
    currentStoredTargetCount: currentTotals.targetCount,
    currentStoredCompletedTargetCount: currentTotals.completedTargetCount,
    currentStoredClaimedTargetCount: currentTotals.claimedTargetCount,
    currentStoredStaleClaimCount: currentTotals.staleClaimCount,
    currentStoredFailedTargetCount: currentTotals.failedTargetCount,
    orphanStoredTargetCount: currentSet ? Math.max(0, targets.length - currentTargets.length) : 0
  }
}

const indexingStats = session => {
  const compactions = session.compactions || session.summaryIndex && session.summaryIndex.compactionLog || []
  const targetCount = compactions.reduce((sum, item) => sum + Number(item.targetCount || 0), 0)
  const completedTargetCount = compactions.reduce((sum, item) => sum + Number(item.completedTargetCount || 0), 0)
  const pendingTargetCount = compactions.reduce((sum, item) => sum + Number(item.pendingTargetCount || 0), 0)
  const failedTargetCount = compactions.reduce((sum, item) => sum + Number(item.failedTargetCount || 0), 0)
  const summaryUsage = session.summaryIndex && session.summaryIndex.usage
    ? {
        ...session.summaryIndex.usage,
        ...(session.summaryIndex.model ? { model: session.summaryIndex.model } : {})
      }
    : undefined
  return {
    compactionCount: compactions.length,
    indexedCompactionCount: compactions.filter(item => item.status === 'indexed' || item.status === 'summary_disabled').length,
    pendingCompactionCount: compactions.filter(item => item.status === 'pending' || item.status === 'partial').length,
    targetCount,
    completedTargetCount,
    pendingTargetCount,
    failedTargetCount,
    plannedSummaryInputTokens: Number(session.summaryIndex && session.summaryIndex.plannedInputTokenCount || 0),
    tokensSummarized: Number(session.summaryIndex && session.summaryIndex.completedInputTokenCount || 0),
    reusedJobCount: Number(session.summaryIndex && session.summaryIndex.reusedJobCount || 0),
    skippedJobCount: Number(session.summaryIndex && session.summaryIndex.skippedJobCount || 0),
    summaryUsage
  }
}

const publicIndexingStats = session => {
  const stats = { ...(session.indexingStats || indexingStats(session)) }
  delete stats.summaryUsageBasis
  const summaryUsage = stats.summaryUsage
    ? { ...stats.summaryUsage }
    : session.summaryIndex && session.summaryIndex.usage
      ? { ...session.summaryIndex.usage }
      : undefined
  if (summaryUsage && session.summaryIndex && session.summaryIndex.model) {
    summaryUsage.model = session.summaryIndex.model
  }
  if (summaryUsage) stats.summaryUsage = summaryUsage
  return stats
}

const sessionIndexReadiness = ({ root, sessionRecord }) => {
  const sourceUpdatedAt = sourceTimestamp(sessionRecord.sourcePath)
  const sourceTime = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : NaN
  const hasSource = Number.isFinite(sourceTime)
  const stats = publicIndexingStats(sessionRecord)
  const summaryTargetStore = targetStoreSummary({
    root,
    sessionId: sessionRecord.sessionId,
    currentTargetIds: currentTargetIdsForSession(sessionRecord)
  })
  const failed = failedSummaryWork({ stats, summaryTargetStore })
  const active = activeSummaryWork({ stats, summaryTargetStore })
  return {
    ready: hasSource && !failed && !active,
    hasSource,
    failed,
    active,
    pendingTargetCount: Number(stats.pendingTargetCount || 0),
    completedTargetCount: Number(stats.completedTargetCount || 0),
    claimedTargetCount: Number(summaryTargetStore.currentStoredClaimedTargetCount || 0),
    failedTargetCount: Number(stats.failedTargetCount || 0) + Number(summaryTargetStore.currentStoredFailedTargetCount || 0)
  }
}

const jobTime = job => {
  const time = Date.parse(job && (job.updatedAt || job.startedAt))
  return Number.isFinite(time) ? time : 0
}

const pathMatches = (left, right) => {
  if (!left || !right) return false
  try {
    return path.resolve(left) === path.resolve(right)
  } catch (_err) {
    return String(left) === String(right)
  }
}

const sessionIdFromSourcePath = sourcePath => {
  const match = String(sourcePath || '').match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match ? match[1] : null
}

const jobMatchesSession = ({ job, sessionId, sourcePath }) => {
  if (!job) return false
  if (job.scope === 'all') return true
  if (sourcePath && (job.sessions || []).some(file => pathMatches(file, sourcePath))) return true
  if (sessionId && (job.sessions || []).some(file => sessionIdFromSourcePath(file) === sessionId)) return true
  return Boolean(sessionId && (job.result && job.result.sessions || []).some(session => session.sessionId === sessionId))
}

const sessionJobs = ({ root, sessionId, sourcePath }) => listJobStates({ root })
  .filter(job => jobMatchesSession({ job, sessionId, sourcePath }))
  .map(job => ({
    publicJob: publicJobState(job),
    running: isPidRunning(job.pid),
    time: jobTime(job)
  }))
  .sort((a, b) => b.time - a.time)

const jobsAfterPublishedIndex = ({ jobs, indexedAt }) => {
  const indexedTime = Date.parse(indexedAt)
  if (!Number.isFinite(indexedTime)) return jobs
  return (jobs || []).filter(job => job.running || job.time >= indexedTime)
}

const activeSummaryWork = ({ stats, summaryTargetStore }) => {
  const currentPendingFromStore = Math.max(0, Number(summaryTargetStore.currentTargetCount || 0) -
    Number(summaryTargetStore.currentStoredCompletedTargetCount || 0) -
    Number(summaryTargetStore.currentStoredFailedTargetCount || 0))
  return Boolean(
    Number(stats.pendingTargetCount || 0) > 0 ||
    currentPendingFromStore > 0 ||
    Number(summaryTargetStore.claimedTargetCount || 0) > 0 ||
    Number(summaryTargetStore.currentStoredClaimedTargetCount || 0) > 0
  )
}

const failedSummaryWork = ({ stats, summaryTargetStore }) => Boolean(
  Number(stats.failedTargetCount || 0) > 0 ||
  Number(summaryTargetStore.failedTargetCount || 0) > 0 ||
  Number(summaryTargetStore.currentStoredFailedTargetCount || 0) > 0 ||
  Number(summaryTargetStore.staleClaimCount || 0) > 0 ||
  Number(summaryTargetStore.currentStoredStaleClaimCount || 0) > 0
)

const jobHasActiveSummaryWork = job => {
  const progress = job && job.progress || {}
  return Boolean(
    Number(progress.pendingTargetCount || 0) > 0 ||
    Number(progress.claimedTargetCount || 0) > 0
  )
}

const jobHasFailedSummaryWork = job => Number(job && job.progress && job.progress.failedTargetCount || 0) > 0

const jobHasActiveIndexingWork = job => Boolean(
  job &&
  job.status &&
  !['ready', 'stopped', 'error', 'stale', 'suspended'].includes(job.status)
)

const readPidFile = file => {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return null
  }
}

const diskEntry = dir => {
  try {
    return {
      path: dir,
      bytes: directorySizeBytes(dir)
    }
  } catch (err) {
    return {
      path: dir,
      bytes: null,
      error: err.message
    }
  }
}

const indexResourceUsage = ({ root }) => {
  const sessionsDir = path.join(root, 'sessions')
  const jobsDir = path.join(root, 'jobs')
  const typesenseRuntimeDir = path.join(root, 'typesense', 'runtime')
  const typesenseDataDir = path.join(typesenseRuntimeDir, 'data')
  const typesensePid = readPidFile(path.join(typesenseRuntimeDir, 'typesense.pid'))
  return {
    disk: {
      sessions: diskEntry(sessionsDir),
      jobs: diskEntry(jobsDir),
      typesenseData: diskEntry(typesenseDataDir)
    },
    typesense: {
      pid: typesensePid,
      resourceUsage: typesensePid ? processResourceUsage(typesensePid) : null
    }
  }
}

const inferredSourcePathForSession = ({ sessionId, jobs }) => {
  for (const item of jobs || []) {
    const job = item.publicJob || item
    const match = (job.sessions || []).find(file => sessionIdFromSourcePath(file) === sessionId)
    if (match) return match
  }
  return null
}

const statsFromTargetStore = summaryTargetStore => {
  const targetCount = Number(summaryTargetStore.currentTargetCount || summaryTargetStore.targetCount || 0)
  const completedTargetCount = Number(summaryTargetStore.currentStoredCompletedTargetCount || summaryTargetStore.completedTargetCount || 0)
  const failedTargetCount = Number(summaryTargetStore.currentStoredFailedTargetCount || summaryTargetStore.failedTargetCount || 0)
  return {
    compactionCount: 0,
    indexedCompactionCount: 0,
    pendingCompactionCount: targetCount ? 1 : 0,
    targetCount,
    completedTargetCount,
    pendingTargetCount: Math.max(0, targetCount - completedTargetCount - failedTargetCount),
    failedTargetCount,
    plannedSummaryInputTokens: 0,
    tokensSummarized: 0,
    reusedJobCount: 0,
    skippedJobCount: 0
  }
}

const operationalState = ({
  indexed,
  hasSource,
  stats,
  summaryTargetStore,
  jobs
}) => {
  const latestJob = jobs[0] || null
  const runningJob = jobs.find(job => job.running) || null
  const latestPublicJob = latestJob && latestJob.publicJob
  const runningPublicJob = runningJob && runningJob.publicJob
  if (latestPublicJob && latestPublicJob.status === 'suspended') {
    const suspension = latestPublicJob.suspension || {
      reason: latestPublicJob.suspendedReason || 'unknown',
      message: latestPublicJob.message || 'indexing is suspended'
    }
    return {
      state: suspension.reason === 'summary_budget' ? 'suspended-budget' : 'suspended',
      statusMessage: suspension.message || latestPublicJob.message || 'indexing is suspended',
      suspension,
      indexingJob: latestPublicJob
    }
  }
  if (latestPublicJob && latestPublicJob.status === 'error') {
    return {
      state: 'error',
      errorMessage: latestPublicJob.error || 'indexing job failed',
      indexingJob: latestPublicJob
    }
  }
  if (latestPublicJob && latestPublicJob.status === 'stale') {
    return {
      state: 'error',
      errorMessage: 'indexing job is no longer running',
      indexingJob: latestPublicJob
    }
  }
  if (failedSummaryWork({ stats, summaryTargetStore })) {
    return {
      state: 'error',
      errorMessage: 'summary indexing has failed or stale work claims',
      indexingJob: runningPublicJob || latestPublicJob
    }
  }
  if (jobHasFailedSummaryWork(runningPublicJob || latestPublicJob)) {
    return {
      state: 'error',
      errorMessage: 'summary indexing has failed',
      indexingJob: runningPublicJob || latestPublicJob
    }
  }
  if (!runningJob) {
    return {
      state: 'not-started',
      indexingJob: latestPublicJob
    }
  }
  if (!indexed) {
    return {
      state: 'indexing-in-progress',
      indexingJob: runningPublicJob
    }
  }
  if (!hasSource) {
    return {
      state: 'error',
      errorMessage: 'source session file is missing',
      indexingJob: runningPublicJob
    }
  }
  if (activeSummaryWork({ stats, summaryTargetStore }) || jobHasActiveSummaryWork(runningPublicJob)) {
    return {
      state: 'indexing-in-progress',
      indexingJob: runningPublicJob
    }
  }
  if (jobHasActiveIndexingWork(runningPublicJob)) {
    return {
      state: 'indexing-in-progress',
      indexingJob: runningPublicJob
    }
  }
  return {
    state: 'ready',
    indexingJob: runningPublicJob
  }
}

const sourceTimestamp = sourcePath => {
  if (!sourcePath) return null
  try {
    return fs.statSync(sourcePath).mtime.toISOString()
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return null
  }
}

const sessionIndexStatus = ({
  root = DEFAULT_INDEX_DIR,
  sessionId,
  now = new Date()
}) => {
  const manifest = readManifest(root)
  const session = manifest.sessions && manifest.sessions[sessionId]
  const allJobs = sessionJobs({
    root,
    sessionId,
    sourcePath: session && session.sourcePath
  })
  const jobs = session
    ? jobsAfterPublishedIndex({ jobs: allJobs, indexedAt: session.indexedAt })
    : allJobs
  if (!session) {
    const sourcePath = inferredSourcePathForSession({ sessionId, jobs })
    const sourceUpdatedAt = sourceTimestamp(sourcePath)
    const hasSource = Boolean(sourceUpdatedAt)
    const summaryTargetStore = targetStoreSummary({
      root,
      sessionId,
      now
    })
    const stats = statsFromTargetStore(summaryTargetStore)
    if (!jobs.length && !summaryTargetStore.targetCount) return null
    const op = operationalState({
      indexed: false,
      hasSource,
      stats,
      summaryTargetStore,
      jobs
    })
    return {
      sessionId,
      indexId: sessionId,
      indexed: false,
      state: op.state,
      ...(op.errorMessage ? { errorMessage: op.errorMessage } : {}),
      ...(op.statusMessage ? { statusMessage: op.statusMessage } : {}),
      ...(op.suspension ? { suspension: op.suspension } : {}),
      ...(op.indexingJob ? { indexingJob: op.indexingJob } : {}),
      indexedAt: null,
      indexedAgo: null,
      sourcePath,
      indexingStats: stats,
      summaryTargetStore,
    }
  }
  const sourceUpdatedAt = sourceTimestamp(session.sourcePath)
  const sourceTime = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : NaN
  const hasSource = Number.isFinite(sourceTime)
  const stats = publicIndexingStats(session)
  const summaryTargetStore = targetStoreSummary({
    root,
    sessionId,
    currentTargetIds: currentTargetIdsForSession(session),
    now
  })
  const op = operationalState({
    indexed: true,
    hasSource,
    stats,
    summaryTargetStore,
    jobs
  })
  return {
    sessionId,
    indexId: session.indexId || session.sessionId,
    title: session.title,
    indexed: true,
    state: op.state,
    ...(op.errorMessage ? { errorMessage: op.errorMessage } : {}),
    ...(op.statusMessage ? { statusMessage: op.statusMessage } : {}),
    ...(op.suspension ? { suspension: op.suspension } : {}),
    ...(op.indexingJob ? { indexingJob: op.indexingJob } : {}),
    indexedAt: session.indexedAt || null,
    indexedAgo: session.indexedAt ? formatAgo(session.indexedAt, now) : null,
    sourcePath: session.sourcePath,
    eventCount: session.eventCount,
    docCount: session.docCount,
    indexingStats: stats,
    summaryTargetStore
  }
}

const sessionSortTime = session => {
  const time = Date.parse(session && (session.indexedAt || session.updatedAt))
  return Number.isFinite(time) ? time : 0
}

const sessionCatalogSortTime = session => {
  const time = Date.parse(session && (session.updatedAt || session.indexedAt))
  return Number.isFinite(time) ? time : 0
}

const turnCountForIR = ir => (ir.events || [])
  .filter(event => event && event.type === 'message' && event.role === 'user')
  .length

const sessionSummaryText = session => preview(
  session.shortSummary ||
  session.summary ||
  session.summaryIndex && (session.summaryIndex.summary || session.summaryIndex.description) ||
  session.title ||
  session.sessionId,
  180
)

const compactCatalogEntry = (session, now) => {
  const stats = publicIndexingStats(session)
  const indexId = session.indexId || session.sessionId
  const updatedAt = session.updatedAt || session.indexedAt || null
  const entry = {
    session_id: session.sessionId,
    index_id: indexId,
    agent: session.agent,
    title: preview(session.title || session.sessionId, 120),
    short_summary: sessionSummaryText(session),
    last_modified_at: updatedAt,
    last_modified_ago: updatedAt ? formatAgo(updatedAt, now) : null,
    indexed_at: session.indexedAt || null,
    source_kind: session.sourceKind,
    turn_count: Number.isFinite(Number(session.turnCount)) ? Number(session.turnCount) : undefined,
    event_count: Number.isFinite(Number(session.eventCount)) ? Number(session.eventCount) : undefined,
    doc_count: Number.isFinite(Number(session.docCount)) ? Number(session.docCount) : undefined,
    full_token_count: Number.isFinite(Number(session.fullTokenCount)) ? Number(session.fullTokenCount) : undefined,
    usage_total_tokens: session.usage && Number.isFinite(Number(session.usage.total)) ? Number(session.usage.total) : undefined,
    compaction_count: Number(stats.compactionCount || 0),
    indexed_compaction_count: Number(stats.indexedCompactionCount || 0),
    pending_compaction_count: Number(stats.pendingCompactionCount || 0),
    browse: {
      index_id: indexId,
      topic_id: 'root'
    }
  }
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined || entry[key] === null || entry[key] === '') delete entry[key]
  }
  return entry
}

const catalogSearchText = entry => [
  entry.session_id,
  entry.index_id,
  entry.agent,
  entry.title,
  entry.short_summary,
  entry.source_kind
].filter(Boolean).join('\n').toLowerCase()

const browseSessionCatalog = ({
  root = DEFAULT_INDEX_DIR,
  startAt = 0,
  start,
  limit = 20,
  agent,
  query
} = {}) => {
  const manifest = readManifest(root)
  const now = new Date()
  const offset = start === undefined ? startAt : start
  const normalizedQuery = String(query || '').trim().toLowerCase()
  const sessions = Object.values(manifest.sessions || {})
    .filter(session => session && session.sessionId)
    .sort((a, b) => sessionCatalogSortTime(b) - sessionCatalogSortTime(a) || String(a.sessionId).localeCompare(String(b.sessionId)))
    .map(session => compactCatalogEntry(session, now))
    .filter(entry => !agent || entry.agent === agent)
    .filter(entry => !normalizedQuery || catalogSearchText(entry).includes(normalizedQuery))
  const pageSessions = sessions.slice(offset, offset + limit)
  return {
    level: 'sessions',
    checked_at: now.toISOString(),
    page: {
      start: offset,
      limit,
      returned: pageSessions.length,
      total: sessions.length,
      ...(offset + limit < sessions.length ? { next_start: offset + limit } : {})
    },
    sessions: pageSessions
  }
}

const activeUnindexedSessionIds = ({ root, indexedIds }) => {
  const out = new Set()
  for (const state of listJobStates({ root })) {
    if (!isPidRunning(state.pid) && !['starting', 'indexing', 'suspended'].includes(state.status)) continue
    for (const file of state.sessions || []) {
      const sessionId = sessionIdFromSourcePath(file)
      if (sessionId && !indexedIds.has(sessionId)) out.add(sessionId)
    }
  }
  return [...out]
}

const indexStatus = ({ root = DEFAULT_INDEX_DIR, sessionId, startAt = 0, limit = 10 } = {}) => {
  const manifest = readManifest(root)
  const now = new Date()
  const indexedSessions = Object.values(manifest.sessions || {})
    .filter(session => session && session.sessionId)
    .sort((a, b) => sessionSortTime(b) - sessionSortTime(a) || String(a.sessionId).localeCompare(String(b.sessionId)))
  const indexedIds = new Set(indexedSessions.map(session => session.sessionId))
  if (sessionId) {
    const session = sessionIndexStatus({
      root,
      sessionId,
      now
    })
    return {
      checkedAt: now.toISOString(),
      startAt,
      limit,
      resourceUsage: indexResourceUsage({ root }),
      sessions: session ? [session] : []
    }
  }
  const unindexedSessionIds = activeUnindexedSessionIds({ root, indexedIds })
  const matchingSessions = sessionId
    ? indexedSessions.filter(session => session.sessionId === sessionId)
    : indexedSessions
  const indexedStatuses = matchingSessions.map(session => sessionIndexStatus({
    root,
    sessionId: session.sessionId,
    now
  }))
  const unindexedStatuses = unindexedSessionIds.map(id => sessionIndexStatus({
    root,
    sessionId: id,
    now
  }))
  const page = [...unindexedStatuses, ...indexedStatuses].slice(startAt, startAt + limit)
  return {
    checkedAt: now.toISOString(),
    startAt,
    limit,
    resourceUsage: indexResourceUsage({ root }),
    sessions: page
  }
}

const writeManifest = (root, manifest) => writeJson(manifestPath(root), manifest)

const summaryIndexForManifest = summaryIndex => {
  if (!summaryIndex) return summaryIndex
  const { compactionLog: _compactionLog, ...rest } = summaryIndex
  return rest
}

const sessionRecordForManifest = sessionRecord => {
  const out = {
    ...sessionRecord,
    summaryIndex: summaryIndexForManifest(sessionRecord.summaryIndex)
  }
  delete out.summaryJobs
  delete out.compactions
  if (out.summaryIndex === undefined) delete out.summaryIndex
  return out
}

function * sessionIRRows (ir) {
  yield {
    recordType: 'session_ir_header',
    schema: ir.schema,
    storage: 'source-pointer',
    indexId: ir.indexId,
    source: ir.source,
    session: {
      ...ir.session,
      usage: undefined
    }
  }
}

const writeSessionIR = ({ root = DEFAULT_INDEX_DIR, ir }) => {
  writeJsonlRows(irPath(root, ir.session.id), sessionIRRows(ir))
  unlinkIfExists(legacyIrPath(root, ir.session.id))
}

const readSessionIRJsonl = file => {
  let header = null
  const events = []
  for (const row of readJsonlRows(file)) {
    if (row.parseError) {
      throw new Error(`invalid IR JSONL at ${file}:${row.lineNumber}: ${row.parseError}`)
    }
    const record = row.json || {}
    if (record.recordType === 'session_ir_header') {
      header = record
    } else if (record.recordType === 'session_ir_event') {
      events.push(record.event)
    }
  }
  if (!header) throw new Error(`missing IR JSONL header: ${file}`)
  return {
    schema: header.schema,
    indexId: header.indexId || header.index_id,
    source: header.source || {},
    session: header.session || {},
    events
  }
}

const adapterNameForSourceKind = kind => {
  const text = String(kind || '').toLowerCase()
  if (text.startsWith('codex')) return 'codex'
  if (text.startsWith('claude')) return 'claude'
  return text
}

const rehydrateSourceIR = ({ stored }) => {
  const source = stored && stored.source || {}
  if (!source.path) return stored
  if (stored && stored.events && stored.events.length) return stored
  const adapter = adapterFor(adapterNameForSourceKind(source.kind))
  const ir = adapter.importFile(source.path)
  if (stored && stored.session && stored.session.id && ir.session.id !== stored.session.id) {
    throw new Error(`source session id changed for ${source.path}: expected ${stored.session.id}, got ${ir.session.id}`)
  }
  const indexId = stored && (stored.indexId || stored.index_id || stored.session && (stored.session.indexId || stored.session.index_id))
  if (indexId) ir.indexId = String(indexId)
  return ir
}

const unlinkIfExists = file => {
  try {
    fs.unlinkSync(file)
    return true
  } catch (err) {
    if (err && err.code === 'ENOENT') return false
    if (err && (err.code === 'EISDIR' || err.code === 'EPERM')) {
      fs.rmSync(file, { recursive: true, force: true })
      return true
    }
    throw err
  }
}

const resetSessionIndex = ({
  root = DEFAULT_INDEX_DIR,
  sessionId
}) => {
  if (!sessionId) throw new Error('resetSessionIndex requires sessionId')
  const removedFiles = []
  let removedJobArtifacts = []
  let removedSession = null
  const remove = file => {
    if (unlinkIfExists(file)) removedFiles.push(file)
  }
  withFileLock(manifestLockPath(root), () => {
    const manifest = readManifest(root)
    let sourcePath = null
    if (manifest.sessions && manifest.sessions[sessionId]) {
      const record = manifest.sessions[sessionId]
      sourcePath = record.sourcePath || null
      removedSession = {
        sessionId: record.sessionId,
        agent: record.agent,
        title: record.title,
        sourcePath: record.sourcePath,
        indexedAt: record.indexedAt,
        eventCount: record.eventCount,
        docCount: record.docCount
      }
      delete manifest.sessions[sessionId]
    }
    removedJobArtifacts = removeJobArtifactsForSession({ root, sessionId, sourcePath })
    remove(irPath(root, sessionId))
    remove(legacyIrPath(root, sessionId))
    remove(treePath(root, sessionId))
    remove(docStorePath(root, sessionId))
    remove(summaryTargetsPath(root, sessionId))
    remove(legacySummaryTargetsPath(root, sessionId))
    remove(summaryTargetsLockPath(root, sessionId))
    manifest.updatedAt = new Date().toISOString()
    writeManifest(root, manifest)
  })
  return {
    sessionId,
    removedFromManifest: Boolean(removedSession),
    ...(removedSession ? { removedSession } : {}),
    ...(removedJobArtifacts.length ? { removedJobArtifacts } : {}),
    removedFiles
  }
}

const resetSessionIndexWithBackend = async ({
  root = DEFAULT_INDEX_DIR,
  sessionId,
  agent,
  searchBackend = DEFAULT_SEARCH_BACKEND,
  ...backendOpts
}) => {
  if (searchBackend !== 'typesense') throw new Error('--search-backend must be typesense')
  const typeOpts = { root, indexDir: root, ...backendOpts }
  const manifest = readManifest(root)
  const manifestAgent = manifest.sessions && manifest.sessions[sessionId] && manifest.sessions[sessionId].agent
  const result = await deleteSessionDocuments({
    sessionId,
    agent: agent || manifestAgent || undefined,
    ...typeOpts
  })
  const local = resetSessionIndex({ root, sessionId })
  const config = await resolveTypesenseConfig(typeOpts)
  return {
    ...local,
    serverIndex: {
      backend: searchBackend,
      status: 'ready',
      result,
      config: {
        ...config,
        apiKey: backendOpts.typesenseApiKey ? 'set' : config.apiKey ? 'default' : 'unset'
      }
    }
  }
}

const writeSessionIndex = ({ root = DEFAULT_INDEX_DIR, ir }) => {
  ir.indexId = indexIdForIR(ir)
  const tree = buildMipTree(ir)
  applyCompactionSearchScope(tree)
  const docs = collectIndexDocuments(tree)
  const now = new Date().toISOString()
  const sessionRecord = {
    sessionId: ir.session.id,
    indexId: ir.indexId,
    title: ir.session.title,
    agent: ir.session.agent,
    sourceKind: ir.source.kind,
    sourcePath: ir.source.path,
    sourceFingerprint: ir.source.fingerprint,
    updatedAt: ir.session.updatedAt,
    indexedAt: now,
    eventCount: ir.events.length,
    turnCount: turnCountForIR(ir),
    docCount: docs.length,
    rootHandle: tree.root.handle,
    shortSummary: preview(tree.root.head || ir.session.title || ir.session.id, 180),
    fullTokenCount: tree.root.fullTokenCount,
    usage: tree.root.usage
  }
  sessionRecord.indexingStats = indexingStats(sessionRecord)
  withFileLock(manifestLockPath(root), () => {
    const manifest = readManifest(root)
    manifest.updatedAt = now
    manifest.sessions[ir.session.id] = sessionRecordForManifest(sessionRecord)
    writeSessionDocs({ root, sessionId: ir.session.id, docs })
    writeSessionIR({ root, ir })
    unlinkIfExists(treePath(root, ir.session.id))
    writeManifest(root, manifest)
  })
  return {
    sessionId: ir.session.id,
    indexId: ir.indexId,
    title: ir.session.title,
    sourcePath: ir.source.path,
    sourceFingerprint: ir.source.fingerprint,
    eventCount: ir.events.length,
    turnCount: turnCountForIR(ir),
    docCount: docs.length,
    rootHandle: tree.root.handle,
    shortSummary: preview(tree.root.head || ir.session.title || ir.session.id, 180),
    fullTokenCount: tree.root.fullTokenCount,
    usage: tree.root.usage,
    readiness: sessionIndexReadiness({ root, sessionRecord })
  }
}

const collectPublishedDocuments = ({ tree, sourceTree }) => {
  const docsById = new Map()
  for (const doc of collectIndexDocuments(tree)) docsById.set(doc.id, doc)
  const visibleHandles = compactedRetrievalHandles(sourceTree)
  for (const doc of collectIndexDocuments(sourceTree, {
    retrievalVisible: node => visibleHandles.has(node.handle)
  })) {
    if (!docsById.has(doc.id)) docsById.set(doc.id, doc)
  }
  return [...docsById.values()]
}

const writeSessionIndexWithBackend = async ({
  root = DEFAULT_INDEX_DIR,
  ir,
  searchBackend = DEFAULT_SEARCH_BACKEND,
  summaryMode = DEFAULT_SUMMARY_MODE,
  summaryProvider,
  summaryModel,
  maxSummaryNodes,
  maxSummaryChildChars,
  summaryInputTokenBudget,
  codexHome,
  summaryRegion,
  bedrockCwd,
  summaryMaxOutputTokens,
  summaryMaxBudgetUsd,
  summaryConcurrency,
  summaryRateLimitMaxRetries,
  summaryRateLimitBackoffMs,
  summaryRateLimitMaxBackoffMs,
  pricingCacheDir,
  summaryBatchId,
  summaryBatchTimeoutMs,
  summaryBatchPollMs,
  anthropicAwsWorkspaceId,
  awsProfile,
  summaryBudgetBaselineTargetIds,
  onProgress,
  ...backendOpts
}) => {
  if (searchBackend !== 'typesense') throw new Error('--search-backend must be typesense')
  ir.indexId = indexIdForIR(ir)
  const ownerId = summaryOwnerId()
  const previousSummaryJobs = completedSummaryJobs({ root, sessionId: ir.session.id })
  const sourceTree = buildMipTree(ir)
  const tree = summaryBatchId
    ? readSessionTree({ root, sessionId: ir.session.id, fallbackIR: ir })
    : buildMipTree(ir)
  const summaryIndex = await summarizeTree(tree, {
    summaryMode,
    summaryProvider,
    summaryModel,
    maxSummaryNodes,
    maxSummaryChildChars,
    summaryInputTokenBudget,
    codexHome,
    summaryRegion,
    bedrockCwd,
    summaryMaxOutputTokens,
    summaryMaxBudgetUsd,
    summaryConcurrency,
    summaryRateLimitMaxRetries,
    summaryRateLimitBackoffMs,
    summaryRateLimitMaxBackoffMs,
    pricingCacheDir,
    summaryBatchId,
    summaryBatchTimeoutMs,
    summaryBatchPollMs,
    anthropicAwsWorkspaceId,
    awsProfile,
    summaryBudgetBaselineTargetIds: summaryBudgetBaselineTargetIds || previousSummaryJobs.map(job => job.targetId).filter(Boolean),
    previousSummaryJobs,
    onProgress,
    reserveSummaryJobs: reserveSummaryJobs({
      root,
      sessionId: ir.session.id,
      ownerId
    })
  })
  if (typeof onProgress === 'function') {
    onProgress({
      phase: 'summary:commit',
      sessionId: ir.session.id,
      jobCount: summaryIndex.jobs.length
    })
  }
  commitSummaryJobs({
    root,
    sessionId: ir.session.id,
    ownerId,
    jobs: summaryIndex.jobs
  })
  if (summaryMode === 'model') {
    applyStoredSummaryJobs(tree, completedSummaryJobs({ root, sessionId: ir.session.id }))
  }
  const now = new Date().toISOString()
  const serverIndex = {
    backend: searchBackend,
    status: 'not_requested'
  }
  const typeOpts = { root, indexDir: root, ...backendOpts }
  const sessionRecord = {
    sessionId: ir.session.id,
    indexId: ir.indexId,
    title: ir.session.title,
    agent: ir.session.agent,
    sourceKind: ir.source.kind,
    sourcePath: ir.source.path,
    sourceFingerprint: ir.source.fingerprint,
    updatedAt: ir.session.updatedAt,
    indexedAt: now,
    eventCount: ir.events.length,
    turnCount: turnCountForIR(ir),
    docCount: 0,
    rootHandle: tree.root.handle,
    shortSummary: preview(tree.root.head || ir.session.title || ir.session.id, 180),
    fullTokenCount: tree.root.fullTokenCount,
    usage: tree.root.usage,
    summaryIndex: summaryIndex.summary,
    summaryJobs: summaryIndex.jobs,
    compactions: summaryIndex.summary && summaryIndex.summary.compactionLog || [],
    serverIndex
  }
  sessionRecord.indexingStats = indexingStats(sessionRecord)
  const docs = collectPublishedDocuments({ tree, sourceTree })
  sessionRecord.docCount = docs.length
  if (typeof onProgress === 'function') {
    onProgress({
      phase: 'index:documents',
      sessionId: ir.session.id,
      docCount: docs.length
    })
  }
  writeSessionDocs({ root, sessionId: ir.session.id, docs })
  const result = await importDocuments({
    docs,
    sessionId: ir.session.id,
    agent: ir.session.agent,
    onProgress,
    ...typeOpts
  })
  serverIndex.status = 'ready'
  serverIndex.result = result
  const config = await resolveTypesenseConfig(typeOpts)
  serverIndex.config = {
    ...config,
    apiKey: backendOpts.typesenseApiKey ? 'set' : config.apiKey ? 'default' : 'unset'
  }
  sessionRecord.indexedAt = now

  withFileLock(manifestLockPath(root), () => {
    const latestJobs = summaryMode === 'model'
      ? completedSummaryJobs({ root, sessionId: ir.session.id })
      : []
    if (latestJobs.length) applyStoredSummaryJobs(tree, latestJobs)
    sessionRecord.summaryJobs = summaryIndex.jobs
    sessionRecord.indexingStats = indexingStats(sessionRecord)
    const manifest = readManifest(root)
    manifest.updatedAt = now
    manifest.sessions[ir.session.id] = sessionRecordForManifest(sessionRecord)
    writeSessionIR({ root, ir })
    unlinkIfExists(treePath(root, ir.session.id))
    writeManifest(root, manifest)
  })
  return {
    sessionId: ir.session.id,
    indexId: ir.indexId,
    title: ir.session.title,
    sourcePath: ir.source.path,
    sourceFingerprint: ir.source.fingerprint,
    eventCount: ir.events.length,
    turnCount: turnCountForIR(ir),
    docCount: sessionRecord.docCount,
    rootHandle: tree.root.handle,
    shortSummary: sessionRecord.shortSummary,
    fullTokenCount: tree.root.fullTokenCount,
    usage: tree.root.usage,
    summaryIndex: summaryIndex.summary,
    summaryJobs: summaryIndex.jobs,
    compactions: sessionRecord.compactions,
    indexingStats: sessionRecord.indexingStats,
    serverIndex
  }
}

const readSessionIR = ({ root = DEFAULT_INDEX_DIR, sessionId }) => {
  const jsonl = irPath(root, sessionId)
  if (fs.existsSync(jsonl)) return rehydrateSourceIR({ stored: readSessionIRJsonl(jsonl) })
  const legacy = readJson(legacyIrPath(root, sessionId))
  return rehydrateSourceIR({ stored: legacy })
}

const readSessionTree = ({ root = DEFAULT_INDEX_DIR, sessionId, fallbackIR }) => {
  const ir = fallbackIR || readSessionIR({ root, sessionId })
  const tree = buildMipTree(ir)
  const jobs = completedSummaryJobs({ root, sessionId })
  if (jobs.length) {
    prepareCompactedSummaryLayer(tree, {
      previousSummaryJobs: jobs,
      summaryInputTokenBudget: jobs.reduce((budget, job) => {
        const value = Number(job && job.inputTokenBudget || 0)
        return value > budget ? value : budget
      }, 0) || undefined
    })
    applyStoredSummaryJobs(tree, jobs)
  } else {
    applyCompactionSearchScope(tree)
  }
  return tree
}

const hydrateModelRef = ({ root = DEFAULT_INDEX_DIR, ref, treeCache }) => {
  if (!ref || typeof ref !== 'object') return ref
  const sessionId = ref._sessionId || ref.sessionId || ref.session_id
  const handle = ref.handle
  const out = { ...ref }
  delete out._sessionId
  delete out.sessionId
  delete out.session_id
  if (!sessionId || !handle) return out
  try {
    let tree = treeCache && treeCache.get(sessionId)
    if (!tree) {
      tree = readSessionTree({ root, sessionId })
      if (treeCache) treeCache.set(sessionId, tree)
    }
    const node = tree && tree.byHandle && tree.byHandle.get(handle)
    const text = modelTextForNode(node)
    if (text) out.text = text
    const source = nodeSourceFields(node)
    if (!out.line && source.sourceLineNumber) out.line = source.sourceLineNumber
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && !/unknown source adapter/i.test(err.message || ''))) throw err
  }
  return out
}

const hydrateModelRefs = ({ root = DEFAULT_INDEX_DIR, value, treeCache = new Map() }) => {
  if (Array.isArray(value)) {
    return value.map(item => hydrateModelRefs({ root, value: item, treeCache }))
  }
  if (!value || typeof value !== 'object') return value
  const own = hydrateModelRef({ root, ref: value, treeCache })
  if (Array.isArray(own.children)) {
    own.children = own.children.map(child => hydrateModelRefs({ root, value: child, treeCache }))
  }
  if (Array.isArray(own.hits)) {
    own.hits = own.hits.map(hit => hydrateModelRefs({ root, value: hit, treeCache }))
  }
  return own
}

const browseIndexWithBackend = async ({
  indexId,
  sessionId,
  agent,
  handle,
  topicId,
  zoom,
  start,
  startAt,
  limit,
  topic,
  searchBackend = DEFAULT_SEARCH_BACKEND,
  ...backendOpts
}) => {
  if (searchBackend !== 'typesense') throw new Error('--search-backend must be typesense')
  const result = await browseTypesense({
    indexId,
    sessionId,
    agent,
    handle,
    topicId,
    zoom,
    start,
    startAt,
    limit,
    topic,
    root: backendOpts.root,
    indexDir: backendOpts.indexDir,
    ...backendOpts
  })
  const root = backendOpts.root || backendOpts.indexDir || DEFAULT_INDEX_DIR
  const config = await resolveTypesenseConfig(backendOpts)
  return {
    backend: {
      requested: searchBackend,
      selected: 'typesense',
      status: 'ready',
      config: {
        ...config,
        apiKey: backendOpts.typesenseApiKey ? 'set' : config.apiKey ? 'default' : 'unset'
      }
    },
    result: hydrateModelRefs({ root, value: result })
  }
}

const openLinkWithBackend = async ({
  link,
  indexId,
  sessionId,
  agent,
  budgetTokens,
  searchBackend = DEFAULT_SEARCH_BACKEND,
  ...backendOpts
}) => {
  if (searchBackend !== 'typesense') throw new Error('--search-backend must be typesense')
  const parsed = parseSessionLink(link)
  if (!parsed || !parsed.handle) throw new Error(`Unsupported conversation_history link: ${link}`)
  const root = backendOpts.root || backendOpts.indexDir || DEFAULT_INDEX_DIR
  const result = await openLinkTypesense({
    link,
    indexId: indexId || parsed.indexId,
    sessionId: sessionId || parsed.sessionId,
    agent,
    budgetTokens,
    root,
    indexDir: root,
    ...backendOpts
  })
  const config = await resolveTypesenseConfig(backendOpts)
  return {
    backend: {
      requested: searchBackend,
      selected: 'typesense',
      status: 'ready',
      config: {
        ...config,
        apiKey: backendOpts.typesenseApiKey ? 'set' : config.apiKey ? 'default' : 'unset'
      }
    },
    result
  }
}

const searchIndexWithBackend = async ({
  query,
  indexId,
  sessionId,
  agent,
  within,
  topic,
  filter,
  startAt,
  limit,
  searchBackend = DEFAULT_SEARCH_BACKEND,
  ...backendOpts
}) => {
  if (searchBackend !== 'typesense') throw new Error('--search-backend must be typesense')
  const search = () => searchTypesense({
    query,
    indexId,
    sessionId,
    agent,
    within,
    topic,
    filter,
    startAt,
    limit,
    root: backendOpts.root,
    indexDir: backendOpts.indexDir,
    ...backendOpts
  })
  const hits = await search()
  return {
    hits: hydrateModelRefs({
      root: backendOpts.root || backendOpts.indexDir || DEFAULT_INDEX_DIR,
      value: hits
    })
  }
}

module.exports = {
  DEFAULT_INDEX_DIR,
  DEFAULT_SEARCH_BACKEND,
  DEFAULT_SUMMARY_MODE,
  browseSessionCatalog,
  commitSummaryJobs,
  completedSummaryJobs,
  browseIndexWithBackend,
  indexStatus,
  openLinkWithBackend,
  readManifest,
  readSessionIR,
  readSessionTree,
  reserveSummaryJobs,
  resetSessionIndex,
  resetSessionIndexWithBackend,
  searchIndexWithBackend,
  sessionIndexStatus,
  writeSessionIndex,
  writeSessionIndexWithBackend
}
