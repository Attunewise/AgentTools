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
  withAsyncFileLock,
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
  navigationTextForNode,
  nodeSourceFields,
  parseSessionLink
} = require('./mip.js')
const { adapterFor } = require('./adapters/index.js')
const { parseTopicId } = require('./topics.js')
const {
  docStorePath,
  writeSessionDocs
} = require('./docStore.js')
const {
  DEFAULT_SUMMARY_MODE,
  applyStoredSummaryJobs,
  jobAccounting,
  prepareCompactedSummaryLayer,
  summarizeTree
} = require('./summarizer.js')
const {
  browseTypesense,
  deleteSessionDocuments,
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
const sessionIndexLockPath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.index.lock`)
const sessionGenerationPath = (root, sessionId) => path.join(root, 'sessions', `${sessionId}.generation.json`)
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

const readSessionGeneration = ({ root, sessionId }) => {
  try {
    return Math.max(0, Number(readJson(sessionGenerationPath(root, sessionId)).generation || 0))
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
    return 0
  }
}

const bumpSessionGeneration = ({ root, sessionId }) => {
  const generation = readSessionGeneration({ root, sessionId }) + 1
  writeJson(sessionGenerationPath(root, sessionId), {
    schema: 'conversation-history.session-generation.v1',
    sessionId,
    generation,
    updatedAt: new Date().toISOString()
  })
  return generation
}

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

const targetIdsFromCompactions = compactions => new Set(
  (compactions || [])
    .flatMap(compaction => compaction.targets || [])
    .map(target => target.targetId)
    .filter(Boolean)
)

const currentTargetIdsForSession = session => {
  if (!session) return null
  // Field presence establishes a published scope; an empty set means every stored target is orphaned.
  if (Array.isArray(session.summaryTargetIds)) {
    return new Set(session.summaryTargetIds.filter(Boolean))
  }
  if (Array.isArray(session.compactions)) {
    return targetIdsFromCompactions(session.compactions)
  }
  if (session.summaryIndex && Array.isArray(session.summaryIndex.compactionLog)) {
    return targetIdsFromCompactions(session.summaryIndex.compactionLog)
  }
  return null
}

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
  const currentSet = currentTargetIds instanceof Set ? currentTargetIds : null
  const currentTargets = currentSet ? targets.filter(target => currentSet.has(target.targetId)) : targets
  const currentTotals = countTargets(currentTargets, nowMs)
  return {
    schema: store.schema,
    updatedAt: store.updatedAt || null,
    updatedAgo: store.updatedAt ? formatAgo(store.updatedAt, now) : null,
    ...totals,
    currentTargetScope: Boolean(currentSet),
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

const refreshedCompactionAccounting = ({ compactions, jobs }) => {
  const byTarget = new Map((jobs || [])
    .filter(job => job && job.targetId)
    .map(job => [job.targetId, job]))
  return (compactions || []).map(compaction => {
    const targets = (compaction.targets || []).map(target => {
      const job = byTarget.get(target && target.targetId)
      if (!job) return target
      const status = job.error
        ? 'error'
        : job.status === 'completed' || job.resultType === 'succeeded' || job.resultType === 'reused'
          ? 'completed'
          : job.status || target.status
      return { ...target, status }
    })
    const completedTargetCount = targets.filter(target => target.status === 'completed').length
    const failedTargetCount = targets.filter(target => target.status === 'error').length
    const pendingTargetCount = Math.max(0, targets.length - completedTargetCount - failedTargetCount)
    return {
      ...compaction,
      targets,
      targetCount: targets.length,
      completedTargetCount,
      pendingTargetCount,
      failedTargetCount,
      status: !targets.length
        ? 'empty'
        : failedTargetCount
          ? 'error'
          : completedTargetCount === targets.length
            ? 'indexed'
            : completedTargetCount
              ? 'partial'
              : 'pending'
    }
  })
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

const currentDerivationReadiness = ({ root, sessionRecord }) => {
  const sourceUpdatedAt = sourceTimestamp(sessionRecord.sourcePath)
  const hasSource = Boolean(sourceUpdatedAt)
  const stats = publicIndexingStats(sessionRecord)
  const currentTargetIds = currentTargetIdsForSession(sessionRecord)
  const summaryTargetStore = currentTargetIds
    ? targetStoreSummary({
        root,
        sessionId: sessionRecord.sessionId,
        currentTargetIds
      })
    : null
  const storedPendingTargetCount = summaryTargetStore
    ? Math.max(0,
        Number(summaryTargetStore.currentTargetCount || 0) -
        Number(summaryTargetStore.currentStoredCompletedTargetCount || 0) -
        Number(summaryTargetStore.currentStoredFailedTargetCount || 0))
    : 0
  const pendingTargetCount = summaryTargetStore
    ? storedPendingTargetCount
    : Number(stats.pendingTargetCount || 0)
  const claimedTargetCount = Number(summaryTargetStore && summaryTargetStore.currentStoredClaimedTargetCount || 0)
  const failedTargetCount = summaryTargetStore
    ? Number(summaryTargetStore.currentStoredFailedTargetCount || 0) +
      Number(summaryTargetStore.currentStoredStaleClaimCount || 0)
    : Number(stats.failedTargetCount || 0)
  const active = pendingTargetCount > 0 || claimedTargetCount > 0
  const failed = failedTargetCount > 0
  return {
    ready: hasSource && !failed && !active,
    hasSource,
    failed,
    active,
    pendingTargetCount,
    completedTargetCount: summaryTargetStore
      ? Number(summaryTargetStore.currentStoredCompletedTargetCount || 0)
      : Number(stats.completedTargetCount || 0),
    claimedTargetCount,
    failedTargetCount
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
  const claimedTargetCount = summaryTargetStore.currentTargetScope
    ? Number(summaryTargetStore.currentStoredClaimedTargetCount || 0)
    : Number(summaryTargetStore.claimedTargetCount || 0)
  return Boolean(
    Number(stats.pendingTargetCount || 0) > 0 ||
    currentPendingFromStore > 0 ||
    claimedTargetCount > 0
  )
}

const failedSummaryWork = ({ stats, summaryTargetStore }) => {
  const failedTargetCount = summaryTargetStore.currentTargetScope
    ? Number(summaryTargetStore.currentStoredFailedTargetCount || 0)
    : Number(summaryTargetStore.failedTargetCount || 0)
  const staleClaimCount = summaryTargetStore.currentTargetScope
    ? Number(summaryTargetStore.currentStoredStaleClaimCount || 0)
    : Number(summaryTargetStore.staleClaimCount || 0)
  return Boolean(
    Number(stats.failedTargetCount || 0) > 0 ||
    failedTargetCount > 0 ||
    staleClaimCount > 0
  )
}

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

const backgroundStatusMessage = job => {
  if (!job) return undefined
  if (job.status === 'suspended') return job.message || 'background indexing is suspended'
  if (job.status === 'error') return job.error || 'background indexing job failed'
  if (job.status === 'stale') return 'background indexing job is no longer running'
  if (jobHasActiveIndexingWork(job) || jobHasActiveSummaryWork(job)) return 'background indexing is catching up'
  return undefined
}

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
  const targetCount = Number(summaryTargetStore.currentTargetScope
    ? summaryTargetStore.currentTargetCount
    : summaryTargetStore.targetCount || 0)
  const completedTargetCount = Number(summaryTargetStore.currentTargetScope
    ? summaryTargetStore.currentStoredCompletedTargetCount
    : summaryTargetStore.completedTargetCount || 0)
  const failedTargetCount = Number(summaryTargetStore.currentTargetScope
    ? summaryTargetStore.currentStoredFailedTargetCount
    : summaryTargetStore.failedTargetCount || 0)
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
  if (indexed) {
    const latestNeedsAttention = latestPublicJob && ['suspended', 'error', 'stale'].includes(latestPublicJob.status)
    const indexingJob = latestNeedsAttention ? latestPublicJob : runningPublicJob || latestPublicJob
    const failed = failedSummaryWork({ stats, summaryTargetStore }) || jobHasFailedSummaryWork(indexingJob)
    const statusMessage = failed
      ? 'background summary indexing has failed or stale work claims'
      : backgroundStatusMessage(indexingJob)
    return {
      state: 'ready',
      ...(statusMessage ? { statusMessage } : {}),
      ...(indexingJob ? { indexingJob } : {})
    }
  }
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
  const currentTargetIds = currentTargetIdsForSession(sessionRecord) || new Set()
  const out = {
    ...sessionRecord,
    summaryTargetIds: [...currentTargetIds].sort(),
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
  let sourcePath = null
  const cleanupErrors = []
  const remove = file => {
    try {
      if (unlinkIfExists(file)) removedFiles.push(file)
    } catch (err) {
      cleanupErrors.push({ file, error: err.message })
    }
  }
  withFileLock(manifestLockPath(root), () => {
    bumpSessionGeneration({ root, sessionId })
    const manifest = readManifest(root)
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
    manifest.updatedAt = new Date().toISOString()
    writeManifest(root, manifest)
    withFileLock(summaryTargetsLockPath(root, sessionId), () => {
      remove(summaryTargetsPath(root, sessionId))
      remove(legacySummaryTargetsPath(root, sessionId))
    })
  })
  try {
    removedJobArtifacts = removeJobArtifactsForSession({ root, sessionId, sourcePath })
  } catch (err) {
    cleanupErrors.push({ artifact: 'job_state', error: err.message })
  }
  remove(irPath(root, sessionId))
  remove(legacyIrPath(root, sessionId))
  remove(treePath(root, sessionId))
  remove(docStorePath(root, sessionId))
  return {
    sessionId,
    removedFromManifest: Boolean(removedSession),
    ...(removedSession ? { removedSession } : {}),
    ...(removedJobArtifacts.length ? { removedJobArtifacts } : {}),
    ...(cleanupErrors.length ? { cleanupErrors } : {}),
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
  return withAsyncFileLock(sessionIndexLockPath(root, sessionId), async () => {
    const typeOpts = { root, indexDir: root, ...backendOpts }
    const manifest = readManifest(root)
    const manifestAgent = manifest.sessions && manifest.sessions[sessionId] && manifest.sessions[sessionId].agent
    const local = resetSessionIndex({ root, sessionId })
    let result
    try {
      result = await deleteSessionDocuments({
        sessionId,
        agent: agent || manifestAgent || undefined,
        ...typeOpts
      })
    } catch (err) {
      err.localReset = local
      throw err
    }
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
  }, {
    timeoutMs: Number(backendOpts.sessionIndexLockTimeoutMs || 5 * 60 * 1000),
    staleMs: Number(backendOpts.sessionIndexLockStaleMs || 30 * 60 * 1000)
  })
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
    summaryTargetIds: [],
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

const candidateIsOlderThanIndexed = ({ candidate, indexed }) => {
  if (!candidate || !indexed) return false
  const candidateSize = Number(candidate.sourceFingerprint && candidate.sourceFingerprint.sourceSize || 0)
  const publishedSize = Number(indexed.sourceFingerprint && indexed.sourceFingerprint.sourceSize || 0)
  const candidateTime = Date.parse(candidate.updatedAt)
  const publishedTime = Date.parse(indexed.updatedAt)
  if (candidate.sourcePath) {
    try {
      const stat = fs.statSync(candidate.sourcePath)
      const sizeMatches = !candidateSize || stat.size === candidateSize
      const timeMatches = Number.isFinite(candidateTime) && Math.abs(stat.mtimeMs - candidateTime) < 1
      if (sizeMatches && timeMatches) return false
      if (Number.isFinite(candidateTime) && stat.mtimeMs > candidateTime) return true
      if (candidateSize && stat.size > candidateSize) return true
    } catch (_err) {}
  }
  if (Number.isFinite(candidateTime) && Number.isFinite(publishedTime)) {
    if (candidateTime < publishedTime) return true
    if (candidateTime > publishedTime) return false
  }
  if (candidateSize && publishedSize && candidateSize < publishedSize) return true
  return Number(candidate.eventCount || 0) < Number(published.eventCount || 0)
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
  const requestedIndexId = ir && (ir.indexId || ir.index_id || ir.session && (ir.session.indexId || ir.session.index_id))
  const startingGeneration = readSessionGeneration({ root, sessionId: ir.session.id })
  const existingSession = readManifest(root).sessions[ir.session.id]
  ir.indexId = existingSession && existingSession.indexId || requestedIndexId || indexIdForIR(ir)
  const ownerId = summaryOwnerId()
  const previousSummaryJobs = completedSummaryJobs({ root, sessionId: ir.session.id })
  const assertSessionGeneration = phase => {
    if (readSessionGeneration({ root, sessionId: ir.session.id }) !== startingGeneration) {
      throw new Error(`indexing cancelled because session ${ir.session.id} was reset ${phase}`)
    }
  }
  const guardedReserveSummaryJobs = jobs => withFileLock(manifestLockPath(root), () => {
    assertSessionGeneration('before summary reservation')
    return reserveSummaryJobs({
      root,
      sessionId: ir.session.id,
      ownerId
    })(jobs)
  })
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
    reserveSummaryJobs: guardedReserveSummaryJobs
  })
  if (typeof onProgress === 'function') {
    onProgress({
      phase: 'summary:commit',
      sessionId: ir.session.id,
      jobCount: summaryIndex.jobs.length
    })
  }
  withFileLock(manifestLockPath(root), () => {
    assertSessionGeneration('before summary commit')
    commitSummaryJobs({
      root,
      sessionId: ir.session.id,
      ownerId,
      jobs: summaryIndex.jobs
    })
  })
  applyStoredSummaryJobs(tree, completedSummaryJobs({ root, sessionId: ir.session.id }))
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
  let docs
  let readiness
  const refreshCandidateState = () => {
    const latestJobs = completedSummaryJobs({ root, sessionId: ir.session.id })
    if (latestJobs.length) {
      applyStoredSummaryJobs(tree, latestJobs)
      const latestByTarget = new Map(latestJobs
        .filter(job => job && job.targetId)
        .map(job => [job.targetId, job]))
      summaryIndex.jobs = (summaryIndex.jobs || []).map(job => latestByTarget.get(job.targetId) || job)
      sessionRecord.summaryJobs = summaryIndex.jobs
      sessionRecord.compactions = refreshedCompactionAccounting({
        compactions: sessionRecord.compactions,
        jobs: latestJobs
      })
      if (sessionRecord.summaryIndex) {
        sessionRecord.summaryIndex = {
          ...sessionRecord.summaryIndex,
          ...jobAccounting(summaryIndex.jobs),
          compactionLog: sessionRecord.compactions
        }
        summaryIndex.summary = sessionRecord.summaryIndex
      }
    }
    docs = collectPublishedDocuments({ tree, sourceTree })
    sessionRecord.docCount = docs.length
    sessionRecord.shortSummary = preview(tree.root.head || ir.session.title || ir.session.id, 180)
    sessionRecord.fullTokenCount = tree.root.fullTokenCount
    sessionRecord.usage = tree.root.usage
    sessionRecord.indexingStats = indexingStats(sessionRecord)
    readiness = summaryMode === 'model'
      ? currentDerivationReadiness({ root, sessionRecord })
      : {
          ready: true,
          hasSource: Boolean(sourceTimestamp(sessionRecord.sourcePath)),
          failed: false,
          active: false,
          pendingTargetCount: 0,
          completedTargetCount: Number(sessionRecord.indexingStats.completedTargetCount || 0),
          claimedTargetCount: 0,
          failedTargetCount: 0
        }
    if (summaryMode === 'model') {
      if (readiness.ready && sessionRecord.summaryIndex) {
        sessionRecord.summaryIndex.skippedJobCount = 0
        summaryIndex.summary = sessionRecord.summaryIndex
      }
      const currentTargetIds = currentTargetIdsForSession(sessionRecord)
      sessionRecord.indexingStats = {
        ...indexingStats(sessionRecord),
        targetCount: currentTargetIds ? currentTargetIds.size : Number(sessionRecord.indexingStats.targetCount || 0),
        completedTargetCount: readiness.completedTargetCount,
        pendingTargetCount: readiness.pendingTargetCount,
        failedTargetCount: readiness.failedTargetCount,
        ...(readiness.ready
          ? {
              indexedCompactionCount: Number(sessionRecord.indexingStats.compactionCount || 0),
              pendingCompactionCount: 0,
              skippedJobCount: 0
            }
          : {})
      }
    }
  }
  refreshCandidateState()
  return withAsyncFileLock(sessionIndexLockPath(root, ir.session.id), async () => {
    assertSessionGeneration('while the hierarchy was being derived')
    refreshCandidateState()
    const indexedSession = readManifest(root).sessions[ir.session.id]
    const hasIndexedHierarchy = Boolean(indexedSession && indexedSession.indexId)
    const deferredReason = hasIndexedHierarchy && candidateIsOlderThanIndexed({
      candidate: sessionRecord,
      indexed: indexedSession
    })
      ? 'stale_source'
      : hasIndexedHierarchy && summaryMode === 'model' && !readiness.ready
        ? 'summary_not_ready'
        : ''
    if (deferredReason) {
      const deferredServerIndex = {
        backend: searchBackend,
        status: 'deferred',
        reason: deferredReason,
        indexedIndexId: indexedSession.indexId,
        result: {
          imported: 0,
          deferred: true
        }
      }
      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'index:documents:deferred',
          reason: deferredReason,
          sessionId: ir.session.id,
          docCount: docs.length
        })
      }
      return {
        sessionId: ir.session.id,
        indexId: indexedSession.indexId,
        title: indexedSession.title || ir.session.title,
        sourcePath: ir.source.path,
        sourceFingerprint: ir.source.fingerprint,
        eventCount: ir.events.length,
        turnCount: turnCountForIR(ir),
        docCount: indexedSession.docCount,
        rootHandle: indexedSession.rootHandle || tree.root.handle,
        shortSummary: indexedSession.shortSummary,
        fullTokenCount: indexedSession.fullTokenCount,
        usage: indexedSession.usage,
        summaryIndex: summaryIndex.summary,
        summaryJobs: summaryIndex.jobs,
        compactions: sessionRecord.compactions,
        indexingStats: sessionRecord.indexingStats,
        hierarchyDeferred: true,
        reusedExistingIndex: true,
        readiness,
        serverIndex: deferredServerIndex
      }
    }
    if (typeof onProgress === 'function') {
      onProgress({
        phase: 'index:documents',
        sessionId: ir.session.id,
        docCount: docs.length
      })
    }
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
      assertSessionGeneration('before writing the hierarchy')
      sessionRecord.summaryJobs = summaryIndex.jobs
      sessionRecord.indexingStats = indexingStats(sessionRecord)
      const manifest = readManifest(root)
      writeSessionDocs({ root, sessionId: ir.session.id, docs })
      writeSessionIR({ root, ir })
      manifest.updatedAt = now
      manifest.sessions[ir.session.id] = sessionRecordForManifest(sessionRecord)
      writeManifest(root, manifest)
    })
    try {
      unlinkIfExists(treePath(root, ir.session.id))
    } catch (err) {
      serverIndex.compatibilityCleanup = { error: err.message }
    }
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
      readiness,
      serverIndex
    }
  }, {
    timeoutMs: Number(backendOpts.sessionIndexLockTimeoutMs || 5 * 60 * 1000),
    staleMs: Number(backendOpts.sessionIndexLockStaleMs || 30 * 60 * 1000)
  })
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
    if (out.text) return out
    let tree = treeCache && treeCache.get(sessionId)
    if (!tree) {
      tree = readSessionTree({ root, sessionId })
      if (treeCache) treeCache.set(sessionId, tree)
    }
    const node = tree && tree.byHandle && tree.byHandle.get(handle)
    const text = navigationTextForNode(node)
    if (!out.text && text) out.text = text
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

const sessionIdFromHandle = handle => {
  const parts = String(handle || '').split('/')
  if (parts[0] !== 'session' || !parts[1]) return ''
  try {
    return decodeURIComponent(parts[1])
  } catch (_err) {
    return parts[1]
  }
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
  const root = backendOpts.root || backendOpts.indexDir || DEFAULT_INDEX_DIR
  const parsedTopic = topicId ? parseTopicId(topicId) : null
  const topicHandle = parsedTopic && parsedTopic.handle
  const resolvedSessionId = sessionId || sessionIdFromHandle(handle || topicHandle)
  const result = await browseTypesense({
    indexId,
    sessionId: resolvedSessionId || sessionId,
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
  const resolvedIndexId = indexId || parsed.indexId
  const resolvedSessionId = sessionId || parsed.sessionId || sessionIdFromHandle(parsed.handle)
  const result = await openLinkTypesense({
    link,
    indexId: resolvedIndexId,
    sessionId: resolvedSessionId,
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
  const root = backendOpts.root || backendOpts.indexDir || DEFAULT_INDEX_DIR
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
      root,
      value: hits
    })
  }
}

module.exports = {
  __testing: {
    sessionRecordForManifest
  },
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
