import type { RepositoryStatus } from '@fieldboard/contracts'
import { getConfig } from '../config.js'
import { addGenerationEvent } from '../db/repository.js'
import { pool } from '../db/pool.js'
import {
  canonicalizeDashboardArtifact,
  artifactSha256,
  loadBundle,
  serializeBundle,
  writeBundleAtomically,
} from './codec.js'
import {
  commitDashboardPath,
  findRevisionCommit,
  getCommitTreeSha,
  getRepositoryRoot,
  inspectGitRepository,
  isAncestor,
  listChangedFilesBetween,
  listCommitsAfter,
} from './git-repository.js'
import {
  addPublicationEvent,
  blockPublication,
  completePublication,
  getDashboardCurrentRevisionId,
  getPreparedPublication,
  getRepositoryDatabaseState,
  listBlockedPublications,
  markPublicationCommitted,
  markPublicationPublishing,
  retargetBlockedPublication,
  setRepositoryState,
  type PreparedPublication,
} from './persistence.js'

let repositoryQueue: Promise<void> = Promise.resolve()

async function withProcessLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = repositoryQueue
  let release = (): void => undefined
  repositoryQueue = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

export async function withRepositoryLock<T>(task: () => Promise<T>): Promise<T> {
  return withProcessLock(async () => {
    const client = await pool.connect()
    try {
      await client.query('SELECT pg_advisory_lock(748392104)')
      return await task()
    } finally {
      await client.query('SELECT pg_advisory_unlock(748392104)').catch(() => undefined)
      client.release()
    }
  })
}

export async function getRepositoryStatus(): Promise<RepositoryStatus> {
  const [git, database, blockedPublications] = await Promise.all([
    inspectGitRepository(),
    getRepositoryDatabaseState(),
    listBlockedPublications(),
  ])
  let readiness = git.readiness
  let error = git.error
  let repair = git.repair
  let unindexedCommits: Array<{ sha: string; subject: string }> = []
  let changedFiles = git.changedFiles
  let affectedDashboards = git.affectedDashboards
  if (git.initialized && git.head && database.indexedHead && git.head !== database.indexedHead) {
    if (await isAncestor(database.indexedHead, git.head)) {
      readiness = git.clean ? 'unindexed' : git.readiness
      unindexedCommits = await listCommitsAfter(database.indexedHead)
      const committedChanges = await listChangedFilesBetween(database.indexedHead)
      const seen = new Set(changedFiles.map((file) => `${file.status}:${file.path}`))
      changedFiles = [...changedFiles, ...committedChanges.filter((file) => !seen.has(`${file.status}:${file.path}`))]
      affectedDashboards = [...new Set(changedFiles.map((file) => file.dashboardPath).filter((value): value is string => Boolean(value)))]
      error ??= 'The repository contains commits that have not been imported into PostgreSQL.'
      repair ??= 'Validate and import the unindexed commits from the repository sync center.'
    } else {
      readiness = 'diverged'
      error = 'The indexed Git history is no longer an ancestor of HEAD.'
      repair = 'Repair the branch manually without rewriting the indexed history, then validate again.'
    }
  }
  if (git.initialized && !database.activated) {
    readiness = 'uninitialized'
    error = 'The repository exists but Git-canonical storage has not been activated.'
    repair = 'Run make content-bootstrap to replay and verify existing dashboard history.'
  }
  await setRepositoryState({ head: git.head, readiness, error }).catch(() => undefined)
  return {
    enabled: getConfig().CONTENT_REPOSITORY_ENABLED,
    configuredPath: getConfig().CONTENT_REPOSITORY_PATH,
    initialized: git.initialized,
    activated: database.activated,
    branch: git.branch,
    expectedBranch: getConfig().CONTENT_GIT_BRANCH,
    head: git.head,
    indexedHead: database.indexedHead,
    clean: git.clean,
    readiness,
    fingerprint: git.fingerprint,
    changedFiles,
    affectedDashboards,
    unindexedCommits,
    blockedPublications,
    lastSuccessfulScan: database.lastSuccessfulScan,
    error: error ?? database.error,
    repair,
  }
}

export async function assertRepositoryReadyForGeneration(): Promise<RepositoryStatus> {
  const status = await getRepositoryStatus()
  if (!status.enabled) throw new Error('Git-canonical authoring is disabled. Published projections remain read-only.')
  if (!status.activated || status.readiness !== 'ready' || !status.clean || status.head !== status.indexedHead) {
    const error = new Error(status.error ?? 'The content repository is not ready for authored changes.')
    error.name = 'RepositoryPreflightError'
    throw error
  }
  return status
}

function commitVerb(publication: PreparedPublication): string {
  if (publication.sourceKind === 'restore') return 'restore'
  if (publication.sourceKind === 'manual') return 'import'
  return publication.revisionNumber === 1 ? 'create' : 'refine'
}

