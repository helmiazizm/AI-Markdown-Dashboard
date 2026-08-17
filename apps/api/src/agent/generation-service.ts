import type { DashboardArtifactV1, GenerationDetailLevel } from '@fieldboard/contracts'
import { getConfig } from '../config.js'
import {
  addGenerationEvent,
  createGenerationRun,
  getCurrentRevision,
  markGenerationFailed,
  markGenerationRunning,
} from '../db/repository.js'
import { artifactSha256, canonicalizeDashboardArtifact } from '../content/codec.js'
import { prepareGenerationPublication } from '../content/persistence.js'
import { assertRepositoryReadyForGeneration, publishPreparedRevision } from '../content/publication-service.js'
import { getAgentAdapter } from './runner.js'

export async function queueGeneration(input: {
  prompt: string
  detailLevel?: GenerationDetailLevel
  dashboardId?: string
  baseRevisionId?: string
}): Promise<string> {
  const repository = await assertRepositoryReadyForGeneration()
  let currentArtifact: DashboardArtifactV1 | undefined
  let revisionNumber = 1
  if (input.dashboardId) {
    const current = await getCurrentRevision(input.dashboardId)
    if (!current) throw new Error('Dashboard not found')
    if (current.id !== input.baseRevisionId) {
      const error = new Error('The dashboard has a newer revision. Reload before refining it.')
      error.name = 'StaleRevisionError'
      throw error
    }
    currentArtifact = current.artifact
    revisionNumber = current.revisionNumber + 1
  }

  const config = getConfig()
  const runId = await createGenerationRun({
    mode: input.dashboardId ? 'refine' : 'create',
    prompt: input.prompt,
    detailLevel: input.detailLevel ?? 'standard',
    model: config.AGENT_MODE === 'cline' ? config.OPENROUTER_MODEL : 'deterministic-demo',
    dashboardId: input.dashboardId,
    baseRevisionId: input.baseRevisionId,
  })
  setImmediate(() => void runGeneration({ ...input, runId, currentArtifact, revisionNumber, expectedHead: repository.head }))
  return runId
}

async function runGeneration(input: {
  runId: string
  prompt: string
  detailLevel?: GenerationDetailLevel
  dashboardId?: string
  baseRevisionId?: string
  currentArtifact?: DashboardArtifactV1
  revisionNumber: number
  expectedHead: string | null
}): Promise<void> {
  const config = getConfig()
  try {
    await markGenerationRunning(input.runId)
    const result = await getAgentAdapter().generate({
      prompt: input.prompt,
      detailLevel: input.detailLevel ?? 'standard',
      currentArtifact: input.currentArtifact,
      revisionNumber: input.revisionNumber,
      onStage: (type, message, payload) => addGenerationEvent(input.runId, type, message, payload),
    })
    const artifact = canonicalizeDashboardArtifact(result.artifact)
    const prepared = await prepareGenerationPublication({
      runId: input.runId,
      prompt: input.prompt,
      artifact,
      artifactHash: artifactSha256(artifact),
      results: result.results,
      model: config.AGENT_MODE === 'cline' ? config.OPENROUTER_MODEL : 'deterministic-demo',
      usage: result.usage,
      dashboardId: input.dashboardId,
      baseRevisionId: input.baseRevisionId,
      expectedHead: input.expectedHead,
    })
    await publishPreparedRevision(prepared.id)
  } catch (error) {
    await markGenerationFailed(input.runId, error instanceof Error ? error.message : String(error))
  }
}
