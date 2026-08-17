import { describe, expect, it } from 'vitest'
import { getGovernedSourceContext } from '../src/data/source-context.js'

const snapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  objectPrefix: 'warehouse:catalog@11111111-1111-4111-8111-111111111111',
  snapshotDate: '2026-03-19',
  rowCount: 44_424,
  datasetName: 'Warehouse catalog',
  relationName: 'catalog',
  profile: {
    relations: [{
      qualifiedName: 'fashion.catalog.products',
      datasetName: 'Fashion product catalog',
      rowCount: 44_424,
      snapshotDate: '2026-03-19',
    }],
  },
}

describe('governed source context', () => {
  it('builds the shared agent and analyst catalog from bounded dependencies', async () => {
    const context = await getGovernedSourceContext({
      activeSnapshot: async () => snapshot,
      listRelations: async () => [{
        project: 'fashion',
        schemaName: 'catalog',
        tableName: 'products',
        qualifiedName: 'fashion.catalog.products',
        datasetName: 'Fashion product catalog',
        snapshotColumn: null,
        grain: 'One row per product.',
        cautions: ['Revenue excludes refunds.'],
        sourceRevision: 1,
        duckdbFile: 'fashion.duckdb',
      }],
      describeRelation: async () => [{ name: 'region', type: 'VARCHAR' }, { name: 'revenue', type: 'DOUBLE' }],
      executeQuery: async (dataset) => ({
        columns: dataset.expectedColumns,
        rows: [{ region: 'APAC', revenue: 10 }],
        rowCount: 1,
        truncated: false,
        snapshot,
      }),
    })

    expect(context.activeSnapshot.relationName).toBe('catalog')
    expect(context.relations).toHaveLength(1)
    expect(context.relations[0]?.qualifiedName).toBe('fashion.catalog.products')
    expect(context.relations[0]?.columns).toContain('revenue DOUBLE')
    expect(context.relations[0]?.cautions).toContain('Revenue excludes refunds.')
    expect(context.relations[0]?.exampleValues).toHaveLength(1)
    expect(context.relations[0]?.rowCount).toBe(44_424)
  })

  it('fails clearly when no governed snapshot is active', async () => {
    await expect(getGovernedSourceContext({
      activeSnapshot: async () => null,
      listRelations: async () => { throw new Error('must not list') },
      describeRelation: async () => { throw new Error('must not describe') },
      executeQuery: async () => { throw new Error('must not execute') },
    })).rejects.toThrow('No active source snapshot')
  })
})
