import type {
  ContentLifecycleEvent,
  ContentPublicationSummary,
  ContentValidationRun,
  DashboardArtifactV1,
  RevisionSourceKind,
} from '@fieldboard/contracts'
import type { QueryExecutionResult } from '../data/query-service.js'
import { writeSummary } from '../data/summary-store.js'
import { createId } from '../lib/ids.js'
import { pool } from '../db/pool.js'
import { dashboardContentPath } from './codec.js'

export interface PreparedPublication extends ContentPublicationSummary {
  artifact: DashboardArtifactV1
  contentPath: string
  prompt: string
  model: string
  usage: Record<string, unknown> | null
  parentRevisionId: string | null
  restoredFromRevisionId: string | null
  sourceKind: RevisionSourceKind
  createdAt: string
  sourceSnapshot: {
    id: string
    objectPrefix: string
    snapshotDate: string
  } | null
  expectedBundleHash: string
}

export async function prepareGenerationPublication(input: {
  runId: string
  prompt: string
  artifact: DashboardArtifactV1
  artifactHash: string
  results: Map<string, QueryExecutionResult>
  model: string
  usage?: Record<string, unknown>
  expectedHead: string | null
  dashboardId?: string
  baseRevisionId?: string
}): Promise<PreparedPublication> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const dashboardId = input.dashboardId ?? createId()
    let revisionNumber = 1
    let contentPath: string
    let parentRevisionId: string | null = null
    if (input.dashboardId) {
      const current = await client.query<{ current_revision_id: string; revision_number: number; content_path: string }>(`
        SELECT d.current_revision_id, r.revision_number, d.content_path
        FROM dashboards d JOIN dashboard_revisions r ON r.id = d.current_revision_id
        WHERE d.id = $1 FOR UPDATE
      `, [dashboardId])
      const row = current.rows[0]
      if (!row) throw new Error('Dashboard not found')
      if (!input.baseRevisionId || row.current_revision_id !== input.baseRevisionId) {
        const error = new Error('Dashboard changed after this refinement started')
        error.name = 'StaleRevisionError'
        throw error
      }
      revisionNumber = row.revision_number + 1
      parentRevisionId = row.current_revision_id
      contentPath = row.content_path
    } else {
      contentPath = dashboardContentPath(input.artifact.title, dashboardId)
      const slug = contentPath.slice('dashboards/'.length)
      await client.query(`
        INSERT INTO dashboards(id, slug, title, summary, content_path)
        VALUES ($1, $2, $3, $4, $5)
      `, [dashboardId, slug, input.artifact.title, input.artifact.summary, contentPath])
    }

    const revisionId = createId()
    const publicationId = createId()
    await client.query(`
      INSERT INTO dashboard_revisions(
        id, dashboard_id, revision_number, parent_revision_id, prompt, artifact, model, usage,
        publication_status, source_kind, artifact_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'agent', $9)
    `, [revisionId, dashboardId, revisionNumber, parentRevisionId, input.prompt, JSON.stringify(input.artifact), input.model, input.usage ? JSON.stringify(input.usage) : null, input.artifactHash])

    for (const [datasetId, result] of input.results) {
      const summary = await writeSummary({
        dashboardId,
        datasetId,
        revisionId,
        asOf: result.snapshot.snapshotDate,
      }, result.columns, result.rows)
      await client.query(`
        INSERT INTO query_result_snapshots(
          id, revision_id, dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id
        ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)
      `, [createId(), revisionId, datasetId, JSON.stringify(result.columns), result.rowCount, result.truncated, result.snapshot.id, summary.objectPrefix, summary.versionId])
    }
    await client.query(`
      INSERT INTO content_publications(
        id, revision_id, run_id, dashboard_id, expected_head, expected_base_revision_id,
        expected_bundle_hash, status, journal
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'prepared', $8)
    `, [publicationId, revisionId, input.runId, dashboardId, input.expectedHead, parentRevisionId, input.artifactHash, JSON.stringify({ phase: 'prepared' })])
    await client.query(`
      UPDATE generation_runs
      SET dashboard_id = $2, revision_id = $3, status = 'publishing'
      WHERE id = $1
    `, [input.runId, dashboardId, revisionId])
    await client.query('COMMIT')
    const prepared = await getPreparedPublication(publicationId)
    if (!prepared) throw new Error('Prepared publication could not be reloaded')
    return prepared
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function prepareManualPublication(input: {
  dashboardId: string
  contentPath: string
  note: string
  artifact: DashboardArtifactV1
  artifactHash: string
  results: Map<string, QueryExecutionResult>
  expectedHead: string
  sourceCommitSha: string | null
}): Promise<PreparedPublication> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query<{ current_revision_id: string | null; revision_number: number | null; content_path: string | null }>(`
      SELECT d.current_revision_id, r.revision_number, d.content_path
      FROM dashboards d LEFT JOIN dashboard_revisions r ON r.id = d.current_revision_id
      WHERE d.id = $1 FOR UPDATE OF d
    `, [input.dashboardId])
    const existing = current.rows[0]
    let revisionNumber = 1
    let parentRevisionId: string | null = null
    if (existing) {
      if (existing.content_path && existing.content_path !== input.contentPath) throw new Error('Dashboard directory renaming is not supported')
      if (!existing.current_revision_id || !existing.revision_number) throw new Error('Dashboard has no published base revision')
      revisionNumber = existing.revision_number + 1
      parentRevisionId = existing.current_revision_id
    } else {
      const slug = input.contentPath.slice('dashboards/'.length)
      await client.query(`INSERT INTO dashboards(id, slug, title, summary, content_path) VALUES ($1, $2, $3, $4, $5)`, [input.dashboardId, slug, input.artifact.title, input.artifact.summary, input.contentPath])
    }
    const revisionId = createId()
    const publicationId = createId()
    await client.query(`
      INSERT INTO dashboard_revisions(
        id, dashboard_id, revision_number, parent_revision_id, prompt, artifact, model,
        publication_status, source_kind, git_source_commit_sha, artifact_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, 'external-editor', 'pending', 'manual', $7, $8)
    `, [revisionId, input.dashboardId, revisionNumber, parentRevisionId, input.note, JSON.stringify(input.artifact), input.sourceCommitSha, input.artifactHash])
    for (const [datasetId, result] of input.results) {
      const summary = await writeSummary({
        dashboardId: input.dashboardId,
        datasetId,
        revisionId,
        asOf: result.snapshot.snapshotDate,
      }, result.columns, result.rows)
      await client.query(`
        INSERT INTO query_result_snapshots(id, revision_id, dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id)
        VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)
      `, [createId(), revisionId, datasetId, JSON.stringify(result.columns), result.rowCount, result.truncated, result.snapshot.id, summary.objectPrefix, summary.versionId])
    }
    await client.query(`
      INSERT INTO content_publications(id, revision_id, dashboard_id, expected_head, expected_base_revision_id, expected_bundle_hash, status, journal)
      VALUES ($1, $2, $3, $4, $5, $6, 'prepared', $7)
    `, [publicationId, revisionId, input.dashboardId, input.expectedHead, parentRevisionId, input.artifactHash, JSON.stringify({ phase: 'prepared', manual: true })])
    await client.query('COMMIT')
    const prepared = await getPreparedPublication(publicationId)
    if (!prepared) throw new Error('Manual publication could not be reloaded')
    return prepared
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getRestoreSource(dashboardId: string, sourceRevisionId: string): Promise<{
  artifact: DashboardArtifactV1
  artifactHash: string | null
  gitCommitSha: string | null
  gitTreeSha: string | null
  model: string
}> {
  const result = await pool.query<{ artifact: DashboardArtifactV1; artifact_hash: string | null; git_commit_sha: string | null; git_tree_sha: string | null; model: string }>(`
    SELECT artifact, artifact_hash, git_commit_sha, git_tree_sha, model FROM dashboard_revisions
    WHERE id = $1 AND dashboard_id = $2 AND publication_status = 'published'
  `, [sourceRevisionId, dashboardId])
  const row = result.rows[0]
  if (!row) throw new Error('Dashboard revision not found')
  return { artifact: row.artifact, artifactHash: row.artifact_hash, gitCommitSha: row.git_commit_sha, gitTreeSha: row.git_tree_sha, model: row.model }
}

