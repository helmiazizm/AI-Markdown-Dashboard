import { afterAll, expect, it } from 'vitest'
import { closePools } from '../src/db/pool.js'
import { getAgentAdapter } from '../src/agent/runner.js'
import { resetConfigForTests } from '../src/config.js'

const enabled = process.env.RUN_OPENROUTER_SMOKE === '1' && Boolean(process.env.OPENROUTER_API_KEY)

it.runIf(enabled)('generates a live bounded dashboard through Cline and OpenRouter', async () => {
  process.env.AGENT_MODE = 'cline'
  resetConfigForTests()
  const result = await getAgentAdapter().generate({
    prompt: 'Build one concise chart using a defensible dimension and metric from the active source.',
    detailLevel: 'detailed',
    onStage: async () => undefined,
  })
  expect(result.artifact.widgets.length).toBeGreaterThan(0)
  expect(result.results.size).toBe(result.artifact.datasets.length)
}, 120_000)

afterAll(async () => {
  if (enabled) await closePools()
})
