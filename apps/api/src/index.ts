import { serve } from '@hono/node-server'
import { app } from './app.js'
import { getConfig } from './config.js'
import { closePools } from './db/pool.js'
import { recoverUnfinishedPublications } from './content/publication-service.js'
import { recoverInterruptedGenerationRuns } from './db/repository.js'

const config = getConfig()

// Surface a missing key once at boot rather than one failed generation at a time. Falling back
// to the demo adapter is deliberately not done: a deterministic dashboard that looks real is
// harder to notice than a clear failure.
if (config.AGENT_MODE !== 'demo' && !config.OPENROUTER_API_KEY) {
  console.warn(
    `AGENT_MODE=${config.AGENT_MODE} requires OPENROUTER_API_KEY. Every generation will fail until it is set. `
    + 'Set AGENT_MODE=demo for a deterministic local agent that needs no key.',
  )
}

const server = serve({ fetch: app.fetch, port: config.API_PORT }, (info) => {
  console.log(`Fieldboard API listening on http://localhost:${info.port} (agent mode: ${config.AGENT_MODE})`)
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
