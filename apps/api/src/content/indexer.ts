import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FieldboardProvenanceV1 } from '@fieldboard/contracts'
import { getConfig } from '../config.js'
import { closePools } from '../db/pool.js'
import { migrateAll } from '../db/migrate-all.js'
import {
  applyContentIndex,
  dashboardExists,
  getRepositoryDatabaseState,
  setRepositoryState,
  type IndexedRevisionRecord,
} from './persistence.js'
import {
  commitExists,
  getCommitTreeSha,
  inspectGitRepository,
  isAncestor,
  listDashboardPathsAt,
  listPathHistory,
  loadBundleAtCommit,
} from './git-repository.js'
import { withRepositoryLock } from './publication-service.js'
import { rematerializeMissingHeadSummaries } from './summaries.js'

export type ContentReindexMode = 'skip' | 'incremental' | 'full'

export interface ContentIndexReport {
  mode: ContentReindexMode
  head: string | null
  indexedHead: string | null
  dashboards: number
  revisions: number
  errors: string[]
}

export function chooseReindexMode(input: {
  indexedHead: string | null
  head: string
  indexedHeadInRepo: boolean
  indexedIsAncestor: boolean
}): ContentReindexMode {
  if (!input.indexedHead) return 'full'
  if (input.indexedHead === input.head) return 'skip'
  if (!input.indexedHeadInRepo) return 'full'
  if (input.indexedIsAncestor) return 'incremental'
  return 'full'
}

