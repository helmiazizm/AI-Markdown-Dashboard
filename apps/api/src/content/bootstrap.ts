import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePools } from '../db/pool.js'
import { migrateAll } from '../db/migrate-all.js'
import { artifactSha256, canonicalizeDashboardArtifact, dashboardContentPath, loadBundle, serializeBundle, writeBundleAtomically } from './codec.js'
import {
  commitDashboardPath,
  commitRepositoryFiles,
  findRevisionCommit,
  getCommitTreeSha,
  getRepositoryHead,
  getRepositoryRoot,
  initializeGitRepository,
  inspectGitRepository,
} from './git-repository.js'
import { backfillBootstrapRevision, getRepositoryDatabaseState, listAllRevisionsForBootstrap, setRepositoryState } from './persistence.js'

export interface ContentBootstrapReport {
  schemaVersion: 1
  activatedAt: string
  revisionsMapped: number
  dashboardsMapped: number
  rootCommit: string
  activationCommit: string
}

export async function bootstrapContentRepository(): Promise<ContentBootstrapReport> {
  const before = await inspectGitRepository()
  if (!before.initialized) {
    const entries = await readdir(getRepositoryRoot()).catch(() => [])
    if (entries.length > 0) throw new Error('Content bootstrap requires an absent, empty, or compatible initialized repository')
  } else if ((before.head !== null && !before.clean) || before.readiness === 'wrong_branch' || before.readiness === 'detached') {
    throw new Error(before.error ?? 'The existing content repository is not clean and compatible')
  }

  const rootCommit = await initializeGitRepository()
  const revisions = await listAllRevisionsForBootstrap()
  const stablePaths = new Map<string, string>()
  for (const revision of revisions) {
    stablePaths.set(revision.dashboardId, revision.contentPath ?? stablePaths.get(revision.dashboardId) ?? dashboardContentPath(revision.artifact.title, revision.dashboardId))
  }

  for (const revision of revisions) {
    const contentPath = stablePaths.get(revision.dashboardId)
    if (!contentPath) throw new Error(`Could not derive content path for ${revision.dashboardId}`)
    const artifact = canonicalizeDashboardArtifact(revision.artifact)
    const artifactHash = artifactSha256(artifact)
    const sourceKind = revision.sourceKind === 'legacy' && revision.restoredFromRevisionId ? 'restore' : revision.sourceKind
    let commitSha = await findRevisionCommit(revision.revisionId)
    if (!commitSha) {
      const bundle = serializeBundle(artifact, {
        dashboardId: revision.dashboardId,
        contentPath,
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        parentRevisionId: revision.parentRevisionId,
        restoredFromRevisionId: revision.restoredFromRevisionId,
        sourceKind,
        note: revision.prompt,
        model: revision.model,
        runId: null,
        generatedAt: revision.createdAt,
        sourceSnapshot: revision.sourceSnapshot,
      })
      await writeBundleAtomically(getRepositoryRoot(), bundle, contentPath, `bootstrap-${revision.revisionId}`)
      const loaded = await loadBundle(getRepositoryRoot(), contentPath)
      if (loaded.artifactHash !== artifactHash) throw new Error(`Round-trip mismatch for revision ${revision.revisionId}`)
      const verb = revision.restoredFromRevisionId ? 'restore' : revision.revisionNumber === 1 ? 'create' : 'refine'
      commitSha = (await commitDashboardPath({
        contentPath,
        message: `fieldboard(${revision.dashboardId.slice(0, 8)}): ${verb} revision ${revision.revisionNumber}`,
        revisionId: revision.revisionId,
        dashboardId: revision.dashboardId,
        runId: null,
        sourceKind,
        artifactHash,
        date: revision.createdAt,
      })).commitSha
    }
    const treeSha = await getCommitTreeSha(commitSha, contentPath)
    await backfillBootstrapRevision({ dashboardId: revision.dashboardId, contentPath, revisionId: revision.revisionId, commitSha, treeSha, artifactHash, sourceKind })
  }

  for (const revision of revisions.filter((item) => item.revisionId === item.currentRevisionId)) {
    const contentPath = stablePaths.get(revision.dashboardId)
    if (!contentPath) throw new Error('Missing current dashboard path')
    const loaded = await loadBundle(getRepositoryRoot(), contentPath)
    const expected = artifactSha256(canonicalizeDashboardArtifact(revision.artifact))
    if (loaded.artifactHash !== expected) throw new Error(`HEAD does not contain the current artifact for ${revision.dashboardId}`)
  }

  const databaseState = await getRepositoryDatabaseState()
  const existingReportPath = path.join(getRepositoryRoot(), 'fieldboard.migration.json')
  let activationCommit = await getRepositoryHead()
  if (!databaseState.activated) {
    const reportDraft = {
      schemaVersion: 1,
      activatedAt: new Date().toISOString(),
      revisionsMapped: revisions.length,
      dashboardsMapped: stablePaths.size,
      rootCommit,
      activationCommit: '$GIT_COMMIT',
    }
    await writeFile(existingReportPath, `${JSON.stringify(reportDraft, null, 2)}\n`, 'utf8')
    activationCommit = await commitRepositoryFiles(['fieldboard.migration.json'], 'fieldboard: activate Git-canonical content storage')
  }
  if (!activationCommit) throw new Error('Content repository has no HEAD after bootstrap')
  await setRepositoryState({ head: activationCommit, indexedHead: activationCommit, readiness: 'ready', activated: true, error: null })
  return {
    schemaVersion: 1,
    activatedAt: new Date().toISOString(),
    revisionsMapped: revisions.length,
    dashboardsMapped: stablePaths.size,
    rootCommit,
    activationCommit,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrateAll()
    .then(bootstrapContentRepository)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .then(closePools)
    .catch(async (error) => {
      console.error(error)
      await closePools()
      process.exitCode = 1
    })
}
