import { serve } from '@hono/node-server'
import { app } from './app.js'
import { getConfig } from './config.js'
import { closePools } from './db/pool.js'
import { recoverUnfinishedPublications } from './content/publication-service.js'
import { recoverInterruptedGenerationRuns } from './db/repository.js'

const port = getConfig().API_PORT
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Fieldboard API listening on http://localhost:${info.port}`)
  void recoverInterruptedGenerationRuns()
    .then(recoverUnfinishedPublications)
    .catch((error) => console.error('Startup recovery failed:', error))
})

async function shutdown(): Promise<void> {
  server.close()
  await closePools()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
