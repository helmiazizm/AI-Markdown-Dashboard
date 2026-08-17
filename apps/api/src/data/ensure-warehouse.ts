import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePools } from '../db/pool.js'
import { pingWarehouse } from './warehouse.js'
import { DEMO_WAREHOUSE_PROJECTS, ensureProjectSchemas, ensureWarehouseDirectory, warehouseDirectory } from './warehouse-files.js'

export async function ensureWarehouse(): Promise<void> {
  const directory = await ensureWarehouseDirectory()
  for (const project of DEMO_WAREHOUSE_PROJECTS) await ensureProjectSchemas(project)
  const ready = await pingWarehouse()
  console.log(`Warehouse files in ${directory}; attach ${ready ? 'ok' : 'failed'}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureWarehouse().then(closePools).catch(async (error) => {
    console.error(error)
    await closePools()
    process.exitCode = 1
  })
}
