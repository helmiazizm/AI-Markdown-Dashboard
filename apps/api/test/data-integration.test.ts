import { afterAll, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { closePools, pool } from '../src/db/pool.js'
import { createId } from '../src/lib/ids.js'
import { getGovernedSourceContext } from '../src/data/source-context.js'
import { executeDatasetQuery, getActiveSnapshot } from '../src/data/query-service.js'
import { readSummary, writeSummary } from '../src/data/summary-store.js'

it.runIf(process.env.RUN_DATA_INTEGRATION === '1')('queries DuckDB catalogs and hydrates dashboard summaries through DuckDB', async () => {
  const snapshot = await getActiveSnapshot()
  expect(snapshot?.relationName).toBe('catalog')
  expect(snapshot?.objectPrefix.startsWith('warehouse:catalog@')).toBe(true)

  const application = await pool.query<{ source_table: string | null; ingest_table: string | null; relations: number }>(`
    SELECT
      to_regclass('public.source_data')::text AS source_table,
      to_regclass('public.source_ingests')::text AS ingest_table,
      (SELECT count(*)::int FROM warehouse_relations) AS relations
  `)
  expect(application.rows[0]?.source_table).toBeNull()
  expect(application.rows[0]?.ingest_table).toBeNull()
  expect(Number(application.rows[0]?.relations)).toBeGreaterThanOrEqual(2)

  const context = await getGovernedSourceContext()
  expect(context.activeSnapshot).toMatchObject({ id: snapshot?.id, relationName: 'catalog' })
  expect(context.relations.map((relation) => relation.qualifiedName).sort()).toEqual([
    'fashion.catalog.products',
    'tlc.taxi.yellow_trips',
  ])
  expect(context.relations.every((relation) => relation.exampleValues.length > 0)).toBe(true)

  const bounded = await executeDatasetQuery({
    id: 'authoring-integration',
    question: 'Which rows are present?',
    sql: 'SELECT 1 AS source_rows FROM tlc.taxi.yellow_trips LIMIT 3',
    expectedColumns: ['source_rows'],
    maxRows: 2,
  })
  expect(bounded.rows).toHaveLength(2)
  expect(bounded.truncated).toBe(true)

  const joined = await executeDatasetQuery({
    id: 'authoring-join',
    question: 'Can governed triples join?',
    sql: `SELECT 1 AS ok FROM fashion.catalog.products n JOIN tlc.taxi.yellow_trips t ON true LIMIT 1`,
    expectedColumns: ['ok'],
    maxRows: 1,
  })
  expect(joined.rows).toHaveLength(1)

  const summary = await writeSummary({
    dashboardId: '11111111-1111-4111-8111-111111111111',
    datasetId: 'authoring-integration',
    revisionId: '22222222-2222-4222-8222-222222222222',
    asOf: snapshot!.snapshotDate,
  }, bounded.columns, bounded.rows)
  expect(summary.objectPrefix.startsWith('summaries/dashboard=')).toBe(true)
  const stored = await readSummary(summary.objectPrefix)
  expect(stored.rows).toEqual(bounded.rows)

  const dashboard = await pool.query<{ id: string; current_revision_id: string }>(`
    SELECT id, current_revision_id FROM dashboards WHERE current_revision_id IS NOT NULL LIMIT 1
  `)
  const current = dashboard.rows[0]
  expect(current).toBeTruthy()
  const resultId = createId()
  await pool.query(`
    INSERT INTO query_result_snapshots(
      id, revision_id, dataset_id, columns, rows, row_count, truncated, source_snapshot_id, object_prefix, version_id
    ) VALUES ($1, $2, $3, $4, NULL, $5, false, $6, $7, $8)
  `, [
    resultId, current!.current_revision_id, 'authoring-integration',
    JSON.stringify(bounded.columns), bounded.rowCount, snapshot!.id, summary.objectPrefix, summary.versionId,
  ])
  try {
    const dashboardResponse = await createApp().request(`/api/dashboards/${current!.id}`)
    expect(dashboardResponse.status).toBe(200)
    const detail = await dashboardResponse.json() as {
      results: Array<{ datasetId: string; rows: unknown[]; summaryObjectPrefix?: string | null }>
    }
    const hydrated = detail.results.find((item) => item.datasetId === 'authoring-integration')
    expect(hydrated?.rows).toEqual(bounded.rows)
    expect(hydrated?.summaryObjectPrefix).toBe(summary.objectPrefix)
    const controlPlane = await pool.query<{ rows: unknown }>(`
      SELECT rows FROM query_result_snapshots WHERE id = $1
    `, [resultId])
    expect(controlPlane.rows[0]?.rows).toBeNull()
  } finally {
    await pool.query('DELETE FROM query_result_snapshots WHERE id = $1', [resultId])
  }

  await expect(executeDatasetQuery({
    id: 'authoring-missing-column',
    question: 'Verify expected-column enforcement',
    sql: 'SELECT 1 AS source_rows FROM tlc.taxi.yellow_trips LIMIT 1',
    expectedColumns: ['missing_column'],
    maxRows: 1,
  })).rejects.toThrow('missing expected columns')

  const app = createApp()
  const health = await app.request('/api/health')
  expect(health.status).toBe(200)
  const healthBody = await health.json() as { warehouse?: boolean; sourcePostgres?: unknown }
  expect(healthBody.warehouse).toBe(true)
  expect(healthBody.sourcePostgres).toBeUndefined()

  const response = await app.request('/api/authoring/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: 'How many rows are in the TLC grain?',
      sql: 'SELECT count(*) AS source_rows FROM tlc.taxi.yellow_trips',
      expectedColumns: ['source_rows'],
      maxRows: 5,
    }),
  })
  expect(response.status).toBe(200)
  expect((await response.json() as { rows: unknown[] }).rows).toHaveLength(1)

  const unknownTable = await app.request('/api/authoring/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: 'Attempt to read another base table',
      sql: 'SELECT n.source_rows FROM tlc.taxi.yellow_trips n JOIN private_table p ON true LIMIT 1',
      expectedColumns: ['source_rows'],
      maxRows: 1,
    }),
  })
  expect(unknownTable.status).toBe(400)
  expect(await unknownTable.json()).toMatchObject({ error: expect.stringMatching(/not available|source_data|project\.schema\.table/) })

  const legacy = await app.request('/api/authoring/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: 'Reject the retired source_data name',
      sql: 'SELECT count(*) AS source_rows FROM source_data',
      expectedColumns: ['source_rows'],
      maxRows: 1,
    }),
  })
  expect(legacy.status).toBe(400)
}, 120_000)

afterAll(async () => {
  if (process.env.RUN_DATA_INTEGRATION === '1') await closePools()
})
