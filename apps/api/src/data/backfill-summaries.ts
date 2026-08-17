import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePools, pool } from '../db/pool.js'
import { createId } from '../lib/ids.js'
import { migrateAll } from '../db/migrate-all.js'
import { warehouseIdentityPrefix } from './warehouse.js'
import { readSummary, writeSummary } from './summary-store.js'

const NYC_DASHBOARD_ID = 'ff2e9c7e-8b98-4a46-b1f0-8dab754343a7'
const NYC_WAREHOUSE_SNAPSHOT_ID = '2530c522-2a5c-4b9c-a7b3-d05677a7c843'
const NYC_AS_OF = '2026-05-01'
const NYC_WAREHOUSE_ROWS = 108_891_604
const DEFAULT_AS_OF = '2026-03-19'

function asOfForDashboard(dashboardId: string): string {
  return dashboardId === NYC_DASHBOARD_ID ? NYC_AS_OF : DEFAULT_AS_OF
}

async function ensureNycWarehouseRevision(): Promise<string> {
  const profile = JSON.stringify({
    grain: 'One row is one TLC yellow taxi trip record.',
    historical: 'nyc-tlc',
    asOf: NYC_AS_OF,
  })
  await pool.query(`
    INSERT INTO data_snapshots(
      id, ingest_id, object_prefix, snapshot_date, row_count,
      country_count, category_count, status, active, dataset_name, relation_name, profile
    ) VALUES (
      $1, $2, $3, $4::date, $5,
      0, 0, 'ready', false, 'NYC TLC yellow taxi trips', 'catalog', $6::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      ingest_id = EXCLUDED.ingest_id,
      object_prefix = EXCLUDED.object_prefix,
      snapshot_date = EXCLUDED.snapshot_date,
      row_count = EXCLUDED.row_count,
      active = false,
      dataset_name = EXCLUDED.dataset_name,
      relation_name = 'catalog',
      profile = EXCLUDED.profile,
      status = 'ready'
  `, [
    NYC_WAREHOUSE_SNAPSHOT_ID,
    createId(),
    warehouseIdentityPrefix(NYC_WAREHOUSE_SNAPSHOT_ID),
    NYC_AS_OF,
    NYC_WAREHOUSE_ROWS,
    profile,
  ])
  await pool.query(`
    UPDATE data_snapshots SET active = true
    WHERE id = (
      SELECT id FROM data_snapshots
      WHERE status = 'ready' AND id <> $1 AND NOT EXISTS (SELECT 1 FROM data_snapshots WHERE active)
      ORDER BY created_at DESC
      LIMIT 1
    )
  `, [NYC_WAREHOUSE_SNAPSHOT_ID])
  return NYC_WAREHOUSE_SNAPSHOT_ID
}

async function retargetNycWarehouseRevision(snapshotId: string): Promise<void> {
  await pool.query(`
    UPDATE query_result_snapshots q
    SET source_snapshot_id = $2
    FROM dashboard_revisions r
    WHERE r.id = q.revision_id AND r.dashboard_id = $1
  `, [NYC_DASHBOARD_ID, snapshotId])
}

async function rematerializeDashboardSummaries(dashboardId: string, asOf: string): Promise<number> {
  const result = await pool.query<{
    id: string
    dataset_id: string
    columns: string[]
    revision_id: string
    object_prefix: string
  }>(`
    SELECT q.id, q.dataset_id, q.columns, q.revision_id, q.object_prefix
    FROM query_result_snapshots q
    JOIN dashboard_revisions r ON r.id = q.revision_id
    WHERE r.dashboard_id = $1
      AND q.object_prefix IS NOT NULL
      AND q.object_prefix NOT LIKE '%/as_of=' || $2
    ORDER BY q.created_at
  `, [dashboardId, asOf])
  for (const row of result.rows) {
    const stored = await readSummary(row.object_prefix)
    const columns = stored.columns.length ? stored.columns : row.columns
    const summary = await writeSummary({
      dashboardId,
      datasetId: row.dataset_id,
      revisionId: row.revision_id,
      asOf,
    }, columns, stored.rows)
    await pool.query(`
      UPDATE query_result_snapshots
      SET object_prefix = $2, version_id = $3
      WHERE id = $1
    `, [row.id, summary.objectPrefix, summary.versionId])
    console.log(`Rewrote ${row.dataset_id} for revision ${row.revision_id.slice(0, 8)} at ${summary.objectPrefix}`)
  }
  return result.rows.length
}

