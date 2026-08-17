import { Agent, createTool } from '@cline/sdk'
import { getConfig } from '../../config.js'
import type { RoleRunRequest, RoleRunResult, RunRole } from './orchestrator.js'

/**
 * Default RunRole: one Cline agent per role over OpenRouter. Cost is tracked against the crew
 * ceiling across all roles in a run, and the whole pipeline shares one wall-clock deadline so a
 * stalled role can never outlive the generation timeout.
 */
export function createClineRoleRunner(): RunRole {
  const config = getConfig()
  const deadline = Date.now() + config.AGENT_RUN_TIMEOUT_MS
  let spentUsd = 0

  return async function runRole(request: RoleRunRequest): Promise<RoleRunResult> {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new Error(`Generation deadline exceeded before the ${request.role} role could run`)

    const tools = request.tools.map((tool) => createTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: tool.execute,
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
      ...(tool.retryable === undefined ? {} : { retryable: tool.retryable }),
    } as never))

    const toolPolicies = Object.fromEntries(
      request.tools.map((tool) => [tool.name, { enabled: true, autoApprove: true }]),
    )

    const agent = new Agent({
      providerId: 'openrouter',
      modelId: request.modelId,
      apiKey: config.OPENROUTER_API_KEY,
      systemPrompt: request.systemPrompt,
      tools,
      toolPolicies,
      maxIterations: config.AGENT_MAX_ITERATIONS,
      maxTokensPerTurn: config.AGENT_MAX_TOKENS_PER_TURN,
      completionPolicy: { completionGuard: request.completionGuard },
    } as never)

    let roleCost = 0
    agent.subscribe((event: unknown) => {
      const value = event as { type?: string; usage?: { totalCost?: number } }
      if (value.type !== 'usage-updated') return
      roleCost = value.usage?.totalCost ?? roleCost
      if (spentUsd + roleCost > config.CREW_MAX_COST_USD) {
        agent.abort(`Crew cost ceiling exceeded ($${config.CREW_MAX_COST_USD.toFixed(2)})`)
      }
    })

    const timeout = setTimeout(() => {
      agent.abort(`Generation deadline exceeded during the ${request.role} role`)
    }, remainingMs)

    try {
      const run = await agent.run(request.prompt)
      if (run.status !== 'completed') throw run.error ?? new Error(`The ${request.role} role ${run.status}`)
      return { usage: run.usage as unknown as Record<string, unknown> }
    } finally {
      clearTimeout(timeout)
      spentUsd += roleCost
    }
  }
}
