import { DuckDBInstance } from '@duckdb/node-api'
import { describe, expect, it } from 'vitest'
import { normalizeReadonlySql, validateSerializedAst } from '../src/data/query-guard.js'

const governed = new Set(['fashion.catalog.products', 'tlc.taxi.yellow_trips'])

async function astFor(sql: string): Promise<string> {
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    const reader = await connection.runAndReadAll(
      'SELECT json_serialize_sql($sql::VARCHAR) AS ast',
      { sql },
    )
    const ast = reader.getRows()[0]?.[0]
    if (typeof ast !== 'string') throw new Error('missing ast')
    return ast
  } finally {
    connection.closeSync()
  }
}

describe('DuckDB query guard', () => {
  it('accepts bounded analytical SELECTs against a governed triple', () => {
    expect(normalizeReadonlySql('WITH totals AS (SELECT category FROM fashion.catalog.products) SELECT * FROM totals;'))
      .toMatch(/^WITH/)
  })

  it.each([
    'COPY fashion.catalog.products TO \'/tmp/x\'',
    'SELECT * FROM read_csv_auto(\'/etc/passwd\')',
    'SELECT * FROM fashion.catalog.products; DROP TABLE x',
    'SELECT * FROM information_schema.tables, fashion.catalog.products',
    'SELECT \'https://example.com/data.parquet\' FROM fashion.catalog.products',
    'SELECT * FROM source_data',
    'SELECT * FROM file(\'summaries/x.parquet\')',
    'SELECT * FROM catalog.products',
  ])('rejects unsafe SQL: %s', (sql) => {
    expect(() => normalizeReadonlySql(sql)).toThrow()
  })

  it('accepts a serialized SELECT AST and rejects another table', () => {
    const safe = JSON.stringify({ error: false, statements: [{ node: { type: 'SELECT_NODE', from: { type: 'BASE_TABLE', catalog_name: 'fashion', schema_name: 'catalog', table_name: 'products' } } }] })
    expect(() => validateSerializedAst(safe, governed)).not.toThrow()
    const unsafe = JSON.stringify({ error: false, statements: [{ node: { type: 'SELECT_NODE', from: { type: 'BASE_TABLE', catalog_name: 'fashion', schema_name: 'catalog', table_name: 'secrets' } } }] })
    expect(() => validateSerializedAst(unsafe, governed)).toThrow(/not available/)
  })

  it('allows declared CTE references without allowing hidden base tables', () => {
    const cte = JSON.stringify({ error: false, statements: [{ node: {
      type: 'CTE_NODE', cte_name: 'summary', cte_map: { map: [{ key: 'summary' }] },
      query: { type: 'SELECT_NODE', from_table: { type: 'BASE_TABLE', catalog_name: 'fashion', schema_name: 'catalog', table_name: 'products' } },
      child: { type: 'SELECT_NODE', from_table: { type: 'BASE_TABLE', table_name: 'summary' } },
    } }] })
    expect(() => validateSerializedAst(cte, governed)).not.toThrow()
    const smuggled = cte.replace('products', 'private_table')
    expect(() => validateSerializedAst(smuggled, governed)).toThrow(/not available/)
  })

  it('rejects table functions even when a governed triple is also present', () => {
    const tableFunction = JSON.stringify({ error: false, statements: [{ node: {
      type: 'SELECT_NODE',
      from: {
        type: 'JOIN',
        left: { type: 'BASE_TABLE', catalog_name: 'fashion', schema_name: 'catalog', table_name: 'products' },
        right: { type: 'TABLE_FUNCTION', function: { function_name: 'range' } },
      },
    } }] })
    expect(() => validateSerializedAst(tableFunction, governed)).toThrow(/Table functions/)
  })

  it('accepts a cross-project JOIN and rejects source_data and file()', async () => {
    const join = await astFor('SELECT 1 FROM fashion.catalog.products a JOIN tlc.taxi.yellow_trips b ON true')
    expect(() => validateSerializedAst(join, governed)).not.toThrow()
    await expect(astFor('SELECT 1 FROM source_data').then((ast) => validateSerializedAst(ast, governed)))
      .rejects.toThrow(/source_data|not available/)
    expect(() => normalizeReadonlySql('SELECT * FROM file(\'x.parquet\')')).toThrow(/file functions|source_data|project.schema.table/)
  })
})