export async function prepareRestorePublication(input: {
  dashboardId: string
  sourceRevisionId: string
  artifact: DashboardArtifactV1
  artifactHash: string
  expectedHead: string
}): Promise<PreparedPublication> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query<{ current_revision_id: string; revision_number: number }>(`
      SELECT d.current_revision_id, r.revision_number FROM dashboards d
      JOIN dashboard_revisions r ON r.id = d.current_revision_id WHERE d.id = $1 FOR UPDATE
    `, [input.dashboardId])
    const row = current.rows[0]
    if (!row) throw new Error('Dashboard revision not found')
    const revisionId = createId()
    const publicationId = createId()
    await client.query(`
      INSERT INTO dashboard_revisions(
        id, dashboard_id, revision_number, parent_revision_id, restored_from_revision_id,
        prompt, artifact, model, publication_status, source_kind, artifact_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'fieldboard-restore', 'pending', 'restore', $8)
    `, [revisionId, input.dashboardId, row.revision_number + 1, row.current_revision_id, input.sourceRevisionId, `Restore revision ${input.sourceRevisionId.slice(0, 8)}`, JSON.stringify(input.artifact), input.artifactHash])
    await client.query(`
      INSERT INTO query_result_snapshots(id, revision_id, dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id)
      SELECT gen_random_uuid(), $1, dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id
      FROM (
        SELECT DISTINCT ON (dataset_id) dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id
        FROM query_result_snapshots WHERE revision_id = $2 ORDER BY dataset_id, created_at DESC
      ) latest
    `, [revisionId, input.sourceRevisionId])
    await client.query(`
      INSERT INTO content_publications(id, revision_id, dashboard_id, expected_head, expected_base_revision_id, expected_bundle_hash, status, journal)
      VALUES ($1, $2, $3, $4, $5, $6, 'prepared', $7)
    `, [publicationId, revisionId, input.dashboardId, input.expectedHead, row.current_revision_id, input.artifactHash, JSON.stringify({ phase: 'prepared', restore: true })])
    await client.query('COMMIT')
    const prepared = await getPreparedPublication(publicationId)
    if (!prepared) throw new Error('Restore publication could not be reloaded')
    return prepared
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getPreparedPublication(id: string): Promise<PreparedPublication | null> {
  const result = await pool.query<{
    id: string
    dashboard_id: string
    revision_id: string
    revision_number: number
    run_id: string | null
    status: ContentPublicationSummary['status']
    expected_head: string | null
    expected_base_revision_id: string | null
    expected_bundle_hash: string
    commit_sha: string | null
    retry_count: number
    error: string | null
    created_at: Date
    updated_at: Date
    artifact: DashboardArtifactV1
    content_path: string
    prompt: string
    model: string
    usage: Record<string, unknown> | null
    parent_revision_id: string | null
    restored_from_revision_id: string | null
    source_kind: RevisionSourceKind
    source_snapshot_id: string | null
    object_prefix: string | null
    snapshot_date: string | null
  }>(`
    SELECT p.id, p.dashboard_id, p.revision_id, r.revision_number, p.run_id, p.status,
           p.expected_head, p.expected_base_revision_id, p.expected_bundle_hash, p.commit_sha,
           p.retry_count, p.error, p.created_at, p.updated_at, r.artifact, d.content_path,
           r.prompt, r.model, r.usage, r.parent_revision_id, r.restored_from_revision_id,
           r.source_kind, q.source_snapshot_id, s.object_prefix, s.snapshot_date::text
    FROM content_publications p
    JOIN dashboard_revisions r ON r.id = p.revision_id
    JOIN dashboards d ON d.id = p.dashboard_id
    LEFT JOIN LATERAL (
      SELECT source_snapshot_id FROM query_result_snapshots
      WHERE revision_id = r.id ORDER BY created_at DESC LIMIT 1
    ) q ON true
    LEFT JOIN data_snapshots s ON s.id = q.source_snapshot_id
    WHERE p.id = $1
  `, [id])
  const row = result.rows[0]
  return row ? {
    id: row.id,
    dashboardId: row.dashboard_id,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    runId: row.run_id,
    status: row.status,
    expectedHead: row.expected_head,
    commitSha: row.commit_sha,
    attemptCount: row.retry_count,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    artifact: row.artifact,
    contentPath: row.content_path,
    prompt: row.prompt,
    model: row.model,
    usage: row.usage,
    parentRevisionId: row.parent_revision_id,
    restoredFromRevisionId: row.restored_from_revision_id,
    sourceKind: row.source_kind,
    sourceSnapshot: row.source_snapshot_id && row.object_prefix && row.snapshot_date ? {
      id: row.source_snapshot_id,
      objectPrefix: row.object_prefix,
      snapshotDate: row.snapshot_date,
    } : null,
    expectedBundleHash: row.expected_bundle_hash,
  } : null
}

