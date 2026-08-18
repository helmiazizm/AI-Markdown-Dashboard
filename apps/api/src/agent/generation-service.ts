import type { GenerationDetailLevel } from '@fieldboard/contracts'
import { getConfig, type AppConfig } from '../config.js'
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
import { loadRevisionContext, type RevisionContext } from './revision-context.js'
import { getAgentAdapter } from './runner.js'

/**
 * Provenance records which model produced a revision, so every LLM-backed mode must report its
 * real model id. Only the demo adapter is deterministic.
 */
export function recordedModel(config: AppConfig): string {
  return config.AGENT_MODE === 'demo' ? 'deterministic-demo' : config.OPENROUTER_MODEL
}

export async function queueGeneration(input: {
  prompt: string
  detailLevel?: GenerationDetailLevel
  dashboardId?: string
  baseRevisionId?: string
}): Promise<string> {
  // This must stay first: it is what guarantees head === indexedHead, and therefore that the
  // projection the revision context is about to be read from has caught up with Git.
  const repository = await assertRepositoryReadyForGeneration()
  let revisionContext: RevisionContext | undefined
  let revisionNumber = 1
  if (input.dashboardId) {
    const current = await getCurrentRevision(input.dashboardId)
    if (!current) throw new Error('Dashboard not found')
    if (current.id !== input.baseRevisionId) {
      const error = new Error('The dashboard has a newer revision. Reload before refining it.')
      error.name = 'StaleRevisionError'
      throw error
    }
    revisionNumber = current.revisionNumber + 1
    // A snapshot taken now. The projection may be rebuilt while the crew runs, which is safe:
    // revision ids come from provenance.json and survive a rebuild, and prepareGenerationPublication
    // rechecks the base under FOR UPDATE before publishing.
    revisionContext = await loadRevisionContext(input.dashboardId, current.id) ?? undefined
  }

  const config = getConfig()
  const runId = await createGenerationRun({
    mode: input.dashboardId ? 'refine' : 'create',
    prompt: input.prompt,
    detailLevel: input.detailLevel ?? 'standard',
    model: recordedModel(config),
    pipeline: config.AGENT_MODE,
    dashboardId: input.dashboardId,
    baseRevisionId: input.baseRevisionId,
  })
  setImmediate(() => void runGeneration({ ...input, runId, revisionContext, revisionNumber, expectedHead: repository.head }))
  return runId
}

async function runGeneration(input: {
  runId: string
  prompt: string
  detailLevel?: GenerationDetailLevel
  dashboardId?: string
  baseRevisionId?: string
  revisionContext?: RevisionContext
  revisionNumber: number
  expectedHead: string | null
}): Promise<void> {
  const config = getConfig()
  try {
    await markGenerationRunning(input.runId)
    const result = await getAgentAdapter().generate({
      prompt: input.prompt,
      detailLevel: input.detailLevel ?? 'standard',
      revisionContext: input.revisionContext,
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
      model: recordedModel(config),
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
