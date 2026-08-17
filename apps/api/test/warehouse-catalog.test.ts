import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDataWorker } from '../src/data/data-worker.js'
import { FASHION_PRODUCTS_DDL, TLC_YELLOW_TRIPS_DDL, attachWarehouseFiles, createWarehouseConnection } from '../src/data/warehouse-files.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function seedCatalogs(): Promise<{ fashion: string; tlc: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fieldboard-warehouse-'))
  roots.push(root)
  const fashion = path.join(root, 'fashion.duckdb')
  const tlc = path.join(root, 'tlc.duckdb')
  const connection = await createWarehouseConnection({ memoryLimit: '256MB', threads: '1' })
  try {
    await attachWarehouseFiles(connection, [
      { catalog: 'fashion', path: fashion },
      { catalog: 'tlc', path: tlc },
    ], false)
    await connection.run('USE fashion')
    await connection.run('CREATE SCHEMA IF NOT EXISTS catalog')
    await connection.run(FASHION_PRODUCTS_DDL)
    await connection.run(`INSERT INTO fashion.catalog.products (product_id, master_category, gender) VALUES (1, 'Apparel', 'Men')`)
    await connection.run('USE tlc')
    await connection.run('CREATE SCHEMA IF NOT EXISTS taxi')
    await connection.run(TLC_YELLOW_TRIPS_DDL)
    await connection.run(`INSERT INTO tlc.taxi.yellow_trips (data_month, fare_amount, pu_zone) VALUES (DATE '2024-01-01', 12.5, 'JFK')`)
  } finally {
    connection.closeSync()
  }
  return { fashion, tlc }
}

describe('DuckDB warehouse catalogs', () => {
  it('runs authoring SQL against attached project.schema.table files', async () => {
    const files = await seedCatalogs()
    const result = await runDataWorker<{ rows: Array<Record<string, unknown>>; rowCount: number }>({
      operation: 'warehouse_query',
      attachments: [
        { catalog: 'fashion', path: files.fashion },
        { catalog: 'tlc', path: files.tlc },
      ],
      sql: `SELECT n.master_category, t.pu_zone
            FROM fashion.catalog.products n
            JOIN tlc.taxi.yellow_trips t ON true`,
      maxRows: 10,
      maxBytes: 1_000_000,
    })
    expect(result.rowCount).toBe(1)
    expect(result.rows[0]).toMatchObject({ master_category: 'Apparel', pu_zone: 'JFK' })
  })
})
