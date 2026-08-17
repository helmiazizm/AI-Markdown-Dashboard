import { mkdir, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePools } from '../db/pool.js'
import { sqlLiteral } from './duckdb.js'
import { bumpRelationRevision } from './warehouse-relations.js'
import { createWarehouseConnection, ensureProjectSchemas, openProjectDatabase, warehouseFilePath } from './warehouse-files.js'

const RELATION = 'fashion.catalog.products'
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
const DEFAULT_CACHE = path.resolve(REPO_ROOT, 'data/raw/fashion-train.csv')
const DEFAULT_URL = 'https://huggingface.co/datasets/nreimers/fashion-dataset/resolve/main/train.csv'

const PRODUCT_COLUMNS = `
  product_id,
  gender,
  master_category,
  sub_category,
  article_type,
  base_colour,
  season,
  year,
  usage,
  product_display_name
`

function pickColumn(columns: string[], ...candidates: string[]): string | null {
  const lower = new Map(columns.map((column) => [column.toLowerCase(), column]))
  for (const candidate of candidates) {
    const match = lower.get(candidate.toLowerCase())
    if (match) return match
  }
  return null
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

async function describeCsv(file: string): Promise<string[]> {
  const connection = await createWarehouseConnection({ memoryLimit: '512MB', threads: '2' })
  try {
    const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM read_csv_auto(${sqlLiteral(file)}, header=true)`)
    return reader.getRows().map((row) => String(row[0]))
  } finally {
    connection.closeSync()
  }
}

function transformSelect(columns: string[], file: string): string {
  const required = {
    productId: pickColumn(columns, 'product_id', 'id'),
    gender: pickColumn(columns, 'gender'),
    masterCategory: pickColumn(columns, 'master_category', 'masterCategory'),
    subCategory: pickColumn(columns, 'sub_category', 'subCategory'),
    articleType: pickColumn(columns, 'article_type', 'articleType'),
    baseColour: pickColumn(columns, 'base_colour', 'baseColour'),
    season: pickColumn(columns, 'season'),
    year: pickColumn(columns, 'year'),
    usage: pickColumn(columns, 'usage'),
    displayName: pickColumn(columns, 'product_display_name', 'productDisplayName'),
  }
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) throw new Error(`Fashion catalog is missing columns: ${missing.join(', ')}`)
  return `
    SELECT
      TRY_CAST(${quoteIdent(required.productId!)} AS INTEGER) AS product_id,
      ${quoteIdent(required.gender!)} AS gender,
      ${quoteIdent(required.masterCategory!)} AS master_category,
      ${quoteIdent(required.subCategory!)} AS sub_category,
      ${quoteIdent(required.articleType!)} AS article_type,
      ${quoteIdent(required.baseColour!)} AS base_colour,
      ${quoteIdent(required.season!)} AS season,
      TRY_CAST(${quoteIdent(required.year!)} AS INTEGER) AS year,
      ${quoteIdent(required.usage!)} AS usage,
      ${quoteIdent(required.displayName!)} AS product_display_name
    FROM read_csv_auto(${sqlLiteral(file)}, header=true)
  `
}

async function cachedFileLooksComplete(file: string): Promise<boolean> {
  try {
    const info = await stat(file)
    return info.isFile() && info.size > 100_000
  } catch {
    return false
  }
}

async function downloadCatalog(url: string, destination: string): Promise<void> {
  if (await cachedFileLooksComplete(destination)) {
    console.log(`Using cached fashion catalog at ${destination}`)
    return
  }
  console.log(`Downloading fashion catalog from ${url}`)
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'fieldboard-setup/0.1' },
  })
  if (!response.ok) throw new Error(`Fashion catalog download failed ${response.status} ${url}`)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function resolveSourceFile(): Promise<string> {
  const configured = process.env.FASHION_CATALOG_FILE
  if (configured) return configured
  const url = process.env.FASHION_CATALOG_URL || DEFAULT_URL
  await downloadCatalog(url, DEFAULT_CACHE)
  return DEFAULT_CACHE
}

export async function loadFashionCatalog(): Promise<void> {
  await ensureProjectSchemas('fashion')
  const sourceFile = await resolveSourceFile()
  const columns = await describeCsv(sourceFile)
  const selectSql = transformSelect(columns, sourceFile)
  const target = await openProjectDatabase('fashion')
  let rows = 0
  try {
    await target.run('DELETE FROM catalog.products')
    await target.run(`INSERT INTO catalog.products (${PRODUCT_COLUMNS}) ${selectSql}`)
    await target.run('CHECKPOINT')
    const count = await target.runAndReadAll('SELECT count(*) FROM catalog.products')
    rows = Number(count.getRows()[0]?.[0] ?? 0)
  } finally {
    target.closeSync()
  }
  if (!rows) throw new Error('Fashion catalog load produced no rows')
  const verify = await openProjectDatabase('fashion')
  try {
    const persisted = await verify.runAndReadAll('SELECT count(*) FROM catalog.products')
    const persistedRows = Number(persisted.getRows()[0]?.[0] ?? 0)
    if (persistedRows !== rows) {
      throw new Error(`Fashion catalog did not persist (${persistedRows} rows on reopen, expected ${rows})`)
    }
  } finally {
    verify.closeSync()
  }
  const revision = await bumpRelationRevision(RELATION)
  console.log(`fashion.catalog.products ready: ${rows.toLocaleString()} rows at source_revision=${revision} from ${warehouseFilePath('fashion')}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadFashionCatalog().then(closePools).catch(async (error) => {
    console.error(error)
    await closePools()
    process.exitCode = 1
  })
}
