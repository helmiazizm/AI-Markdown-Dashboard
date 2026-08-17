import type { DashboardArtifactV1 } from '@fieldboard/contracts'
import { executeDatasetQuery, type QueryExecutionResult } from '../data/query-service.js'
import {
  artifactSha256,
  canonicalizeDashboardArtifact,
  loadBundle,
  serializeBundle,
  writeBundleAtomically,
} from './codec.js'
import { commitDashboardPath, getRepositoryRoot } from './git-repository.js'
import {
  addPublicationEvent,
  addValidationEvent,
  blockPublication,
  completePublication,
  completeValidation,
  createValidationRun,
  failValidation,
  getPreparedPublication,
  getValidationPayload,
  getValidationRun,
  markPublicationCommitted,
  markPublicationPublishing,
  markValidationImported,
  prepareManualPublication,
  setValidationRunning,
} from './persistence.js'
import { getRepositoryStatus, withRepositoryLock } from './publication-service.js'

interface ValidatedCandidate {
  dashboardId: string
  contentPath: string
  artifact: DashboardArtifactV1
  artifactHash: string
  results: Record<string, QueryExecutionResult>
}

interface ValidationPayload {
  fingerprint: string
  sourceHead: string
  sourceWasCommitted: boolean
  candidates: ValidatedCandidate[]
}

export async function startRepositoryValidation(input: { expectedHead: string | null; fingerprint: string }): Promise<string> {
  const repository = await getRepositoryStatus()
  if (!repository.activated || !repository.initialized) throw new Error(repository.error ?? 'Content repository is not active')
  if (repository.readiness !== 'dirty' && repository.readiness !== 'unindexed') throw new Error('There are no importable repository changes')
  if (repository.head !== input.expectedHead || repository.fingerprint !== input.fingerprint) {
    const error = new Error('Repository fingerprint changed before validation started')
    error.name = 'StaleRepositoryError'
    throw error
  }
  if (!repository.head) throw new Error('Content repository has no HEAD')
  const id = await createValidationRun({ expectedHead: repository.head, fingerprint: repository.fingerprint, affectedDashboards: repository.affectedDashboards })
  setImmediate(() => void runRepositoryValidation(id))
  return id
}

