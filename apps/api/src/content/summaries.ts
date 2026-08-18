import type { DashboardArtifactV1 } from '@fieldboard/contracts'
import { executeDatasetQuery } from '../data/query-service.js'
import { writeSummary } from '../data/summary-store.js'
import { createId } from '../lib/ids.js'
import { pool } from '../db/pool.js'
import { listHeadRevisionsMissingSummaries, revisionHasSummaries } from './persistence.js'

export async function listRevisionSummaryDatasetIds(revisionId: string): Promise<string[]> {
  const result = await pool.query<{ dataset_id: string }>(`
    SELECT DISTINCT dataset_id FROM query_result_snapshots WHERE revision_id = $1
  `, [revisionId])
  return result.rows.map((row) => row.dataset_id)
}

export async function ensureRevisionSummaries(input: {
  dashboardId: string
  revisionId: string
  artifact: DashboardArtifactV1
}): Promise<void> {
  const have = new Set(await listRevisionSummaryDatasetIds(input.revisionId))
  for (const dataset of input.artifact.datasets) {
    if (have.has(dataset.id)) continue
    const result = await executeDatasetQuery(dataset)
    const summary = await writeSummary({
      dashboardId: input.dashboardId,
      datasetId: dataset.id,
      revisionId: input.revisionId,
      asOf: result.snapshot.snapshotDate,
    }, result.columns, result.rows)
    await pool.query(`
      INSERT INTO query_result_snapshots(
        id, revision_id, dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id
      ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)
    `, [
      createId(), input.revisionId, dataset.id, JSON.stringify(result.columns),
      result.rowCount, result.truncated, result.snapshot.id, summary.objectPrefix, summary.versionId,
    ])
    have.add(dataset.id)
  }
}

export async function rematerializeMissingHeadSummaries(): Promise<string[]> {
  const errors: string[] = []
  for (const revision of await listHeadRevisionsMissingSummaries()) {
    try {
      await ensureRevisionSummaries(revision)
    } catch (error) {
      errors.push(`${revision.dashboardId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}

export { revisionHasSummaries }
