import pg from 'pg'
import { getConfig } from '../config.js'

const { Pool, types } = pg

// Keep bigint values exact in storage-facing code; API serializers normalize them.
types.setTypeParser(20, (value) => Number(value))

export const pool = new Pool({
  connectionString: getConfig().DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
})

export async function closePools(): Promise<void> {
  await pool.end()
}

export const closePool = closePools
