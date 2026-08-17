import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'

export async function runMigrationDirectory(targetPool: Pool, migrationDir: string, label: string): Promise<void> {
  const client = await targetPool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const files = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])
      if (applied.rowCount) continue
      const sql = await readFile(path.join(migrationDir, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file])
        await client.query('COMMIT')
        console.log(`Applied ${label} migration ${file}`)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    client.release()
  }
}
