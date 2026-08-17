import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from './migrate.js'
import { closePools } from './pool.js'

export async function migrateAll(): Promise<void> {
  await migrate()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrateAll().then(closePools).catch(async (error) => {
    console.error(error)
    await closePools()
    process.exitCode = 1
  })
}
