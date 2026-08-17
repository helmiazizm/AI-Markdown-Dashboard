import type {
  DashboardArtifactV1,
  DashboardDetail,
  DashboardListItem,
  DashboardRevisionSummary,
  GenerationEvent,
  GenerationDetailLevel,
  GenerationStatus,
  QueryResultSnapshot,
} from '@fieldboard/contracts'
import type { QueryExecutionResult } from '../data/query-service.js'
import { readSummary, writeSummary } from '../data/summary-store.js'
import { createId } from '../lib/ids.js'
import { pool } from './pool.js'

export async function createGenerationRun(input: {
  mode: 'create' | 'refine'
  prompt: string
  detailLevel: GenerationDetailLevel
  model: string
  pipeline: string
  dashboardId?: string
  baseRevisionId?: string
}): Promise<string> {
  const id = createId()
  await pool.query(`
    INSERT INTO generation_runs(id, dashboard_id, base_revision_id, mode, prompt, detail_level, status, model)
    VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
  `, [id, input.dashboardId ?? null, input.baseRevisionId ?? null, input.mode, input.prompt, input.detailLevel, input.model])
  await addGenerationEvent(id, 'queued', 'Prompt received. Assembling the analysis crew.', input.detailLevel === 'detailed'
    ? { kind: 'run_config', detailLevel: input.detailLevel, pipeline: input.pipeline, model: input.model }
    : undefined)
  return id
}

export async function addGenerationEvent(
  runId: string,
  type: GenerationEvent['type'],
  message: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await pool.query(`
    INSERT INTO generation_run_events(run_id, event_type, message, payload)
    VALUES ($1, $2, $3, $4)
  `, [runId, type, message, payload ? JSON.stringify(payload) : null])
}

export async function listGenerationEvents(runId: string, afterId = 0): Promise<GenerationEvent[]> {
  const result = await pool.query<{
    id: number
    event_type: GenerationEvent['type']
    message: string
    created_at: Date
    payload: Record<string, unknown> | null
  }>(`
    SELECT id, event_type, message, created_at, payload
    FROM generation_run_events
    WHERE run_id = $1 AND id > $2
    ORDER BY id
  `, [runId, afterId])
  return result.rows.map((row) => ({
    id: row.id,
    type: row.event_type,
    message: row.message,
    createdAt: row.created_at.toISOString(),
    ...(row.payload ? { payload: row.payload } : {}),
  }))
}

export async function getGenerationRun(id: string): Promise<GenerationStatus | null> {
  const result = await pool.query<{
    id: string
    dashboard_id: string | null
    revision_id: string | null
    status: GenerationStatus['status']
    mode: GenerationStatus['mode']
    detail_level: GenerationDetailLevel
    prompt: string
    error: string | null
    created_at: Date
    completed_at: Date | null
    publication_id: string | null
  }>(`
    SELECT g.id, g.dashboard_id, g.revision_id, g.status, g.mode, g.detail_level, g.prompt,
           g.error, g.created_at, g.completed_at, p.id AS publication_id
    FROM generation_runs g LEFT JOIN content_publications p ON p.run_id = g.id
    WHERE g.id = $1
  `, [id])
  const row = result.rows[0]
  return row ? {
    id: row.id,
    dashboardId: row.dashboard_id,
    revisionId: row.revision_id,
    status: row.status,
    mode: row.mode,
    detailLevel: row.detail_level,
    prompt: row.prompt,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    publicationId: row.publication_id,
  } : null
}

export async function markGenerationRunning(id: string): Promise<void> {
  await pool.query(`UPDATE generation_runs SET status = 'running', started_at = now() WHERE id = $1`, [id])
}

export async function markGenerationFailed(id: string, error: string): Promise<void> {
  await pool.query(`
    UPDATE generation_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1
  `, [id, error])
  await addGenerationEvent(id, 'failed', error)
}

export async function recoverInterruptedGenerationRuns(): Promise<void> {
  const result = await pool.query<{ id: string }>(`
    UPDATE generation_runs SET status = 'failed', error = 'API restarted before the agent completed.', completed_at = now()
    WHERE status IN ('queued', 'running')
    RETURNING id
  `)
  for (const row of result.rows) await addGenerationEvent(row.id, 'failed', 'API restarted before the agent completed.')
}

