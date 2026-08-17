import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import dns from 'node:dns'
import { DuckDBInstance } from '@duckdb/node-api'
import { getConfig } from '../config.js'
import { closePools } from '../db/pool.js'
import { sqlLiteral } from './duckdb.js'
import { bumpRelationRevision } from './warehouse-relations.js'
import { ensureProjectSchemas, openProjectDatabase, warehouseFilePath } from './warehouse-files.js'

dns.setDefaultResultOrder('ipv4first')

const TLC_PARQUET = 'https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_{yyyy}-{mm}.parquet'
const TLC_ZONES = 'https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv'
const RELATION = 'tlc.taxi.yellow_trips'

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function parquetUrl(year: number, month: number): string {
  return TLC_PARQUET
    .replace('{yyyy}', String(year))
    .replace('{mm}', String(month).padStart(2, '0'))
}

function pickColumn(columns: string[], ...candidates: string[]): string | null {
  const lower = new Map(columns.map((column) => [column.toLowerCase(), column]))
  for (const candidate of candidates) {
    const match = lower.get(candidate.toLowerCase())
    if (match) return match
  }
  return null
}

async function download(url: string): Promise<Buffer | null> {
  const response = await fetch(url, { redirect: 'follow' })
  if (response.status === 403 || response.status === 404) return null
  if (!response.ok) throw new Error(`Download failed ${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

function plannedMonths(): Array<{ year: number; month: number; url: string }> {
  return [1, 2, 3].map((month) => ({ year: 2026, month, url: parquetUrl(2026, month) }))
}

async function remoteParquetAvailable(url: string): Promise<boolean> {
  const probe = async (method: 'HEAD' | 'GET') => fetch(url, { method, redirect: 'follow' })
  const head = await probe('HEAD')
  if (head.status === 404) return false
  if (head.ok) return true
  const get = await probe('GET')
  if (get.status === 403 || get.status === 404) return false
  if (!get.ok) throw new Error(`Download failed ${get.status} ${url}`)
  return true
}

async function describeParquet(connection: Awaited<ReturnType<DuckDBInstance['connect']>>, file: string): Promise<string[]> {
  const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlLiteral(file)})`)
  return reader.getRows().map((row) => String(row[0]))
}

function transformSelect(columns: string[], dataMonth: string, file: string): string {
  const required = {
    pickup: pickColumn(columns, 'tpep_pickup_datetime', 'pickup_datetime'),
    dropoff: pickColumn(columns, 'tpep_dropoff_datetime', 'dropoff_datetime'),
    distance: pickColumn(columns, 'trip_distance'),
    puLocation: pickColumn(columns, 'PULocationID', 'pulocationid'),
    payment: pickColumn(columns, 'payment_type'),
    fare: pickColumn(columns, 'fare_amount'),
    total: pickColumn(columns, 'total_amount'),
  }
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) throw new Error(`Parquet is missing columns: ${missing.join(', ')}`)
  const cbd = pickColumn(columns, 'cbd_congestion_fee')
  return `
    SELECT
      DATE ${sqlLiteral(dataMonth)} AS data_month,
      ${quoteIdent(required.pickup!)} AS pickup_datetime,
      ${quoteIdent(required.distance!)} AS trip_distance_miles,
      date_diff('second', ${quoteIdent(required.pickup!)}, ${quoteIdent(required.dropoff!)}) / 60.0 AS trip_duration_minutes,
      z.zone AS pu_zone,
      z.borough AS pu_borough,
      CAST(${quoteIdent(required.payment!)} AS INTEGER) AS payment_type,
      ${quoteIdent(required.fare!)} AS fare_amount,
      ${quoteIdent(required.total!)} AS total_amount,
      ${cbd ? quoteIdent(cbd) : 'NULL'} AS cbd_congestion_fee,
      hour(${quoteIdent(required.pickup!)}) AS pickup_hour,
      isodow(${quoteIdent(required.pickup!)}) AS pickup_iso_dow,
      dayname(${quoteIdent(required.pickup!)}) AS pickup_day_name
    FROM read_parquet(${sqlLiteral(file)}) t
    LEFT JOIN taxi_zones z ON z.location_id = CAST(t.${quoteIdent(required.puLocation!)} AS INTEGER)
  `
}

async function createTransformConnection() {
  const config = getConfig()
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '4',
    memory_limit: '4GB',
    extension_directory: path.resolve(config.DUCKDB_EXTENSION_DIRECTORY),
  })
  const connection = await instance.connect()
  await connection.run('INSTALL httpfs; LOAD httpfs;')
  return connection
}

async function loadedMonths(connection: Awaited<ReturnType<typeof openProjectDatabase>>): Promise<Set<string>> {
  const reader = await connection.runAndReadAll(`
    SELECT DISTINCT strftime(data_month, '%Y-%m') FROM taxi.yellow_trips
  `)
  return new Set(reader.getRows().map((row) => String(row[0])))
}

