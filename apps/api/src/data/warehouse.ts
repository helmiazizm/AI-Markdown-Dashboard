import { DuckDBInstance } from '@duckdb/node-api'
import { stat } from 'node:fs/promises'
import { getConfig } from '../config.js'
import { runDataWorker } from './data-worker.js'
import { jsonSafe } from './duckdb.js'
import { normalizeReadonlySql, validateSerializedAst } from './query-guard.js'
import {
  attachmentsFor,
  type WarehouseAttachment,
} from './warehouse-files.js'
import { governedRelationNames, listWarehouseRelations, type WarehouseRelation } from './warehouse-relations.js'

export interface WarehouseQueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
}

export interface WarehouseRelationDescription {
  qualifiedName: string
  columns: Array<{ name: string; type: string }>
}

export function warehouseIdentityPrefix(snapshotId: string): string {
  return `warehouse:catalog@${snapshotId}`
}

function relationsNamedInSql(sql: string, relations: WarehouseRelation[]): WarehouseRelation[] {
  const lower = sql.toLowerCase()
  return relations.filter((relation) => lower.includes(relation.qualifiedName.toLowerCase()))
}

async function compactAttachments(relations: WarehouseRelation[]): Promise<WarehouseAttachment[]> {
  const compact: WarehouseAttachment[] = []
  for (const attachment of attachmentsFor(relations)) {
    try {
      const size = (await stat(attachment.path)).size
      if (size > 512 * 1024 * 1024) continue
      compact.push(attachment)
    } catch {
      // Skip catalogs that are not on disk yet.
    }
  }
  return compact
}

async function validateWarehouseSql(sql: string): Promise<string> {
  const normalized = normalizeReadonlySql(sql)
  const governed = await governedRelationNames()
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    const astReader = await connection.runAndReadAll(
      'SELECT json_serialize_sql($sql::VARCHAR) AS ast',
      { sql: normalized },
    )
    const ast = astReader.getRows()[0]?.[0]
    if (typeof ast !== 'string') throw new Error('DuckDB did not return a SQL syntax tree')
    validateSerializedAst(ast, governed)
  } finally {
    connection.closeSync()
  }
  return normalized
}

function asRows(columns: string[], records: Array<Record<string, unknown>>): Record<string, unknown>[] {
  return records.map((record) => Object.fromEntries(
    columns.map((column) => [column, jsonSafe(record[column])]),
  ))
}

export async function pingWarehouse(): Promise<boolean> {
  const relations = await listWarehouseRelations()
  if (!relations.length) return false
  const attachments = await compactAttachments(relations)
  return attachments.length > 0
}

export async function describeWarehouse(): Promise<WarehouseRelationDescription[]> {
  const relations = await listWarehouseRelations()
  if (!relations.length) throw new Error('No warehouse relations are registered')
  const descriptions: WarehouseRelationDescription[] = []
  for (const relation of relations) {
    try {
      const result = await runDataWorker<{ descriptions: WarehouseRelationDescription[] }>({
        operation: 'warehouse_describe',
        attachments: attachmentsFor([relation]),
        relations: [relation.qualifiedName],
      })
      descriptions.push(...result.descriptions)
    } catch {
      // A locked or oversized catalog must not block the rest of the registry.
    }
  }
  if (!descriptions.length) throw new Error('No warehouse relations could be described')
  return descriptions
}

export async function describeWarehouseRelation(qualifiedName: string): Promise<Array<{ name: string; type: string }>> {
  const relations = (await listWarehouseRelations()).filter((relation) => relation.qualifiedName === qualifiedName)
  if (!relations.length) throw new Error(`Warehouse relation ${qualifiedName} is not registered`)
  const result = await runDataWorker<{ descriptions: WarehouseRelationDescription[] }>({
    operation: 'warehouse_describe',
    attachments: attachmentsFor(relations),
    relations: [qualifiedName],
  })
  const match = result.descriptions.find((item) => item.qualifiedName === qualifiedName)
  if (!match?.columns.length) {
    throw new Error(`Warehouse relation ${qualifiedName} does not exist or has no columns`)
  }
  return match.columns
}

export async function inspectWarehouseRelation(qualifiedName: string, snapshotColumn: string | null): Promise<{
  rowCount: number
  snapshotDate: string
}> {
  const relations = (await listWarehouseRelations()).filter((relation) => relation.qualifiedName === qualifiedName)
  if (!relations.length) throw new Error(`Warehouse relation ${qualifiedName} is not registered`)
  const result = await runDataWorker<{ rowCount: number; snapshotDate: string }>({
    operation: 'warehouse_inspect',
    attachments: attachmentsFor(relations),
    qualifiedName,
    snapshotColumn,
  })
  return { rowCount: result.rowCount, snapshotDate: result.snapshotDate }
}

export async function queryWarehouse(sql: string, maxRows: number, maxBytes = getConfig().QUERY_MAX_BYTES): Promise<WarehouseQueryResult> {
  const config = getConfig()
  const normalized = await validateWarehouseSql(sql)
  const relations = await listWarehouseRelations()
  const referenced = relationsNamedInSql(normalized, relations)
  if (!referenced.length) throw new Error('Query does not reference a registered warehouse relation')
  const limit = Math.min(maxRows, config.QUERY_MAX_ROWS)
  const result = await runDataWorker<{
    columns: string[]
    rows: Array<Record<string, unknown>>
    rowCount: number
    truncated: boolean
  }>({
    operation: 'warehouse_query',
    attachments: attachmentsFor(referenced),
    sql: normalized,
    maxRows: limit,
    maxBytes,
  })
  return {
    columns: result.columns,
    rows: asRows(result.columns, result.rows),
    rowCount: result.rowCount,
    truncated: result.truncated,
  }
}