export async function getCurrentRevision(dashboardId: string): Promise<{
  id: string
  artifact: DashboardArtifactV1
  revisionNumber: number
} | null> {
  const result = await pool.query<{
    id: string
    artifact: DashboardArtifactV1
    revision_number: number
  }>(`
    SELECT r.id, r.artifact, r.revision_number
    FROM dashboards d
    JOIN dashboard_revisions r ON r.id = d.current_revision_id
    WHERE d.id = $1
  `, [dashboardId])
  const row = result.rows[0]
  return row ? { id: row.id, artifact: row.artifact, revisionNumber: row.revision_number } : null
}

export async function listDashboards(cursor?: string, limit = 20): Promise<{
  items: DashboardListItem[]
  nextCursor: string | null
}> {
  const result = await pool.query<{
    id: string
    title: string
    summary: string
    prompt: string
    current_revision_id: string
    revision_number: number
    artifact: DashboardArtifactV1
    updated_at: Date
    content_path: string | null
    git_commit_sha: string | null
  }>(`
    SELECT d.id, d.title, d.summary, r.prompt, d.current_revision_id,
           r.revision_number, r.artifact, d.updated_at, d.content_path, r.git_commit_sha
    FROM dashboards d
    JOIN dashboard_revisions r ON r.id = d.current_revision_id
    WHERE ($1::timestamptz IS NULL OR d.updated_at < $1::timestamptz)
    ORDER BY d.updated_at DESC
    LIMIT $2
  `, [cursor ?? null, limit + 1])
  const hasMore = result.rows.length > limit
  const selected = result.rows.slice(0, limit)
  return {
    items: selected.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      prompt: row.prompt,
      currentRevisionId: row.current_revision_id,
      revisionNumber: row.revision_number,
      widgetCount: row.artifact.widgets.length,
      updatedAt: row.updated_at.toISOString(),
      contentPath: row.content_path,
      gitCommitSha: row.git_commit_sha,
    })),
    nextCursor: hasMore ? selected.at(-1)?.updated_at.toISOString() ?? null : null,
  }
}

export async function getDashboardDetail(dashboardId: string, revisionId?: string): Promise<DashboardDetail | null> {
  const dashboard = await pool.query<{ current_revision_id: string; content_path: string | null }>(
    'SELECT current_revision_id, content_path FROM dashboards WHERE id = $1',
    [dashboardId],
  )
  const currentRevisionId = dashboard.rows[0]?.current_revision_id
  if (!currentRevisionId) return null
  const selectedRevisionId = revisionId ?? currentRevisionId
  const revision = await pool.query<{
    id: string
    revision_number: number
    prompt: string
    artifact: DashboardArtifactV1
    created_at: Date
    restored_from_revision_id: string | null
    publication_status: DashboardRevisionSummary['publicationStatus']
    source_kind: DashboardRevisionSummary['sourceKind']
    git_commit_sha: string | null
    git_source_commit_sha: string | null
    artifact_hash: string | null
    publication_error: string | null
  }>(`
    SELECT id, revision_number, prompt, artifact, created_at, restored_from_revision_id,
           publication_status, source_kind, git_commit_sha, git_source_commit_sha,
           artifact_hash, publication_error
    FROM dashboard_revisions WHERE id = $1 AND dashboard_id = $2
  `, [selectedRevisionId, dashboardId])
  const selected = revision.rows[0]
  if (!selected) return null
  const [results, revisions] = await Promise.all([
    getLatestResults(selectedRevisionId),
    listRevisions(dashboardId),
  ])
  return {
    id: dashboardId,
    currentRevisionId,
    revision: mapRevision(selected),
    artifact: selected.artifact,
    results,
    revisions,
    contentPath: dashboard.rows[0]?.content_path ?? null,
  }
}