async function rewriteWarehouseIdentities(): Promise<void> {
  const result = await pool.query<{ id: string }>(`
    SELECT id FROM data_snapshots
    WHERE status = 'ready' AND object_prefix NOT LIKE 'warehouse:%'
  `)
  for (const row of result.rows) {
    await pool.query(`
      UPDATE data_snapshots SET object_prefix = $2 WHERE id = $1
    `, [row.id, warehouseIdentityPrefix(row.id)])
    console.log(`Rewrote warehouse identity ${warehouseIdentityPrefix(row.id)}`)
  }
}

export async function backfillSummaryParquet(): Promise<void> {
  await migrateAll()
  await rewriteWarehouseIdentities()
  const result = await pool.query<{
    id: string
    dataset_id: string
    columns: string[]
    rows: Record<string, unknown>[]
    revision_id: string
    dashboard_id: string
  }>(`
    SELECT q.id, q.dataset_id, q.columns, q.rows, q.revision_id, r.dashboard_id
    FROM query_result_snapshots q
    JOIN dashboard_revisions r ON r.id = q.revision_id
    WHERE q.object_prefix IS NULL AND q.rows IS NOT NULL
    ORDER BY q.created_at
  `)
  for (const row of result.rows) {
    const summary = await writeSummary({
      dashboardId: row.dashboard_id,
      datasetId: row.dataset_id,
      revisionId: row.revision_id,
      asOf: asOfForDashboard(row.dashboard_id),
    }, row.columns, row.rows)
    await pool.query(`
      UPDATE query_result_snapshots
      SET object_prefix = $2, version_id = $3, rows = NULL
      WHERE id = $1
    `, [row.id, summary.objectPrefix, summary.versionId])
    console.log(`Materialized ${row.dataset_id} for revision ${row.revision_id.slice(0, 8)} at ${summary.objectPrefix}`)
  }
  if (!result.rows.length) console.log('No JSON query results remain to materialize')

  const nycSnapshotId = await ensureNycWarehouseRevision()
  await retargetNycWarehouseRevision(nycSnapshotId)
  const rewritten = await rematerializeDashboardSummaries(NYC_DASHBOARD_ID, NYC_AS_OF)
  console.log(`NYC warehouse revision ${warehouseIdentityPrefix(nycSnapshotId)}; rewrote ${rewritten} summary tables to as_of=${NYC_AS_OF}`)

  const check = await pool.query<{ current_datasets: string; current_cells: string; json_remaining: string }>(`
    SELECT
      count(*)::text AS current_datasets,
      coalesce(sum(row_count), 0)::text AS current_cells,
      (SELECT count(*)::text FROM query_result_snapshots WHERE rows IS NOT NULL) AS json_remaining
    FROM (
      SELECT DISTINCT ON (q.revision_id, q.dataset_id) q.row_count
      FROM query_result_snapshots q
      JOIN dashboards d ON d.current_revision_id = q.revision_id
      ORDER BY q.revision_id, q.dataset_id, q.created_at DESC
    ) latest
  `)
  const summary = check.rows[0]
  console.log(`Backfilled ${result.rows.length} summary tables`)
  console.log(`Current-revision datasets=${summary?.current_datasets ?? '0'} cells=${summary?.current_cells ?? '0'} json_remaining=${summary?.json_remaining ?? '0'}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  backfillSummaryParquet().then(closePools).catch(async (error) => {
    console.error(error)
    await closePools()
    process.exitCode = 1
  })
}
