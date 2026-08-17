import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePools, pool } from '../db/pool.js'
import { migrateAll } from '../db/migrate-all.js'
import { createId } from '../lib/ids.js'
import { inspectWarehouseRelation, warehouseIdentityPrefix } from './warehouse.js'
import { DEMO_WAREHOUSE_PROJECTS, ensureProjectSchemas, ensureWarehouseDirectory } from './warehouse-files.js'
import { listWarehouseRelations, type WarehouseRelation } from './warehouse-relations.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface RelationStats {
  qualifiedName: string
  datasetName: string
  grain: string
  cautions: string[]
  snapshotColumn: string | null
  rowCount: number
  snapshotDate: string
  sourceRevision: number
}

function catalogFingerprint(relations: WarehouseRelation[]): string {
  return sha256(JSON.stringify(relations.map((relation) => ({
    qualifiedName: relation.qualifiedName,
    sourceRevision: relation.sourceRevision,
    duckdbFile: relation.duckdbFile,
  }))))
}

function catalogProfile(stats: RelationStats[]): Record<string, unknown> {
  return {
    grain: 'Governed warehouse catalog of project.schema.table relations.',
    relations: stats.map((item) => ({
      qualifiedName: item.qualifiedName,
      datasetName: item.datasetName,
      grain: item.grain,
      cautions: item.cautions,
      snapshotColumn: item.snapshotColumn,
      rowCount: item.rowCount,
      snapshotDate: item.snapshotDate,
      sourceRevision: item.sourceRevision,
    })),
  }
}

async function rewriteWarehouseIdentities(): Promise<void> {
  const result = await pool.query<{ id: string }>(`
    SELECT id FROM data_snapshots
    WHERE status = 'ready'
      AND object_prefix NOT LIKE 'warehouse:%'
  `)
  for (const row of result.rows) {
    await pool.query('UPDATE data_snapshots SET object_prefix = $2 WHERE id = $1', [row.id, warehouseIdentityPrefix(row.id)])
  }
}

async function findReadySnapshot(fingerprint: string): Promise<{ snapshotId: string; rowCount: number } | null> {
  const ingest = await pool.query<{ id: string }>(`
    SELECT id FROM warehouse_ingests WHERE catalog_sha256 = $1 AND status = 'ready' LIMIT 1
  `, [fingerprint])
  const ingestId = ingest.rows[0]?.id
  if (!ingestId) return null
  const snapshot = await pool.query<{ id: string; row_count: number }>(`
    SELECT id, row_count FROM data_snapshots
    WHERE ingest_id = $1 AND status = 'ready'
    ORDER BY active DESC, created_at DESC
    LIMIT 1
  `, [ingestId])
  const row = snapshot.rows[0]
  return row ? { snapshotId: row.id, rowCount: Number(row.row_count) } : null
}

async function inspectCatalog(relations: WarehouseRelation[]): Promise<RelationStats[]> {
  const stats: RelationStats[] = []
  for (const relation of relations) {
    let rowCount = 0
    let snapshotDate = new Date().toISOString().slice(0, 10)
    try {
      const inspected = await inspectWarehouseRelation(relation.qualifiedName, relation.snapshotColumn)
      rowCount = inspected.rowCount
      snapshotDate = inspected.snapshotDate
    } catch (error) {
      console.warn(`Could not inspect ${relation.qualifiedName}: ${error instanceof Error ? error.message : error}`)
      rowCount = 0
    }
    stats.push({
      qualifiedName: relation.qualifiedName,
      datasetName: relation.datasetName,
      grain: relation.grain,
      cautions: relation.cautions,
      snapshotColumn: relation.snapshotColumn,
      rowCount,
      snapshotDate,
      sourceRevision: relation.sourceRevision,
    })
  }
  return stats
}