export async function listRevisions(dashboardId: string): Promise<DashboardRevisionSummary[]> {
  const result = await pool.query<{
    id: string
    revision_number: number
    prompt: string
    created_at: Date
    restored_from_revision_id: string | null
    publication_status: DashboardRevisionSummary['publicationStatus']
    source_kind: DashboardRevisionSummary['sourceKind']
    git_commit_sha: string | null
    git_source_commit_sha: string | null
    artifact_hash: string | null
    publication_error: string | null
  }>(`
    SELECT id, revision_number, prompt, created_at, restored_from_revision_id,
           publication_status, source_kind, git_commit_sha, git_source_commit_sha,
           artifact_hash, publication_error
    FROM dashboard_revisions WHERE dashboard_id = $1 ORDER BY revision_number DESC
  `, [dashboardId])
  return result.rows.map(mapRevision)
}

function mapRevision(row: {
  id: string
  revision_number: number
  prompt: string
  created_at: Date
  restored_from_revision_id: string | null
  publication_status: DashboardRevisionSummary['publicationStatus']
  source_kind: DashboardRevisionSummary['sourceKind']
  git_commit_sha: string | null
  git_source_commit_sha: string | null
  artifact_hash: string | null
  publication_error: string | null
}): DashboardRevisionSummary {
  return {
    id: row.id,
    revisionNumber: row.revision_number,
    prompt: row.prompt,
    createdAt: row.created_at.toISOString(),
    restoredFromRevisionId: row.restored_from_revision_id,
    publicationStatus: row.publication_status,
    sourceKind: row.source_kind,
    gitCommitSha: row.git_commit_sha,
    gitSourceCommitSha: row.git_source_commit_sha,
    artifactHash: row.artifact_hash,
    publicationError: row.publication_error,
  }
}

export async function getLatestResults(revisionId: string): Promise<QueryResultSnapshot[]> {
  const result = await pool.query<{
    id: string
    dataset_id: string
    columns: string[]
    rows: Record<string, unknown>[] | null
    row_count: number
    truncated: boolean
    created_at: Date
    source_snapshot_id: string
    warehouse_object_prefix: string
    snapshot_date: string
    summary_object_prefix: string | null
  }>(`
    SELECT DISTINCT ON (q.dataset_id)
      q.id, q.dataset_id, q.columns, q.rows, q.row_count, q.truncated, q.created_at,
      s.id AS source_snapshot_id, s.object_prefix AS warehouse_object_prefix, s.snapshot_date::text,
      q.object_prefix AS summary_object_prefix
    FROM query_result_snapshots q
    JOIN data_snapshots s ON s.id = q.source_snapshot_id
    WHERE q.revision_id = $1
    ORDER BY q.dataset_id, q.created_at DESC
  `, [revisionId])
  return Promise.all(result.rows.map(async (row) => {
    const summaryRows = row.summary_object_prefix
      ? (await readSummary(row.summary_object_prefix)).rows
      : (row.rows ?? [])
    return {
      id: row.id,
      datasetId: row.dataset_id,
      columns: row.columns,
      rows: summaryRows,
      rowCount: row.row_count,
      truncated: row.truncated,
      createdAt: row.created_at.toISOString(),
      summaryObjectPrefix: row.summary_object_prefix,
      sourceSnapshot: {
        id: row.source_snapshot_id,
        objectPrefix: row.warehouse_object_prefix,
        snapshotDate: row.snapshot_date,
      },
    }
  }))
}

export async function appendQueryResult(
  revisionId: string,
  datasetId: string,
  result: QueryExecutionResult,
): Promise<void> {
  const dashboard = await pool.query<{ dashboard_id: string }>(`
    SELECT dashboard_id FROM dashboard_revisions WHERE id = $1
  `, [revisionId])
  const dashboardId = dashboard.rows[0]?.dashboard_id
  if (!dashboardId) throw new Error('Dashboard revision not found')
  const summary = await writeSummary({
    dashboardId,
    datasetId,
    revisionId,
    asOf: result.snapshot.snapshotDate,
  }, result.columns, result.rows)
  await pool.query(`
    INSERT INTO query_result_snapshots(
      id, revision_id, dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id
    ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)
  `, [createId(), revisionId, datasetId, JSON.stringify(result.columns), result.rowCount, result.truncated, result.snapshot.id, summary.objectPrefix, summary.versionId])
}
