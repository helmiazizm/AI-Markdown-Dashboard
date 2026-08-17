import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePools, pool } from './pool.js'
import { runMigrationDirectory } from './migration-runner.js'

export async function migrate(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  await runMigrationDirectory(pool, path.resolve(currentDir, '../../migrations'), 'application')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().then(closePools).catch(async (error) => {
    console.error(error)
    await closePools()
    process.exitCode = 1
  })
}
