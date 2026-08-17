import { pool } from '../db/pool.js'

export const RELATION_IDENTIFIER = /^[a-z][a-z0-9_]*$/

export interface WarehouseRelation {
  project: string
  schemaName: string
  tableName: string
  qualifiedName: string
  datasetName: string
  snapshotColumn: string | null
  grain: string
  cautions: string[]
  sourceRevision: number
  duckdbFile: string
}

export function qualifiedRelationName(input: {
  project: string
  schemaName: string
  tableName: string
}): string {
  return `${input.project}.${input.schemaName}.${input.tableName}`
}

function parseCautions(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.slice(0, 12)
    : []
}

export async function listWarehouseRelations(): Promise<WarehouseRelation[]> {
  const result = await pool.query<{
    project: string
    schema_name: string
    table_name: string
    dataset_name: string
    snapshot_column: string | null
    grain: string
    cautions: unknown
    source_revision: number
    duckdb_file: string
  }>(`
    SELECT project, schema_name, table_name, dataset_name, snapshot_column, grain, cautions,
           source_revision, duckdb_file
    FROM warehouse_relations
    ORDER BY project, schema_name, table_name
  `)
  return result.rows.map((row) => ({
    project: row.project,
    schemaName: row.schema_name,
    tableName: row.table_name,
    qualifiedName: qualifiedRelationName({
      project: row.project, schemaName: row.schema_name, tableName: row.table_name,
    }),
    datasetName: row.dataset_name,
    snapshotColumn: row.snapshot_column,
    grain: row.grain,
    cautions: parseCautions(row.cautions),
    sourceRevision: Number(row.source_revision),
    duckdbFile: row.duckdb_file,
  }))
}

export async function governedRelationNames(): Promise<Set<string>> {
  const relations = await listWarehouseRelations()
  return new Set(relations.map((relation) => relation.qualifiedName))
}

export async function bumpRelationRevision(qualifiedName: string): Promise<number> {
  const [project, schemaName, tableName] = qualifiedName.split('.')
  if (!project || !schemaName || !tableName) throw new Error(`Invalid warehouse relation ${qualifiedName}`)
  const result = await pool.query<{ source_revision: number }>(`
    UPDATE warehouse_relations
    SET source_revision = source_revision + 1, updated_at = now()
    WHERE project = $1 AND schema_name = $2 AND table_name = $3
    RETURNING source_revision
  `, [project, schemaName, tableName])
  const revision = result.rows[0]?.source_revision
  if (!revision) throw new Error(`Warehouse relation ${qualifiedName} is not registered`)
  return Number(revision)
}