async function runRepositoryValidation(id: string): Promise<void> {
  try {
    await setValidationRunning(id)
    await addValidationEvent(id, 'inspecting', 'Checking changed paths and loading affected bundles.')
    const run = await getValidationRun(id)
    const repository = await getRepositoryStatus()
    if (!run || repository.fingerprint !== run.fingerprint || repository.head !== run.expectedHead) throw new Error('Repository changed during validation')
    if (!repository.head) throw new Error('Content repository has no HEAD')
    const unsupported = repository.changedFiles.filter((file) => !file.dashboardPath)
    const deletions = repository.changedFiles.filter((file) => file.status.includes('D'))
    if (unsupported.length) throw new Error(`Unsupported root changes: ${unsupported.map((file) => file.path).join(', ')}`)
    if (deletions.length) throw new Error(`Dashboard deletion and renaming are unsupported: ${deletions.map((file) => file.path).join(', ')}`)
    if (!repository.affectedDashboards.length) throw new Error('No affected dashboard bundles were found')
    if (repository.affectedDashboards.length > 8) throw new Error('At most eight dashboard bundles may be imported at once')
    const candidates: ValidatedCandidate[] = []
    for (const [index, contentPath] of repository.affectedDashboards.entries()) {
      await addValidationEvent(id, 'validating', `Validating bundle ${index + 1} of ${repository.affectedDashboards.length}.`, { contentPath })
      const loaded = await loadBundle(getRepositoryRoot(), contentPath)
      const artifact = canonicalizeDashboardArtifact(loaded.artifact)
      const results: Record<string, QueryExecutionResult> = {}
      for (const dataset of artifact.datasets) {
        await addValidationEvent(id, 'querying', `Running final query for ${dataset.id}.`, { contentPath, datasetId: dataset.id })
        results[dataset.id] = await executeDatasetQuery(dataset)
      }
      candidates.push({ dashboardId: loaded.manifest.dashboardId, contentPath, artifact, artifactHash: artifactSha256(artifact), results })
    }
    const payload: ValidationPayload = {
      fingerprint: run.fingerprint,
      sourceHead: repository.head,
      sourceWasCommitted: repository.clean && repository.readiness === 'unindexed',
      candidates,
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > 16_000_000) throw new Error('Validated result payload exceeds 16 MB')
    await completeValidation(id, payload)
    await addValidationEvent(id, 'valid', 'All affected bundles and final warehouse queries are valid.', { dashboards: candidates.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failValidation(id, [message])
    await addValidationEvent(id, 'invalid', message)
  }
}

function isValidationPayload(value: unknown): value is ValidationPayload {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<ValidationPayload>
  return typeof input.fingerprint === 'string' && typeof input.sourceHead === 'string' && typeof input.sourceWasCommitted === 'boolean' && Array.isArray(input.candidates)
}

export async function importValidatedRepositoryChanges(validationId: string, note: string): Promise<{ publicationIds: string[] }> {
  return withRepositoryLock(async () => {
    const [validation, payload, repository] = await Promise.all([
      getValidationRun(validationId),
      getValidationPayload(validationId),
      getRepositoryStatus(),
    ])
    if (!validation || validation.status !== 'valid' || !validation.expiresAt || new Date(validation.expiresAt) <= new Date()) {
      const error = new Error('Validation token is missing, expired, or not publishable')
      error.name = 'StaleRepositoryError'
      throw error
    }
    if (!isValidationPayload(payload)) throw new Error('Validation payload is invalid')
    if (repository.fingerprint !== validation.fingerprint || repository.head !== validation.expectedHead) {
      const error = new Error('Repository changed after validation. Validate the new fingerprint before importing.')
      error.name = 'StaleRepositoryError'
      throw error
    }
    const publicationIds: string[] = []
    let expectedHead = repository.head
    if (!expectedHead) throw new Error('Content repository has no HEAD')
    for (const candidate of payload.candidates) {
      const resultMap = new Map(Object.entries(candidate.results))
      const prepared = await prepareManualPublication({
        dashboardId: candidate.dashboardId,
        contentPath: candidate.contentPath,
        note,
        artifact: candidate.artifact,
        artifactHash: candidate.artifactHash,
        results: resultMap,
        expectedHead,
        sourceCommitSha: payload.sourceWasCommitted ? payload.sourceHead : null,
      })
      publicationIds.push(prepared.id)
      try {
        await markPublicationPublishing(prepared.id)
        await addPublicationEvent(prepared.id, 'publishing', 'Normalizing validated external edits and provenance.')
        const current = await getPreparedPublication(prepared.id)
        if (!current) throw new Error('Prepared manual publication disappeared')
        const bundle = serializeBundle(current.artifact, {
          dashboardId: current.dashboardId,
          contentPath: current.contentPath,
          revisionId: current.revisionId,
          revisionNumber: current.revisionNumber,
          parentRevisionId: current.parentRevisionId,
          restoredFromRevisionId: null,
          sourceKind: 'manual',
          note,
          model: 'external-editor',
          runId: null,
          generatedAt: current.createdAt,
          sourceSnapshot: current.sourceSnapshot,
        })
        if (bundle.artifactHash !== current.expectedBundleHash) throw new Error('Manual bundle changed after validation')
        await writeBundleAtomically(getRepositoryRoot(), bundle, current.contentPath, current.id)
        const reloaded = await loadBundle(getRepositoryRoot(), current.contentPath)
        if (reloaded.artifactHash !== current.expectedBundleHash) throw new Error('Manual bundle failed canonical round-trip')
        const commit = await commitDashboardPath({
          contentPath: current.contentPath,
          message: `fieldboard(${current.dashboardId.slice(0, 8)}): import revision ${current.revisionNumber}`,
          revisionId: current.revisionId,
          dashboardId: current.dashboardId,
          runId: null,
          sourceKind: 'manual',
          artifactHash: current.expectedBundleHash,
        })
        await markPublicationCommitted(current.id, commit.commitSha)
        await completePublication(current.id, commit.commitSha, commit.treeSha, current.expectedBundleHash)
        await addPublicationEvent(current.id, 'published', 'External edit imported as a Git-backed dashboard revision.', { commitSha: commit.commitSha })
        expectedHead = commit.commitSha
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await blockPublication(prepared.id, message)
        await addPublicationEvent(prepared.id, 'blocked', message)
        throw error
      }
    }
    await markValidationImported(validationId)
    await addValidationEvent(validationId, 'imported', 'Validated repository changes were published.', { publicationIds })
    return { publicationIds }
  })
}