export async function publishPreparedRevision(publicationId: string): Promise<PreparedPublication> {
  return withRepositoryLock(async () => {
    const publication = await getPreparedPublication(publicationId)
    if (!publication) throw new Error('Publication not found')
    if (publication.status === 'published') return publication
    await markPublicationPublishing(publication.id)
    await addPublicationEvent(publication.id, 'publishing', 'Repository lock acquired. Rechecking canonical state.')
    if (publication.runId) await addGenerationEvent(publication.runId, 'publishing', 'Validated artifact is being committed to the canonical content repository.', { publicationId: publication.id })
    try {
      const status = await getRepositoryStatus()
      if (!status.activated || status.readiness !== 'ready' || !status.clean) throw new Error(status.error ?? 'The content repository is not ready')
      if (status.head !== publication.expectedHead || status.indexedHead !== publication.expectedHead) {
        throw new Error('Repository HEAD changed after analysis started. Reconcile the repository, then retry publication.')
      }
      const currentRevisionId = await getDashboardCurrentRevisionId(publication.dashboardId)
      if (publication.expectedHead && publication.parentRevisionId !== currentRevisionId) {
        throw new Error('The dashboard authored base changed after analysis started. Start a new refinement from the current revision.')
      }
      const artifact = canonicalizeDashboardArtifact(publication.artifact)
      if (artifactSha256(artifact) !== publication.expectedBundleHash) throw new Error('Pending artifact hash no longer matches its publication record')
      const bundle = serializeBundle(artifact, {
        dashboardId: publication.dashboardId,
        contentPath: publication.contentPath,
        revisionId: publication.revisionId,
        revisionNumber: publication.revisionNumber,
        parentRevisionId: publication.parentRevisionId,
        restoredFromRevisionId: publication.restoredFromRevisionId,
        sourceKind: publication.sourceKind,
        note: publication.prompt,
        model: publication.model,
        runId: publication.runId,
        generatedAt: publication.createdAt,
        sourceSnapshot: publication.sourceSnapshot,
      })
      if (bundle.artifactHash !== publication.expectedBundleHash) throw new Error('Serialized artifact hash does not match the pending projection')
      await writeBundleAtomically(getRepositoryRoot(), bundle, publication.contentPath, publication.id)
      const loaded = await loadBundle(getRepositoryRoot(), publication.contentPath)
      if (loaded.artifactHash !== publication.expectedBundleHash) throw new Error('Bundle failed canonical round-trip verification')
      const verb = commitVerb(publication)
      const shortId = publication.dashboardId.slice(0, 8)
      const committed = await commitDashboardPath({
        contentPath: publication.contentPath,
        message: `fieldboard(${shortId}): ${verb} revision ${publication.revisionNumber}`,
        revisionId: publication.revisionId,
        dashboardId: publication.dashboardId,
        runId: publication.runId,
        sourceKind: publication.sourceKind,
        artifactHash: publication.expectedBundleHash,
      })
      await markPublicationCommitted(publication.id, committed.commitSha)
      await addPublicationEvent(publication.id, 'committed', 'Canonical content commit created.', { commitSha: committed.commitSha })
      await completePublication(publication.id, committed.commitSha, committed.treeSha, publication.expectedBundleHash)
      await addPublicationEvent(publication.id, 'published', 'PostgreSQL projection pinned to the Git commit.', { commitSha: committed.commitSha })
      if (publication.runId) await addGenerationEvent(publication.runId, 'completed', 'Dashboard published to Git and ready from its cached projection.', {
        dashboardId: publication.dashboardId,
        revisionId: publication.revisionId,
        revisionNumber: publication.revisionNumber,
        publicationId: publication.id,
        gitCommitSha: committed.commitSha,
      })
      return (await getPreparedPublication(publication.id)) ?? publication
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const existingCommit = await findRevisionCommit(publication.revisionId).catch(() => null)
      if (existingCommit) {
        const treeSha = await getCommitTreeSha(existingCommit, publication.contentPath)
        await completePublication(publication.id, existingCommit, treeSha, publication.expectedBundleHash)
        await addPublicationEvent(publication.id, 'recovered', 'Recovered the existing canonical commit after an interrupted projection.', { commitSha: existingCommit })
        if (publication.runId) await addGenerationEvent(publication.runId, 'completed', 'Recovered canonical publication after an interrupted projection.', { dashboardId: publication.dashboardId, revisionId: publication.revisionId, publicationId: publication.id, gitCommitSha: existingCommit })
        return (await getPreparedPublication(publication.id)) ?? publication
      }
      await blockPublication(publication.id, message)
      await addPublicationEvent(publication.id, 'blocked', message)
      if (publication.runId) await addGenerationEvent(publication.runId, 'publication_blocked', message, { publicationId: publication.id, recovery: 'Reconcile the repository, then retry publication without rerunning the agent.' })
      return (await getPreparedPublication(publication.id)) ?? publication
    }
  })
}

export async function recoverUnfinishedPublications(): Promise<void> {
  const database = await getRepositoryDatabaseState().catch(() => null)
  if (!database?.activated || !getConfig().CONTENT_REPOSITORY_ENABLED) return
  const publications = await listBlockedPublications()
  for (const publication of publications.filter((item) => item.status !== 'blocked')) {
    const commit = await findRevisionCommit(publication.revisionId).catch(() => null)
    if (commit) {
      const prepared = await getPreparedPublication(publication.id)
      if (!prepared) continue
      const treeSha = await getCommitTreeSha(commit, prepared.contentPath)
      await completePublication(publication.id, commit, treeSha, prepared.expectedBundleHash)
      await addPublicationEvent(publication.id, 'recovered', 'Startup recovery completed an interrupted publication.', { commitSha: commit })
    } else {
      await publishPreparedRevision(publication.id)
    }
  }
}

export async function retryBlockedPublication(publicationId: string): Promise<PreparedPublication> {
  const repository = await assertRepositoryReadyForGeneration()
  const publication = await getPreparedPublication(publicationId)
  if (!publication) throw new Error('Publication not found')
  if (!repository.head) throw new Error('Content repository has no HEAD')
  await retargetBlockedPublication(publicationId, repository.head)
  await addPublicationEvent(publicationId, 'retrying', 'Repository reconciled. Retrying the saved validated artifact without another agent run.', { head: repository.head })
  return publishPreparedRevision(publicationId)
}