async function activateExistingSnapshot(
  snapshotId: string,
  stats: RelationStats[],
): Promise<void> {
  const rowCount = stats.reduce((sum, item) => sum + item.rowCount, 0)
  const snapshotDate = stats.map((item) => item.snapshotDate).sort()[0] ?? new Date().toISOString().slice(0, 10)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE data_snapshots SET active = false WHERE active AND id <> $1', [snapshotId])
    await client.query(`
      UPDATE data_snapshots
      SET active = true, dataset_name = $2, relation_name = 'catalog', profile = $3,
          object_prefix = $4, row_count = $5, snapshot_date = $6, status = 'ready'
      WHERE id = $1
    `, [
      snapshotId, 'Warehouse catalog', JSON.stringify(catalogProfile(stats)),
      warehouseIdentityPrefix(snapshotId), rowCount, snapshotDate,
    ])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function beginIngest(fingerprint: string, sourcePath: string): Promise<string> {
  const id = createId()
  const result = await pool.query<{ id: string }>(`
    INSERT INTO warehouse_ingests(id, catalog_sha256, source_path, status)
    VALUES ($1, $2, $3, 'loading')
    ON CONFLICT (catalog_sha256) DO UPDATE
    SET source_path = EXCLUDED.source_path, status = 'loading', error = NULL, completed_at = NULL
    RETURNING id
  `, [id, fingerprint, sourcePath])
  return result.rows[0]?.id ?? id
}

async function publishSnapshot(ingestId: string, stats: RelationStats[]): Promise<string> {
  const snapshotId = createId()
  const rowCount = stats.reduce((sum, item) => sum + item.rowCount, 0)
  const snapshotDate = stats.map((item) => item.snapshotDate).sort()[0] ?? new Date().toISOString().slice(0, 10)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE data_snapshots SET active = false WHERE active')
    await client.query(`
      INSERT INTO data_snapshots(
        id, ingest_id, object_prefix, snapshot_date, row_count,
        country_count, category_count, status, active, dataset_name, relation_name, profile
      ) VALUES ($1, $2, $3, $4, $5, 0, 0, 'ready', true, $6, 'catalog', $7)
    `, [
      snapshotId, ingestId, warehouseIdentityPrefix(snapshotId), snapshotDate, rowCount,
      'Warehouse catalog', JSON.stringify(catalogProfile(stats)),
    ])
    await client.query('COMMIT')
    return snapshotId
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function bootstrapData(): Promise<void> {
  await migrateAll()
  await ensureWarehouseDirectory()
  for (const project of DEMO_WAREHOUSE_PROJECTS) await ensureProjectSchemas(project)
  const relations = await listWarehouseRelations()
  if (!relations.length) throw new Error('No warehouse relations are registered')
  const stats = await inspectCatalog(relations)
  const empty = stats.filter((item) => item.rowCount === 0)
  const populated = stats.filter((item) => item.rowCount > 0)
  if (!populated.length) {
    console.warn(`Warehouse catalog is empty; relations: ${empty.map((item) => item.qualifiedName).join(', ')}`)
    console.warn('Load grain tables, then rerun data:init')
    await rewriteWarehouseIdentities()
    return
  }
  if (empty.length) {
    console.warn(`Warehouse catalog is partial; empty relations: ${empty.map((item) => item.qualifiedName).join(', ')}`)
  }

  const fingerprint = catalogFingerprint(relations)
  const sourcePath = relations.map((relation) => `${relation.qualifiedName}@${relation.sourceRevision}`).join(',')
  const existing = await findReadySnapshot(fingerprint)
  if (existing) {
    await activateExistingSnapshot(existing.snapshotId, stats)
    await rewriteWarehouseIdentities()
    console.log(`Warehouse catalog ready: ${stats.reduce((sum, item) => sum + item.rowCount, 0).toLocaleString()} rows at ${warehouseIdentityPrefix(existing.snapshotId)}`)
    return
  }

  const ingestId = await beginIngest(fingerprint, sourcePath)
  try {
    await pool.query(`UPDATE warehouse_ingests SET status = 'transforming' WHERE id = $1`, [ingestId])
    const rowCount = stats.reduce((sum, item) => sum + item.rowCount, 0)
    const snapshotDate = stats.map((item) => item.snapshotDate).sort()[0]
    await pool.query(`
      UPDATE warehouse_ingests SET row_count = $2, snapshot_date = $3 WHERE id = $1
    `, [ingestId, rowCount, snapshotDate])
    const snapshotId = await publishSnapshot(ingestId, stats)
    await pool.query(`UPDATE warehouse_ingests SET status = 'ready', completed_at = now() WHERE id = $1`, [ingestId])
    await rewriteWarehouseIdentities()
    console.log(`Warehouse catalog ready: ${rowCount.toLocaleString()} rows at ${warehouseIdentityPrefix(snapshotId)}`)
    for (const item of stats) {
      console.log(`  ${item.qualifiedName}: ${item.rowCount.toLocaleString()} rows (${item.datasetName})`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await pool.query(`UPDATE warehouse_ingests SET status = 'failed', error = $2 WHERE id = $1`, [ingestId, message])
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrapData().then(closePools).catch(async (error) => {
    console.error(error)
    await closePools()
    process.exitCode = 1
  })
}
