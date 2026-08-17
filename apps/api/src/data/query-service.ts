import type { DatasetSpec } from '@fieldboard/contracts'
import { getConfig } from '../config.js'
import { pool } from '../db/pool.js'
import { describeWarehouseRelation, queryWarehouse } from './warehouse.js'

export interface ActiveSnapshot {
  id: string
  objectPrefix: string
  snapshotDate: string
  rowCount: number
  datasetName: string
  relationName: string
  profile: Record<string, unknown>
}

export interface QueryExecutionResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  snapshot: ActiveSnapshot
}

export async function getActiveSnapshot(): Promise<ActiveSnapshot | null> {
  const result = await pool.query<{
    id: string
    object_prefix: string
    snapshot_date: string
    row_count: number
    dataset_name: string
    relation_name: string
    profile: Record<string, unknown>
  }>(`
    SELECT id, object_prefix, snapshot_date::text, row_count, dataset_name, relation_name, profile
    FROM data_snapshots
    WHERE active AND status = 'ready'
    LIMIT 1
  `)
  const row = result.rows[0]
  return row ? {
    id: row.id,
    objectPrefix: row.object_prefix,
    snapshotDate: row.snapshot_date,
    rowCount: Number(row.row_count),
    datasetName: row.dataset_name,
    relationName: row.relation_name,
    profile: row.profile ?? {},
  } : null
}

/**
 * Every warehouse query spawns a worker thread that creates its own DuckDB instance with a
 * multi-gigabyte memory_limit, so overlapping queries can exhaust a small container. This gate
 * serialises them process-wide: concurrent callers queue instead of multiplying memory budgets.
 */
let queryGate: Promise<unknown> = Promise.resolve()

function withQueryGate<T>(operation: () => Promise<T>): Promise<T> {
  const result = queryGate.then(operation, operation)
  queryGate = result.catch(() => undefined)
  return result
}

export async function executeDatasetQuery(dataset: DatasetSpec): Promise<QueryExecutionResult> {
  const snapshot = await getActiveSnapshot()
  if (!snapshot) throw new Error('The governed source snapshot is not ready')
  const config = getConfig()
  const result = await withQueryGate(() => queryWarehouse(
    dataset.sql,
    Math.min(dataset.maxRows, config.QUERY_MAX_ROWS),
    config.QUERY_MAX_BYTES,
  ))
  const missing = dataset.expectedColumns.filter((column) => !result.columns.includes(column))
  if (missing.length) throw new Error(`Dataset ${dataset.id} is missing expected columns: ${missing.join(', ')}`)
  return { ...result, snapshot }
}

export { describeWarehouseRelation }
