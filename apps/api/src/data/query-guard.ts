const forbiddenKeywords = [
  'ALTER', 'ATTACH', 'CALL', 'COPY', 'CREATE', 'DELETE', 'DETACH', 'DROP',
  'EXPORT', 'IMPORT', 'INSERT', 'INSTALL', 'LOAD', 'MERGE', 'PRAGMA', 'SET',
  'TRUNCATE', 'UPDATE', 'VACUUM',
]

const forbiddenFunction = /\b(?:read_[a-z0-9_]*|parquet_scan|postgres_[a-z0-9_]*|glob|httpfs_[a-z0-9_]*|file|s3|url|delta_scan|iceberg_scan)\s*\(/i
const forbiddenCatalog = /\b(?:information_schema|duckdb_[a-z0-9_]*)\b/i
const threePartName = /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/i

/**
 * Blanks the contents of single-quoted literals, honouring '' escapes, so that keyword and
 * identifier scanning inspects SQL structure rather than data values. Without this, a filter on
 * a value such as 'Clothing Set' or ILIKE '%drop%' is rejected as if it were a SET or DROP
 * statement. The returned text is for inspection only; callers keep the original SQL.
 */
function maskStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''")
}

export function normalizeReadonlySql(input: string): string {
  const sql = input.trim().replace(/;+\s*$/, '')
  if (!sql) throw new Error('Query is empty')
  if (sql.length > 12_000) throw new Error('Query exceeds 12,000 characters')
  // Comments, statement separators, and URLs are checked against the raw text. A URL is the
  // actual attack vector even inside a literal, because it can be handed to a reader function,
  // whereas a bare keyword inside a literal is inert.
  if (/--|\/\*/.test(sql)) throw new Error('SQL comments are not allowed')
  if (sql.includes(';')) throw new Error('Only one SQL statement is allowed')
  if (/(?:https?|s3|file):\/\//i.test(sql)) throw new Error('External URLs are not allowed')
  if (!/^\s*(?:SELECT|WITH)\b/i.test(sql)) throw new Error('Only SELECT or WITH queries are allowed')
  const inspected = maskStringLiterals(sql)
  for (const keyword of forbiddenKeywords) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(inspected)) throw new Error(`${keyword} is not allowed`)
  }
  if (forbiddenFunction.test(inspected)) throw new Error('External table and file functions are not allowed')
  if (forbiddenCatalog.test(inspected)) throw new Error('System catalogs are not available')
  if (/\bsource_data\b/i.test(inspected)) throw new Error('source_data is not a warehouse relation; use project.schema.table')
  if (!threePartName.test(inspected)) throw new Error('Query must read from a governed project.schema.table relation')
  return sql
}

interface SerializedSql {
  error?: boolean
  statements?: Array<{ node?: unknown }>
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function baseTableName(node: Record<string, unknown>): string {
  const catalog = stringField(node.catalog_name || node.catalog)
  const schema = stringField(node.schema_name || node.schema)
  const table = stringField(node.table_name)
  if (!table) return ''
  if (catalog && schema) return `${catalog}.${schema}.${table}`.toLowerCase()
  if (schema) return `${schema}.${table}`.toLowerCase()
  return table.toLowerCase()
}

export function validateSerializedAst(serialized: string, governed: Set<string>): void {
  let parsed: SerializedSql
  try {
    parsed = JSON.parse(serialized) as SerializedSql
  } catch {
    throw new Error('DuckDB could not serialize the SQL syntax tree')
  }
  if (parsed.error || parsed.statements?.length !== 1) throw new Error('Query must contain exactly one valid statement')
  const statement = parsed.statements[0]?.node as { type?: unknown } | undefined
  if (statement?.type !== 'SELECT_NODE' && statement?.type !== 'CTE_NODE') {
    throw new Error('Only a SELECT statement is allowed')
  }

  const baseTables = new Set<string>()
  const cteNames = new Set<string>()
  walk(statement, (node) => {
    if (node.type === 'CTE_NODE' && typeof node.cte_name === 'string') cteNames.add(node.cte_name.toLowerCase())
    const cteMap = node.cte_map as { map?: Array<{ key?: unknown }> } | undefined
    for (const entry of cteMap?.map ?? []) {
      if (typeof entry.key === 'string') cteNames.add(entry.key.toLowerCase())
    }
  })
  walk(statement, (node) => {
    if (node.type === 'BASE_TABLE') {
      const name = baseTableName(node)
      if (name) baseTables.add(name)
    }
    if (node.type === 'TABLE_FUNCTION') throw new Error('Table functions are not allowed')
    if (typeof node.function_name === 'string' && /^(?:read_|glob|postgres_|parquet_scan|file|s3|url|delta_scan)/i.test(node.function_name)) {
      throw new Error('External table and file functions are not allowed')
    }
  })

  const governedNames = new Set([...governed].map((name) => name.toLowerCase()))
  let governedHits = 0
  for (const table of baseTables) {
    if (cteNames.has(table)) continue
    if (table === 'source_data' || table.endsWith('.source_data')) {
      throw new Error('source_data is not a warehouse relation; use project.schema.table')
    }
    if (!governedNames.has(table)) {
      throw new Error(`Table ${table} is not available`)
    }
    governedHits += 1
  }
  if (!governedHits) throw new Error('Query must read from a governed project.schema.table relation')
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit)
    return
  }
  const node = value as Record<string, unknown>
  visit(node)
  for (const child of Object.values(node)) walk(child, visit)
}
