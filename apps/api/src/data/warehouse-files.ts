import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { getConfig } from '../config.js'
import { sqlLiteral } from './duckdb.js'
import type { WarehouseRelation } from './warehouse-relations.js'

export interface WarehouseAttachment {
  catalog: string
  path: string
}

export function warehouseDirectory(): string {
  const configured = getConfig().WAREHOUSE_DIR
  if (path.isAbsolute(configured)) return configured
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
  return path.resolve(repoRoot, configured)
}

export function warehouseFilePath(project: string): string {
  return path.join(warehouseDirectory(), `${project}.duckdb`)
}

export async function ensureWarehouseDirectory(): Promise<string> {
  const directory = warehouseDirectory()
  await mkdir(directory, { recursive: true })
  return directory
}

export function attachmentsFor(relations: WarehouseRelation[]): WarehouseAttachment[] {
  const seen = new Map<string, WarehouseAttachment>()
  for (const relation of relations) {
    if (seen.has(relation.project)) continue
    seen.set(relation.project, {
      catalog: relation.project,
      path: path.resolve(warehouseDirectory(), relation.duckdbFile),
    })
  }
  return [...seen.values()]
}

export async function createWarehouseConnection(options?: {
  readOnly?: boolean
  memoryLimit?: string
  threads?: string
}): Promise<DuckDBConnection> {
  const config = getConfig()
  const instance = await DuckDBInstance.create(':memory:', {
    threads: options?.threads ?? '4',
    memory_limit: options?.memoryLimit ?? '2GB',
    extension_directory: path.resolve(config.DUCKDB_EXTENSION_DIRECTORY),
  })
  return instance.connect()
}

export async function attachWarehouseFiles(
  connection: DuckDBConnection,
  attachments: WarehouseAttachment[],
  readOnly = true,
): Promise<void> {
  for (const attachment of attachments) {
    const mode = readOnly ? ' (READ_ONLY)' : ''
    await connection.run(
      `ATTACH IF NOT EXISTS ${sqlLiteral(attachment.path)} AS ${attachment.catalog}${mode}`,
    )
  }
}

export async function openProjectDatabase(project: string, options?: {
  memoryLimit?: string
  threads?: string
}): Promise<DuckDBConnection> {
  await ensureWarehouseDirectory()
  const config = getConfig()
  // fromCache, not create: every create() on the same path yields an independent
  // instance holding its own view of the file. Callers only close the connection,
  // so the leaked instances checkpoint a stale view over freshly loaded data on
  // process exit and silently truncate the relation. One instance per path fixes it.
  const instance = await DuckDBInstance.fromCache(warehouseFilePath(project), {
    threads: options?.threads ?? '4',
    memory_limit: options?.memoryLimit ?? '4GB',
    extension_directory: path.resolve(config.DUCKDB_EXTENSION_DIRECTORY),
  })
  return instance.connect()
}

export const FASHION_PRODUCTS_DDL = `
  CREATE TABLE IF NOT EXISTS catalog.products (
    product_id INTEGER,
    gender VARCHAR,
    master_category VARCHAR,
    sub_category VARCHAR,
    article_type VARCHAR,
    base_colour VARCHAR,
    season VARCHAR,
    year INTEGER,
    usage VARCHAR,
    product_display_name VARCHAR
  )
`

export const TLC_YELLOW_TRIPS_DDL = `
  CREATE TABLE IF NOT EXISTS taxi.yellow_trips (
    data_month DATE NOT NULL,
    pickup_datetime TIMESTAMP,
    trip_distance_miles DOUBLE,
    trip_duration_minutes DOUBLE,
    pu_zone VARCHAR,
    pu_borough VARCHAR,
    payment_type SMALLINT,
    fare_amount DOUBLE,
    total_amount DOUBLE,
    cbd_congestion_fee DOUBLE,
    pickup_hour SMALLINT,
    pickup_iso_dow SMALLINT,
    pickup_day_name VARCHAR
  )
`

const PROJECT_BOOTSTRAP: Record<string, (connection: DuckDBConnection) => Promise<void>> = {
  async fashion(connection) {
    await connection.run('CREATE SCHEMA IF NOT EXISTS catalog')
    await connection.run(FASHION_PRODUCTS_DDL)
  },
  async tlc(connection) {
    await connection.run('CREATE SCHEMA IF NOT EXISTS taxi')
    await connection.run(TLC_YELLOW_TRIPS_DDL)
    await connection.run('CREATE INDEX IF NOT EXISTS yellow_trips_month_idx ON taxi.yellow_trips (data_month)')
  },
}

export const DEMO_WAREHOUSE_PROJECTS = Object.keys(PROJECT_BOOTSTRAP)

export async function ensureProjectSchemas(project: string): Promise<void> {
  const bootstrap = PROJECT_BOOTSTRAP[project]
  if (!bootstrap) throw new Error(`No warehouse DDL is registered for project ${project}`)
  const connection = await openProjectDatabase(project)
  try {
    await bootstrap(connection)
  } finally {
    connection.closeSync()
  }
}
