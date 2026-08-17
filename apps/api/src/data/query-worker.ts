import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { getConfig } from '../config.js'
import { configureMinio, createDuckDBConnection, jsonSafe, rowsToObjects, sqlLiteral } from './duckdb.js'
import {
  attachWarehouseFiles,
  createWarehouseConnection,
  type WarehouseAttachment,
} from './warehouse-files.js'

interface WorkerInput {
  operation?: 'write_summary' | 'read_summary' | 'warehouse_query' | 'warehouse_describe' | 'warehouse_inspect'
  objectPrefix?: string
  columns?: string[]
  rows?: Record<string, unknown>[]
  partName?: string
  attachments?: WarehouseAttachment[]
  relations?: string[]
  sql?: string
  maxRows?: number
  maxBytes?: number
  qualifiedName?: string
  snapshotColumn?: string | null
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function qualify(name: string): string {
  return name.split('.').map(quoteIdent).join('.')
}

async function runWriteSummary(input: WorkerInput): Promise<void> {
  const config = getConfig()
  const objectPrefix = input.objectPrefix
  const partName = input.partName
  const columns = input.columns ?? []
  const rows = input.rows ?? []
  if (!objectPrefix || !partName) throw new Error('Summary write requires an object prefix and part name')
  if (!columns.length) throw new Error('Summary write requires column names')
  const connection = await createDuckDBConnection()
  const tempDir = await mkdtemp(path.join(tmpdir(), 'fieldboard-summary-'))
  try {
    await configureMinio(connection)
    if (rows.length === 0) {
      await connection.run(`CREATE TABLE __summary (${columns.map((column) => `${quoteIdent(column)} VARCHAR`).join(', ')})`)
    } else {
      const file = path.join(tempDir, 'rows.json')
      await writeFile(file, JSON.stringify(rows))
      await connection.run(`
        CREATE TABLE __summary AS
        SELECT ${columns.map((column) => quoteIdent(column)).join(', ')}
        FROM read_json(${sqlLiteral(file)}, format='array', auto_detect=true)
      `)
    }
    const target = `s3://${config.MINIO_BUCKET}/${objectPrefix}/${partName}`
    await connection.run(`COPY __summary TO ${sqlLiteral(target)} (FORMAT parquet, COMPRESSION zstd)`)
    parentPort?.postMessage({ ok: true, objectPrefix })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
    connection.closeSync()
  }
}

async function readSummaryWithDuckDB(objectPrefix: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const config = getConfig()
  const connection = await createDuckDBConnection()
  try {
    await configureMinio(connection)
    const reader = await connection.runAndReadAll(`
      SELECT * FROM read_parquet(
        ${sqlLiteral(`s3://${config.MINIO_BUCKET}/${objectPrefix}/*.parquet`)},
        hive_partitioning = false
      )
    `)
    const columns = reader.columnNames()
    return { columns, rows: rowsToObjects(columns, reader.getRows()).map((row) => (
      Object.fromEntries(columns.map((column) => [column, jsonSafe(row[column])]))
    )) }
  } finally {
    connection.closeSync()
  }
}

async function runReadSummary(input: WorkerInput): Promise<void> {
  const objectPrefix = input.objectPrefix
  if (!objectPrefix) throw new Error('Summary read requires an object prefix')
  const result = await readSummaryWithDuckDB(objectPrefix)
  parentPort?.postMessage({
    ok: true,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
  })
}

async function withWarehouse<T>(
  attachments: WarehouseAttachment[] | undefined,
  run: (connection: Awaited<ReturnType<typeof createWarehouseConnection>>) => Promise<T>,
): Promise<T> {
  if (!attachments?.length) throw new Error('Warehouse query requires attached project catalogs')
  const connection = await createWarehouseConnection()
  try {
    await attachWarehouseFiles(connection, attachments, true)
    return await run(connection)
  } finally {
    connection.closeSync()
  }
}

async function runWarehouseQuery(input: WorkerInput): Promise<void> {
  const sql = input.sql
  const maxRows = input.maxRows ?? 500
  const maxBytes = input.maxBytes ?? getConfig().QUERY_MAX_BYTES
  if (!sql) throw new Error('Warehouse query requires SQL')
  await withWarehouse(input.attachments, async (connection) => {
    const reader = await connection.runAndReadAll(
      `SELECT * FROM (${sql}) AS __fieldboard_result LIMIT ${maxRows + 1}`,
    )
    const columns = reader.columnNames()
    const records = rowsToObjects(columns, reader.getRows()).map((row) => (
      Object.fromEntries(columns.map((column) => [column, jsonSafe(row[column])]))
    ))
    const truncated = records.length > maxRows
    const rows = records.slice(0, maxRows)
    if (Buffer.byteLength(JSON.stringify(rows)) > maxBytes) throw new Error('Query result exceeds the 2 MB payload limit')
    parentPort?.postMessage({ ok: true, columns, rows, rowCount: rows.length, truncated })
  })
}

async function runWarehouseDescribe(input: WorkerInput): Promise<void> {
  const relations = input.relations ?? []
  await withWarehouse(input.attachments, async (connection) => {
    const descriptions = []
    for (const qualifiedName of relations) {
      const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${qualify(qualifiedName)}`)
      const columns = reader.getRows().map((row) => ({ name: String(row[0]), type: String(row[1]) }))
      descriptions.push({ qualifiedName, columns })
    }
    parentPort?.postMessage({ ok: true, descriptions })
  })
}

async function runWarehouseInspect(input: WorkerInput): Promise<void> {
  const qualifiedName = input.qualifiedName
  if (!qualifiedName) throw new Error('Warehouse inspect requires a relation name')
  const snapshotColumn = input.snapshotColumn
  await withWarehouse(input.attachments, async (connection) => {
    const countReader = await connection.runAndReadAll(`SELECT count(*) FROM ${qualify(qualifiedName)}`)
    const rowCount = Number(countReader.getRows()[0]?.[0] ?? 0)
    let snapshotDate = new Date().toISOString().slice(0, 10)
    if (snapshotColumn) {
      const dated = await connection.runAndReadAll(
        `SELECT COALESCE(min(${quoteIdent(snapshotColumn)})::DATE, current_date)::VARCHAR FROM ${qualify(qualifiedName)}`,
      )
      snapshotDate = String(dated.getRows()[0]?.[0] ?? snapshotDate)
    }
    parentPort?.postMessage({ ok: true, rowCount, snapshotDate })
  })
}

async function run(input: WorkerInput): Promise<void> {
  if (input.operation === 'write_summary') {
    await runWriteSummary(input)
    return
  }
  if (input.operation === 'read_summary') {
    await runReadSummary(input)
    return
  }
  if (input.operation === 'warehouse_query') {
    await runWarehouseQuery(input)
    return
  }
  if (input.operation === 'warehouse_describe') {
    await runWarehouseDescribe(input)
    return
  }
  if (input.operation === 'warehouse_inspect') {
    await runWarehouseInspect(input)
    return
  }
  throw new Error(`Unsupported worker operation: ${input.operation ?? 'unknown'}`)
}

run(workerData as WorkerInput).catch((error) => {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
})