export async function getDashboardCurrentRevisionId(dashboardId: string): Promise<string | null> {
  const result = await pool.query<{ current_revision_id: string | null }>('SELECT current_revision_id FROM dashboards WHERE id = $1', [dashboardId])
  return result.rows[0]?.current_revision_id ?? null
}

export async function getDashboardContentPath(dashboardId: string): Promise<string | null> {
  const result = await pool.query<{ content_path: string | null }>('SELECT content_path FROM dashboards WHERE id = $1', [dashboardId])
  return result.rows[0]?.content_path ?? null
}

function mapPublication(row: {
  id: string
  dashboard_id: string
  revision_id: string
  revision_number: number
  run_id: string | null
  status: ContentPublicationSummary['status']
  expected_head: string | null
  commit_sha: string | null
  retry_count: number
  error: string | null
  created_at: Date
  updated_at: Date
}): ContentPublicationSummary {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    runId: row.run_id,
    status: row.status,
    expectedHead: row.expected_head,
    commitSha: row.commit_sha,
    attemptCount: row.retry_count,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function getPublication(id: string): Promise<ContentPublicationSummary | null> {
  const result = await pool.query<Parameters<typeof mapPublication>[0]>(`
    SELECT p.id, p.dashboard_id, p.revision_id, r.revision_number, p.run_id, p.status,
           p.expected_head, p.commit_sha, p.retry_count, p.error, p.created_at, p.updated_at
    FROM content_publications p JOIN dashboard_revisions r ON r.id = p.revision_id
    WHERE p.id = $1
  `, [id])
  return result.rows[0] ? mapPublication(result.rows[0]) : null
}

export async function listBlockedPublications(): Promise<ContentPublicationSummary[]> {
  const result = await pool.query<Parameters<typeof mapPublication>[0]>(`
    SELECT p.id, p.dashboard_id, p.revision_id, r.revision_number, p.run_id, p.status,
           p.expected_head, p.commit_sha, p.retry_count, p.error, p.created_at, p.updated_at
    FROM content_publications p JOIN dashboard_revisions r ON r.id = p.revision_id
    WHERE p.status IN ('prepared', 'publishing', 'committed', 'blocked')
    ORDER BY p.created_at
  `)
  return result.rows.map(mapPublication)
}

export async function addPublicationEvent(publicationId: string, type: string, message: string, payload?: Record<string, unknown>): Promise<void> {
  await pool.query(`
    INSERT INTO content_publication_events(publication_id, event_type, message, payload)
    VALUES ($1, $2, $3, $4)
  `, [publicationId, type, message, payload ? JSON.stringify(payload) : null])
}

export async function listPublicationEvents(publicationId: string, afterId = 0): Promise<ContentLifecycleEvent[]> {
  const result = await pool.query<{ id: number; event_type: string; message: string; payload: Record<string, unknown> | null; created_at: Date }>(`
    SELECT id, event_type, message, payload, created_at FROM content_publication_events
    WHERE publication_id = $1 AND id > $2 ORDER BY id
  `, [publicationId, afterId])
  return result.rows.map((row) => ({ id: row.id, type: row.event_type, message: row.message, ...(row.payload ? { payload: row.payload } : {}), createdAt: row.created_at.toISOString() }))
}

export async function markPublicationPublishing(id: string): Promise<void> {
  await pool.query(`UPDATE content_publications SET status = 'publishing', retry_count = retry_count + 1, error = NULL, updated_at = now(), journal = jsonb_set(journal, '{phase}', '"publishing"') WHERE id = $1`, [id])
  await pool.query(`UPDATE dashboard_revisions SET publication_status = 'pending', publication_error = NULL WHERE id = (SELECT revision_id FROM content_publications WHERE id = $1)`, [id])
  await pool.query(`UPDATE generation_runs SET status = 'publishing', error = NULL WHERE id = (SELECT run_id FROM content_publications WHERE id = $1)`, [id])
}

export async function retargetBlockedPublication(id: string, newHead: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{ dashboard_id: string; expected_base_revision_id: string | null; status: string }>(`
      SELECT dashboard_id, expected_base_revision_id, status FROM content_publications WHERE id = $1 FOR UPDATE
    `, [id])
    const publication = result.rows[0]
    if (!publication || publication.status !== 'blocked') throw new Error('Only a blocked publication may be retried')
    const current = await client.query<{ current_revision_id: string | null }>('SELECT current_revision_id FROM dashboards WHERE id = $1', [publication.dashboard_id])
    if ((current.rows[0]?.current_revision_id ?? null) !== publication.expected_base_revision_id) {
      const error = new Error('The dashboard authored base changed. Start a new refinement from the current revision.')
      error.name = 'StaleRevisionError'
      throw error
    }
    await client.query(`UPDATE content_publications SET expected_head = $2, status = 'prepared', error = NULL, updated_at = now() WHERE id = $1`, [id, newHead])
    await client.query(`UPDATE dashboard_revisions SET publication_status = 'pending', publication_error = NULL WHERE id = (SELECT revision_id FROM content_publications WHERE id = $1)`, [id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function markPublicationCommitted(id: string, commitSha: string): Promise<void> {
  await pool.query(`UPDATE content_publications SET status = 'committed', commit_sha = $2, updated_at = now(), journal = jsonb_set(journal, '{phase}', '"committed"') WHERE id = $1`, [id, commitSha])
}

export async function completePublication(id: string, commitSha: string, treeSha: string, artifactHash: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{ dashboard_id: string; revision_id: string; run_id: string | null; artifact: DashboardArtifactV1 }>(`
      SELECT p.dashboard_id, p.revision_id, p.run_id, r.artifact
      FROM content_publications p JOIN dashboard_revisions r ON r.id = p.revision_id
      WHERE p.id = $1 FOR UPDATE
    `, [id])
    const row = result.rows[0]
    if (!row) throw new Error('Publication not found')
    await client.query(`
      UPDATE dashboard_revisions SET publication_status = 'published', git_commit_sha = $2,
        git_tree_sha = $3, artifact_hash = $4, published_at = now(), publication_error = NULL
      WHERE id = $1
    `, [row.revision_id, commitSha, treeSha, artifactHash])
    await client.query(`
      UPDATE dashboards SET current_revision_id = $2, title = $3, summary = $4, updated_at = now()
      WHERE id = $1
    `, [row.dashboard_id, row.revision_id, row.artifact.title, row.artifact.summary])
    await client.query(`
      UPDATE content_publications SET status = 'published', commit_sha = $2, error = NULL,
        updated_at = now(), journal = jsonb_set(journal, '{phase}', '"published"') WHERE id = $1
    `, [id, commitSha])
    if (row.run_id) await client.query(`UPDATE generation_runs SET status = 'completed', error = NULL, completed_at = now() WHERE id = $1`, [row.run_id])
    await client.query(`
      UPDATE content_repository_state SET current_head = $1, last_indexed_head = $1,
        readiness_state = 'ready', last_successful_scan = now(), last_error = NULL, updated_at = now()
      WHERE singleton
    `, [commitSha])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function blockPublication(id: string, message: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{ revision_id: string; run_id: string | null }>(`
      UPDATE content_publications SET status = 'blocked', error = $2, updated_at = now(),
        journal = jsonb_set(journal, '{phase}', '"blocked"') WHERE id = $1
      RETURNING revision_id, run_id
    `, [id, message])
    const row = result.rows[0]
    if (row) {
      await client.query(`UPDATE dashboard_revisions SET publication_status = 'blocked', publication_error = $2 WHERE id = $1`, [row.revision_id, message])
      if (row.run_id) await client.query(`UPDATE generation_runs SET status = 'publication_blocked', error = $2 WHERE id = $1`, [row.run_id, message])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getRepositoryDatabaseState(): Promise<{
  activated: boolean
  indexedHead: string | null
  lastSuccessfulScan: string | null
  error: string | null
}> {
  const result = await pool.query<{ activated: boolean; last_indexed_head: string | null; last_successful_scan: Date | null; last_error: string | null }>(`
    SELECT activated, last_indexed_head, last_successful_scan, last_error
    FROM content_repository_state WHERE singleton
  `)
  const row = result.rows[0]
  return {
    activated: row?.activated ?? false,
    indexedHead: row?.last_indexed_head ?? null,
    lastSuccessfulScan: row?.last_successful_scan?.toISOString() ?? null,
    error: row?.last_error ?? null,
  }
}

export async function setRepositoryState(input: { head: string | null; indexedHead?: string | null; readiness: string; activated?: boolean; error?: string | null }): Promise<void> {
  await pool.query(`
    UPDATE content_repository_state SET current_head = $1,
      last_indexed_head = COALESCE($2, last_indexed_head), readiness_state = $3,
      activated = COALESCE($4, activated), last_error = $5,
      last_successful_scan = CASE WHEN $3 = 'ready' THEN now() ELSE last_successful_scan END,
      updated_at = now() WHERE singleton
  `, [input.head, input.indexedHead ?? null, input.readiness, input.activated ?? null, input.error ?? null])
}

export interface IndexedRevisionRecord {
  dashboardId: string
  contentPath: string
  revisionId: string
  revisionNumber: number
  parentRevisionId: string | null
  restoredFromRevisionId: string | null
  sourceKind: RevisionSourceKind
  note: string
  model: string
  generatedAt: string
  artifact: DashboardArtifactV1
  artifactHash: string
  commitSha: string
  treeSha: string
  isHead: boolean
}

export async function dashboardExists(dashboardId: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM dashboards WHERE id = $1', [dashboardId])
  return Boolean(result.rows[0])
}

export async function applyContentIndex(input: {
  head: string
  /**
   * What to record as last_indexed_head. Pass null to leave it where it was, which keeps the
   * repository reported as unindexed so the next pass retries the same range instead of
   * declaring an incomplete projection current.
   */
  indexedHead: string | null
  mode: 'full' | 'incremental'
  headPaths: string[]
  revisions: IndexedRevisionRecord[]
  readiness: string
  error: string | null
}): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await pruneMissingDashboards(client, input.headPaths, input.mode)
    const ordered = [...input.revisions].sort((left, right) => {
      const dashboard = left.dashboardId.localeCompare(right.dashboardId)
      return dashboard !== 0 ? dashboard : left.revisionNumber - right.revisionNumber
    })
    const dashboardIds = [...new Set(ordered.map((item) => item.dashboardId))]
    const keepRevisionIds = [...new Set(ordered.map((item) => item.revisionId))]
    if (input.mode === 'full') {
      await replaceOccupyingDashboards(client, input.headPaths, dashboardIds)
    }
    if (input.mode === 'full' && dashboardIds.length) {
      await client.query(`UPDATE dashboards SET current_revision_id = NULL WHERE id = ANY($1::uuid[])`, [dashboardIds])
      await client.query(`
        DELETE FROM dashboard_revisions
        WHERE dashboard_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))
      `, [dashboardIds, keepRevisionIds])
    }
    for (const revision of ordered) {
      const slug = revision.contentPath.slice('dashboards/'.length)
      const parentRevisionId = await livingRevisionId(client, revision.parentRevisionId, keepRevisionIds)
      const restoredFromRevisionId = await livingRevisionId(client, revision.restoredFromRevisionId, keepRevisionIds)
      await client.query(`
        INSERT INTO dashboards(id, slug, title, summary, content_path)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          slug = EXCLUDED.slug, title = EXCLUDED.title, summary = EXCLUDED.summary,
          content_path = EXCLUDED.content_path, updated_at = now()
      `, [revision.dashboardId, slug, revision.artifact.title, revision.artifact.summary, revision.contentPath])
      await client.query(`
        INSERT INTO dashboard_revisions(
          id, dashboard_id, revision_number, parent_revision_id, restored_from_revision_id,
          prompt, artifact, model, publication_status, source_kind,
          git_commit_sha, git_tree_sha, artifact_hash, published_at, publication_error
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published', $9, $10, $11, $12, $13::timestamptz, NULL)
        ON CONFLICT (id) DO UPDATE SET
          dashboard_id = EXCLUDED.dashboard_id,
          revision_number = EXCLUDED.revision_number,
          parent_revision_id = EXCLUDED.parent_revision_id,
          restored_from_revision_id = EXCLUDED.restored_from_revision_id,
          prompt = EXCLUDED.prompt,
          artifact = EXCLUDED.artifact,
          model = EXCLUDED.model,
          publication_status = 'published',
          source_kind = EXCLUDED.source_kind,
          git_commit_sha = EXCLUDED.git_commit_sha,
          git_tree_sha = EXCLUDED.git_tree_sha,
          artifact_hash = EXCLUDED.artifact_hash,
          published_at = COALESCE(dashboard_revisions.published_at, EXCLUDED.published_at),
          publication_error = NULL
      `, [
        revision.revisionId, revision.dashboardId, revision.revisionNumber,
        parentRevisionId, restoredFromRevisionId, revision.note,
        JSON.stringify(revision.artifact), revision.model, revision.sourceKind,
        revision.commitSha, revision.treeSha, revision.artifactHash, revision.generatedAt,
      ])
    }
    for (const revision of ordered.filter((item) => item.isHead)) {
      await client.query(`
        UPDATE dashboards SET current_revision_id = $2, title = $3, summary = $4, content_path = $5, updated_at = now()
        WHERE id = $1
      `, [revision.dashboardId, revision.revisionId, revision.artifact.title, revision.artifact.summary, revision.contentPath])
    }
    await client.query(`
      UPDATE content_repository_state SET current_head = $1,
        last_indexed_head = COALESCE($2, last_indexed_head),
        readiness_state = $3, activated = true,
        last_successful_scan = CASE WHEN $4::text IS NULL THEN now() ELSE last_successful_scan END,
        last_error = $4, updated_at = now()
      WHERE singleton
    `, [input.head, input.indexedHead, input.readiness, input.error])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function replaceOccupyingDashboards(
  client: { query: typeof pool.query },
  headPaths: string[],
  incomingDashboardIds: string[],
): Promise<void> {
  await client.query(`
    UPDATE generation_runs SET dashboard_id = NULL, revision_id = NULL, base_revision_id = NULL
    WHERE dashboard_id IN (
      SELECT id FROM dashboards
      WHERE content_path = ANY($1::text[])
        AND (cardinality($2::uuid[]) = 0 OR NOT (id = ANY($2::uuid[])))
    )
  `, [headPaths, incomingDashboardIds])
  await client.query(`
    UPDATE dashboards SET current_revision_id = NULL
    WHERE content_path = ANY($1::text[])
      AND (cardinality($2::uuid[]) = 0 OR NOT (id = ANY($2::uuid[])))
  `, [headPaths, incomingDashboardIds])
  await client.query(`
    DELETE FROM dashboards
    WHERE content_path = ANY($1::text[])
      AND (cardinality($2::uuid[]) = 0 OR NOT (id = ANY($2::uuid[])))
  `, [headPaths, incomingDashboardIds])
}

async function livingRevisionId(
  client: { query: typeof pool.query },
  revisionId: string | null,
  keepRevisionIds: string[],
): Promise<string | null> {
  if (!revisionId) return null
  if (keepRevisionIds.includes(revisionId)) return revisionId
  const result = await client.query('SELECT 1 FROM dashboard_revisions WHERE id = $1', [revisionId])
  return result.rows[0] ? revisionId : null
}

async function pruneMissingDashboards(
  client: { query: typeof pool.query },
  headPaths: string[],
  mode: 'full' | 'incremental',
): Promise<void> {
  const pendingGuard = mode === 'full' ? '' : `
      AND NOT EXISTS (
        SELECT 1 FROM dashboard_revisions r
        WHERE r.dashboard_id = d.id AND r.publication_status = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM content_publications p
        WHERE p.dashboard_id = d.id AND p.status IN ('prepared', 'publishing', 'committed', 'blocked')
      )`
  await client.query(`
    UPDATE generation_runs SET dashboard_id = NULL, revision_id = NULL, base_revision_id = NULL
    WHERE dashboard_id IN (
      SELECT d.id FROM dashboards d
      WHERE (d.content_path IS NULL OR NOT (d.content_path = ANY($1::text[])))
      ${pendingGuard}
    )
  `, [headPaths])
  await client.query(`
    UPDATE dashboards d SET current_revision_id = NULL
    WHERE (d.content_path IS NULL OR NOT (d.content_path = ANY($1::text[])))
    ${pendingGuard}
  `, [headPaths])
  await client.query(`
    DELETE FROM dashboards d
    WHERE (d.content_path IS NULL OR NOT (d.content_path = ANY($1::text[])))
    ${pendingGuard}
  `, [headPaths])
}

export async function listHeadRevisionsMissingSummaries(): Promise<Array<{
  dashboardId: string
  revisionId: string
  artifact: DashboardArtifactV1
}>> {
  const result = await pool.query<{ dashboard_id: string; revision_id: string; artifact: DashboardArtifactV1; dataset_count: number; summary_count: number }>(`
    SELECT d.id AS dashboard_id, r.id AS revision_id, r.artifact,
      jsonb_array_length(r.artifact->'datasets') AS dataset_count,
      (
        SELECT count(DISTINCT q.dataset_id)::int FROM query_result_snapshots q WHERE q.revision_id = r.id
      ) AS summary_count
    FROM dashboards d
    JOIN dashboard_revisions r ON r.id = d.current_revision_id
    WHERE r.publication_status = 'published'
  `)
  return result.rows
    .filter((row) => row.summary_count < row.dataset_count)
    .map((row) => ({ dashboardId: row.dashboard_id, revisionId: row.revision_id, artifact: row.artifact }))
}

export async function revisionHasSummaries(revisionId: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM query_result_snapshots WHERE revision_id = $1) AS present
  `, [revisionId])
  return Boolean(result.rows[0]?.present)
}

export async function createValidationRun(input: { expectedHead: string | null; fingerprint: string; affectedDashboards: string[] }): Promise<string> {
  const id = createId()
  await pool.query(`
    INSERT INTO content_validation_runs(id, expected_head, repository_fingerprint, status, affected_dashboards)
    VALUES ($1, $2, $3, 'queued', $4)
  `, [id, input.expectedHead, input.fingerprint, JSON.stringify(input.affectedDashboards)])
  await addValidationEvent(id, 'queued', 'Repository validation queued.')
  return id
}

export async function addValidationEvent(validationId: string, type: string, message: string, payload?: Record<string, unknown>): Promise<void> {
  await pool.query(`INSERT INTO content_validation_events(validation_id, event_type, message, payload) VALUES ($1, $2, $3, $4)`, [validationId, type, message, payload ? JSON.stringify(payload) : null])
}

export async function listValidationEvents(validationId: string, afterId = 0): Promise<ContentLifecycleEvent[]> {
  const result = await pool.query<{ id: number; event_type: string; message: string; payload: Record<string, unknown> | null; created_at: Date }>(`
    SELECT id, event_type, message, payload, created_at FROM content_validation_events
    WHERE validation_id = $1 AND id > $2 ORDER BY id
  `, [validationId, afterId])
  return result.rows.map((row) => ({ id: row.id, type: row.event_type, message: row.message, ...(row.payload ? { payload: row.payload } : {}), createdAt: row.created_at.toISOString() }))
}

export async function getValidationRun(id: string): Promise<ContentValidationRun | null> {
  const result = await pool.query<{
    id: string; status: ContentValidationRun['status']; expected_head: string | null; repository_fingerprint: string
    affected_dashboards: string[]; validation_errors: string[]; expires_at: Date | null; created_at: Date; completed_at: Date | null
  }>(`SELECT id, status, expected_head, repository_fingerprint, affected_dashboards, validation_errors, expires_at, created_at, completed_at FROM content_validation_runs WHERE id = $1`, [id])
  const row = result.rows[0]
  return row ? { id: row.id, status: row.status, expectedHead: row.expected_head, fingerprint: row.repository_fingerprint, affectedDashboards: row.affected_dashboards, errors: row.validation_errors, expiresAt: row.expires_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null } : null
}

export async function setValidationRunning(id: string): Promise<void> {
  await pool.query(`UPDATE content_validation_runs SET status = 'running' WHERE id = $1`, [id])
}

export async function completeValidation(id: string, candidatePayload: unknown): Promise<void> {
  await pool.query(`UPDATE content_validation_runs SET status = 'valid', candidate_payload = $2, validation_errors = '[]', expires_at = now() + interval '20 minutes', completed_at = now() WHERE id = $1`, [id, JSON.stringify(candidatePayload)])
}

export async function failValidation(id: string, errors: string[]): Promise<void> {
  await pool.query(`UPDATE content_validation_runs SET status = 'invalid', validation_errors = $2, completed_at = now() WHERE id = $1`, [id, JSON.stringify(errors)])
}

export async function getValidationPayload(id: string): Promise<unknown | null> {
  const result = await pool.query<{ candidate_payload: unknown }>('SELECT candidate_payload FROM content_validation_runs WHERE id = $1', [id])
  return result.rows[0]?.candidate_payload ?? null
}

export async function markValidationImported(id: string): Promise<void> {
  await pool.query(`UPDATE content_validation_runs SET status = 'imported' WHERE id = $1`, [id])
}