export async function scanCommittedDashboards(input: {
  head: string
  mode: 'full' | 'incremental'
  indexedHead: string | null
}): Promise<{
  headPaths: string[]
  revisions: IndexedRevisionRecord[]
  errors: Array<{ contentPath: string; commitSha: string; error: string }>
}> {
  const headPaths = await listDashboardPathsAt(input.head)
  const revisions: IndexedRevisionRecord[] = []
  const errors: Array<{ contentPath: string; commitSha: string; error: string }> = []
  for (const contentPath of headPaths) {
    let afterCommit: string | null = null
    if (input.mode === 'incremental' && input.indexedHead) {
      try {
        const headBundle = await loadBundleAtCommit(input.head, contentPath)
        if (await dashboardExists(headBundle.manifest.dashboardId)) afterCommit = input.indexedHead
      } catch (error) {
        errors.push({
          contentPath,
          commitSha: input.head,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
    }
    let history: string[]
    try {
      history = await listPathHistory(contentPath, { afterCommit, untilCommit: input.head })
    } catch (error) {
      errors.push({
        contentPath,
        commitSha: input.head,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    // An incremental walk legitimately returns nothing when no new commit touched the path.
    if (!history.length && input.mode === 'incremental') continue
    // A full walk cannot be empty for a path that exists at HEAD: some commit introduced it.
    // Treating this as one revision at HEAD would make applyContentIndex delete every other
    // revision of the dashboard, so report it and leave the existing projection untouched.
    if (!history.length) {
      errors.push({
        contentPath,
        commitSha: input.head,
        error: 'The commit history for this dashboard could not be read; its projection was left unchanged.',
      })
      continue
    }
    const byRevision = new Map<string, IndexedRevisionRecord>()
    let headRevisionId: string | null = null
    for (const commitSha of history) {
      try {
        const loaded = await loadBundleAtCommit(commitSha, contentPath)
        const treeSha = await getCommitTreeSha(commitSha, contentPath)
        const provenance: FieldboardProvenanceV1 = loaded.provenance
        const record: IndexedRevisionRecord = {
          dashboardId: loaded.manifest.dashboardId,
          contentPath,
          revisionId: provenance.revisionId,
          revisionNumber: provenance.revisionNumber,
          parentRevisionId: provenance.parentRevisionId,
          restoredFromRevisionId: provenance.restoredFromRevisionId,
          sourceKind: provenance.sourceKind,
          note: provenance.note,
          model: provenance.model,
          generatedAt: provenance.generatedAt,
          artifact: loaded.artifact,
          artifactHash: loaded.artifactHash,
          commitSha,
          treeSha,
          isHead: false,
        }
        byRevision.set(provenance.revisionId, record)
        headRevisionId = provenance.revisionId
      } catch (error) {
        errors.push({
          contentPath,
          commitSha,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    for (const record of byRevision.values()) {
      record.isHead = record.revisionId === headRevisionId
      revisions.push(record)
    }
  }
  return { headPaths, revisions, errors }
}

export async function reconcileContentIndex(options: { rematerialize?: boolean } = {}): Promise<ContentIndexReport> {
  const git = await inspectGitRepository()
  if (!git.initialized || git.readiness === 'disabled' || git.readiness === 'uninitialized') {
    await setRepositoryState({
      head: git.head,
      readiness: git.readiness,
      activated: false,
      error: git.error,
    }).catch(() => undefined)
    return { mode: 'skip', head: git.head, indexedHead: null, dashboards: 0, revisions: 0, errors: git.error ? [git.error] : [] }
  }
  if (git.readiness === 'wrong_branch' || git.readiness === 'detached' || git.readiness === 'unavailable' || !git.head) {
    await setRepositoryState({
      head: git.head,
      readiness: git.readiness,
      error: git.error,
    }).catch(() => undefined)
    return { mode: 'skip', head: git.head, indexedHead: null, dashboards: 0, revisions: 0, errors: git.error ? [git.error] : [] }
  }

  const database = await getRepositoryDatabaseState()
  const indexedHeadInRepo = database.indexedHead ? await commitExists(database.indexedHead) : false
  const indexedIsAncestor = Boolean(database.indexedHead && indexedHeadInRepo && await isAncestor(database.indexedHead, git.head))
  const mode = chooseReindexMode({
    indexedHead: database.indexedHead,
    head: git.head,
    indexedHeadInRepo,
    indexedIsAncestor,
  })

  if (mode === 'skip') {
    const summaryErrors = options.rematerialize === false ? [] : await rematerializeMissingHeadSummaries()
    const error = summaryErrors.length ? `Summary rematerialization incomplete: ${summaryErrors.join('; ')}` : git.error
    await setRepositoryState({
      head: git.head,
      indexedHead: git.head,
      readiness: git.clean ? 'ready' : 'dirty',
      activated: true,
      error,
    })
    return { mode, head: git.head, indexedHead: git.head, dashboards: 0, revisions: 0, errors: summaryErrors }
  }

  const scanned = await scanCommittedDashboards({
    head: git.head,
    mode,
    indexedHead: database.indexedHead,
  })
  const scanErrors = scanned.errors.map((item) => `${item.contentPath}@${item.commitSha.slice(0, 10)}: ${item.error}`)
  // A scan that could not read part of the repository has produced an incomplete projection.
  // Holding last_indexed_head back keeps head !== indexedHead, which reports the repository as
  // unindexed, blocks authoring on a partial base, and makes the next pass retry the same range.
  const indexedHead = scanErrors.length ? null : git.head
  await applyContentIndex({
    head: git.head,
    indexedHead,
    mode,
    headPaths: scanned.headPaths,
    revisions: scanned.revisions,
    readiness: git.clean ? 'ready' : 'dirty',
    error: scanErrors.length ? scanErrors.join('; ') : null,
  })
  const summaryErrors = options.rematerialize === false ? [] : await rematerializeMissingHeadSummaries()
  const errors = [...scanErrors, ...summaryErrors]
  if (summaryErrors.length) {
    await setRepositoryState({
      head: git.head,
      indexedHead,
      readiness: git.clean ? 'ready' : 'dirty',
      activated: true,
      error: errors.join('; '),
    })
  }
  return {
    mode,
    head: git.head,
    indexedHead,
    dashboards: new Set(scanned.revisions.map((item) => item.dashboardId)).size,
    revisions: scanned.revisions.length,
    errors,
  }
}

export async function runContentIndexerLoop(): Promise<void> {
  const config = getConfig()
  const interval = config.CONTENT_INDEX_INTERVAL_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      await migrateAll()
      break
    } catch (error) {
      if (attempt >= 30) throw error
      console.error('Waiting for PostgreSQL before content index:', error)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  for (;;) {
    if (!config.CONTENT_REPOSITORY_ENABLED) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      continue
    }
    try {
      const report = await withRepositoryLock(() => reconcileContentIndex({ rematerialize: false }))
      const summaryErrors = await rematerializeMissingHeadSummaries()
      const errors = [...report.errors, ...summaryErrors]
      if (report.mode !== 'skip' || errors.length) {
        console.log(JSON.stringify({ ...report, errors, at: new Date().toISOString() }))
      }
    } catch (error) {
      console.error('Content index failed:', error)
      await setRepositoryState({
        head: null,
        readiness: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shutdown = async (code = 0): Promise<void> => {
    await closePools()
    process.exit(code)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
  runContentIndexerLoop().catch(async (error) => {
    console.error(error)
    await shutdown(1)
  })
}
