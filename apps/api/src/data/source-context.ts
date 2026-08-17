import type { AuthoringSourceContext, DatasetSpec, WarehouseRelationContext } from '@fieldboard/contracts'
import { listWarehouseRelations, type WarehouseRelation } from './warehouse-relations.js'
import {
  describeWarehouseRelation,
  executeDatasetQuery,
  getActiveSnapshot,
  type ActiveSnapshot,
  type QueryExecutionResult,
} from './query-service.js'

const defaultCautions = [
  'Confirm the row grain before choosing counts or distinct counts.',
  'State filters, null handling, units, and denominators explicitly.',
  'Treat each warehouse relation as point-in-time evidence unless it contains a time series.',
]

export interface SourceContextDependencies {
  activeSnapshot: () => Promise<ActiveSnapshot | null>
  listRelations: () => Promise<WarehouseRelation[]>
  describeRelation: (qualifiedName: string) => Promise<Array<{ name: string; type: string }>>
  executeQuery: (dataset: DatasetSpec) => Promise<QueryExecutionResult>
}

const defaultDependencies: SourceContextDependencies = {
  activeSnapshot: getActiveSnapshot,
  listRelations: listWarehouseRelations,
  describeRelation: describeWarehouseRelation,
  executeQuery: executeDatasetQuery,
}

function relationRowCount(snapshot: ActiveSnapshot, qualifiedName: string): number {
  const relations = snapshot.profile.relations
  if (Array.isArray(relations)) {
    const match = relations.find((item) => (
      item && typeof item === 'object' && (item as { qualifiedName?: string }).qualifiedName === qualifiedName
    )) as { rowCount?: unknown } | undefined
    if (typeof match?.rowCount === 'number') return match.rowCount
  }
  return snapshot.rowCount
}

async function relationContext(
  relation: WarehouseRelation,
  snapshot: ActiveSnapshot,
  dependencies: SourceContextDependencies,
): Promise<WarehouseRelationContext> {
  const described = await dependencies.describeRelation(relation.qualifiedName)
  const firstColumn = described[0]
  if (!firstColumn) throw new Error(`Warehouse relation ${relation.qualifiedName} has no columns`)
  const preview = await dependencies.executeQuery({
    id: 'source-context',
    question: `Bounded example rows from ${relation.qualifiedName}`,
    sql: `SELECT * FROM ${relation.qualifiedName} LIMIT 8`,
    expectedColumns: [firstColumn.name],
    maxRows: 8,
  })
  return {
    qualifiedName: relation.qualifiedName,
    project: relation.project,
    schemaName: relation.schemaName,
    tableName: relation.tableName,
    datasetName: relation.datasetName,
    grain: relation.grain,
    snapshotColumn: relation.snapshotColumn,
    rowCount: relationRowCount(snapshot, relation.qualifiedName),
    columns: described.map((column) => `${column.name} ${column.type}`),
    cautions: relation.cautions.length ? relation.cautions : defaultCautions,
    exampleValues: preview.rows,
  }
}

export async function getGovernedSourceContext(
  dependencies: SourceContextDependencies = defaultDependencies,
): Promise<AuthoringSourceContext> {
  const snapshot = await dependencies.activeSnapshot()
  if (!snapshot) throw new Error('No active source snapshot')
  const relations = await dependencies.listRelations()
  if (!relations.length) throw new Error('No warehouse relations are registered')
  const catalog: WarehouseRelationContext[] = []
  for (const relation of relations) {
    if (relationRowCount(snapshot, relation.qualifiedName) === 0) continue
    try {
      catalog.push(await relationContext(relation, snapshot, dependencies))
    } catch {
      // Skip catalogs that cannot be opened so a loading project does not block authoring.
    }
  }
  if (!catalog.length) throw new Error('No warehouse relations are currently queryable')
  return {
    relations: catalog,
    activeSnapshot: { ...snapshot, relationName: 'catalog' },
  }
}
