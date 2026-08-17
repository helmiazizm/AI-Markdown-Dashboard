import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import path from 'node:path'
import { getConfig } from '../config.js'

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export async function createDuckDBConnection(): Promise<DuckDBConnection> {
  const config = getConfig()
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '2',
    memory_limit: '768MB',
    extension_directory: path.resolve(config.DUCKDB_EXTENSION_DIRECTORY),
  })
  const connection = await instance.connect()
  await connection.run('INSTALL httpfs; LOAD httpfs;')
  return connection
}

export async function configureMinio(connection: DuckDBConnection): Promise<void> {
  const config = getConfig()
  await connection.run(`
    CREATE OR REPLACE SECRET fieldboard_minio (
      TYPE s3,
      PROVIDER config,
      KEY_ID ${sqlLiteral(config.MINIO_ACCESS_KEY)},
      SECRET ${sqlLiteral(config.MINIO_SECRET_KEY)},
      REGION 'us-east-1',
      ENDPOINT ${sqlLiteral(config.MINIO_ENDPOINT)},
      URL_STYLE 'path',
      USE_SSL ${config.MINIO_USE_SSL ? 'true' : 'false'}
    )
  `)
}

export function rowsToObjects(
  columnNames: string[],
  rows: readonly (readonly unknown[])[],
): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(
    columnNames.map((column, index) => [column, jsonSafe(row[index])]),
  ))
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    if ('toJSON' in value && typeof value.toJSON === 'function') return value.toJSON()
    if (value.constructor !== Object) return String(value)
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]))
  }
  return value
}