async function loadFromPostgres(pgUrl: string): Promise<number> {
  const config = getConfig()
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '4',
    memory_limit: '4GB',
    extension_directory: path.resolve(config.DUCKDB_EXTENSION_DIRECTORY),
  })
  const scanner = await instance.connect()
  try {
    await scanner.run('INSTALL postgres; LOAD postgres;')
    await scanner.run(`ATTACH ${sqlLiteral(pgUrl)} AS pg (TYPE postgres)`)
    await scanner.run(`ATTACH ${sqlLiteral(warehouseFilePath('tlc'))} AS tlc`)
    await scanner.run('DELETE FROM tlc.taxi.yellow_trips')
    await scanner.run(`
      INSERT INTO tlc.taxi.yellow_trips
      SELECT
        data_month,
        pickup_datetime,
        trip_distance_miles,
        trip_duration_minutes,
        pu_zone,
        pu_borough,
        payment_type,
        fare_amount,
        total_amount,
        cbd_congestion_fee,
        pickup_hour,
        pickup_iso_dow,
        pickup_day_name
      FROM pg.public.source_data
      WHERE data_month IS NOT NULL
    `)
    const count = await scanner.runAndReadAll('SELECT count(*) FROM tlc.taxi.yellow_trips')
    return Number(count.getRows()[0]?.[0] ?? 0)
  } finally {
    scanner.closeSync()
  }
}

export async function loadTlcYellow(): Promise<void> {
  await ensureProjectSchemas('tlc')
  const pgUrl = process.env.TLC_SOURCE_DATABASE_URL
  if (pgUrl) {
    console.log(`Copying TLC yellow trips from Postgres into ${warehouseFilePath('tlc')}`)
    const rows = await loadFromPostgres(pgUrl)
    if (!rows) throw new Error('Postgres source_data did not contain TLC rows')
    const revision = await bumpRelationRevision(RELATION)
    console.log(`tlc.taxi.yellow_trips ready: ${rows.toLocaleString()} rows at source_revision=${revision}`)
    return
  }

  console.log('Loading TLC yellow taxi files into tlc.taxi.yellow_trips (partition key data_month)')
  const target = await openProjectDatabase('tlc')
  const transform = await createTransformConnection()
  const tempDir = await mkdtemp(path.join(tmpdir(), 'fieldboard-tlc-'))
  try {
    const already = await loadedMonths(target)
    const zoneFile = path.join(tempDir, 'taxi_zone_lookup.csv')
    const zoneBytes = await download(TLC_ZONES)
    if (!zoneBytes) throw new Error('Could not download the TLC taxi zone lookup')
    await writeFile(zoneFile, zoneBytes)
    await transform.run(`
      CREATE TABLE taxi_zones AS
      SELECT CAST(LocationID AS INTEGER) AS location_id, Borough AS borough, Zone AS zone, service_zone
      FROM read_csv_auto(${sqlLiteral(zoneFile)}, header=true)
    `)

    let loadedMonthsCount = already.size
    for (const month of plannedMonths()) {
      const key = `${month.year}-${String(month.month).padStart(2, '0')}`
      if (already.has(key)) {
        console.log(`Skipping already loaded ${key}`)
        continue
      }
      const started = Date.now()
      if (!await remoteParquetAvailable(month.url)) {
        console.log(`Skipping unpublished ${key}`)
        continue
      }
      const columns = await describeParquet(transform, month.url)
      const dataMonth = `${key}-01`
      const select = transformSelect(columns, dataMonth, month.url)
      const monthFile = path.join(tempDir, `month-${key}.parquet`)
      await transform.run(`COPY (${select}) TO ${sqlLiteral(monthFile)} (FORMAT parquet)`)
      await target.run(`
        INSERT INTO taxi.yellow_trips
        SELECT * FROM read_parquet(${sqlLiteral(monthFile)})
      `)
      await target.run('CHECKPOINT')
      const count = await target.runAndReadAll(
        `SELECT count(*) FROM taxi.yellow_trips WHERE data_month = DATE ${sqlLiteral(dataMonth)}`,
      )
      const rows = Number(count.getRows()[0]?.[0] ?? 0)
      await rm(monthFile, { force: true })
      console.log(`Loaded ${key}: ${rows.toLocaleString()} rows in ${Math.round((Date.now() - started) / 1000)}s`)
      loadedMonthsCount += 1
    }
    if (!loadedMonthsCount) throw new Error('No TLC monthly files were loaded')
  } finally {
    transform.closeSync()
    target.closeSync()
    await rm(tempDir, { recursive: true, force: true })
  }

  const published = await openProjectDatabase('tlc')
  try {
    const count = await published.runAndReadAll('SELECT count(*) FROM taxi.yellow_trips')
    await published.run('CHECKPOINT')
    const revision = await bumpRelationRevision(RELATION)
    console.log(`tlc.taxi.yellow_trips ready: ${Number(count.getRows()[0]?.[0] ?? 0).toLocaleString()} rows at source_revision=${revision}`)
  } finally {
    published.closeSync()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadTlcYellow().then(closePools).catch(async (error) => {
    console.error(error)
    await closePools()
    process.exitCode = 1
  })
}
