import { Agent, createTool } from '@cline/sdk'
import {
  authoringQueryRequestSchema,
  dashboardArtifactSchema,
  validateDashboardArtifact,
  type DashboardArtifactV1,
  type DatasetSpec,
  type GenerationDetailLevel,
  type GenerationEventType,
} from '@fieldboard/contracts'
import { z } from 'zod'
import { getConfig } from '../config.js'
import { getGovernedSourceContext } from '../data/source-context.js'
import { executeDatasetQuery, type QueryExecutionResult } from '../data/query-service.js'
import { listWarehouseRelations } from '../data/warehouse-relations.js'
import { createDemoArtifact } from './demo.js'
import { buildRunPrompt, dashboardAgentSystemPrompt } from './prompts.js'

export interface AgentRunInput {
  prompt: string
  detailLevel: GenerationDetailLevel
  currentArtifact?: DashboardArtifactV1
  revisionNumber?: number
  onStage: (type: GenerationEventType, message: string, payload?: Record<string, unknown>) => Promise<void>
}

export interface AgentDashboardResult {
  artifact: DashboardArtifactV1
  results: Map<string, QueryExecutionResult>
  usage?: Record<string, unknown>
}

export interface DashboardAgentAdapter {
  generate(input: AgentRunInput): Promise<AgentDashboardResult>
}

async function executeFinalQueries(
  artifact: DashboardArtifactV1,
  input: Pick<AgentRunInput, 'detailLevel' | 'onStage'>,
): Promise<Map<string, QueryExecutionResult>> {
  const results = new Map<string, QueryExecutionResult>()
  await input.onStage('validating', 'Re-running final queries and checking widget references.', input.detailLevel === 'detailed'
    ? { kind: 'final_validation', datasetCount: artifact.datasets.length, widgetCount: artifact.widgets.length }
    : undefined)
  for (const [index, dataset] of artifact.datasets.entries()) {
    if (input.detailLevel === 'detailed') {
      await input.onStage('validating', `Validating dataset ${index + 1}: ${dataset.question}`, {
        kind: 'dataset_validation',
        datasetId: dataset.id,
        question: dataset.question,
        sql: dataset.sql,
        expectedColumns: dataset.expectedColumns,
        maxRows: dataset.maxRows,
      })
    }
    const result = await executeDatasetQuery(dataset)
    results.set(dataset.id, result)
    if (input.detailLevel === 'detailed') {
      await input.onStage('validating', `Dataset ${dataset.id} passed with ${result.rowCount.toLocaleString()} rows.`, {
        kind: 'dataset_result',
        datasetId: dataset.id,
        columns: result.columns,
        rowCount: result.rowCount,
        truncated: result.truncated,
        snapshotDate: result.snapshot.snapshotDate,
      })
    }
  }
  return results
}

class DemoAgentAdapter implements DashboardAgentAdapter {
  async generate(input: AgentRunInput): Promise<AgentDashboardResult> {
    const context = input.detailLevel === 'detailed' ? await getGovernedSourceContext() : null
    await input.onStage('inspecting', 'Reading the active governed source context.', context
      ? {
          kind: 'source_context',
          relationCount: context.relations.length,
          relations: context.relations.map((relation) => relation.qualifiedName),
          snapshotDate: context.activeSnapshot.snapshotDate,
          rowCount: context.activeSnapshot.rowCount,
        }
      : undefined)
    const relations = await listWarehouseRelations()
    const artifact = validateDashboardArtifact(createDemoArtifact(
      input.prompt,
      input.revisionNumber ?? 1,
      relations.map((relation) => relation.qualifiedName),
    ))
    await input.onStage('querying', 'Testing the schema-independent warehouse query.')
    const results = await executeFinalQueries(artifact, input)
    await input.onStage('composing', 'Composing the analytical fieldbook and chart specifications.', input.detailLevel === 'detailed'
      ? {
          kind: 'artifact_summary',
          title: artifact.title,
          datasetCount: artifact.datasets.length,
          widgetCount: artifact.widgets.length,
          renderers: [...new Set(artifact.widgets.map((widget) => widget.engine))],
        }
      : undefined)
    return { artifact, results, usage: { adapter: 'deterministic-demo', iterations: 1, costUsd: 0 } }
  }
}

class ClineAgentAdapter implements DashboardAgentAdapter {
  async generate(input: AgentRunInput): Promise<AgentDashboardResult> {
    const config = getConfig()
    if (!config.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required when AGENT_MODE=cline')
    let submitted: DashboardArtifactV1 | undefined
    let submissionError: string | undefined
    let queryCount = 0

    const getSourceContext = createTool({
      name: 'get_source_context',
      description: 'Return the governed warehouse catalog of project.schema.table relations, including grain, columns, cautions, snapshot metadata, and bounded example rows. Call this exactly once before querying.',
      inputSchema: z.object({}),
      execute: async () => {
        const context = await getGovernedSourceContext()
        await input.onStage('inspecting', 'Source context loaded; the agent is choosing defensible metrics.', input.detailLevel === 'detailed'
          ? {
              kind: 'source_context',
              relationCount: context.relations.length,
              relations: context.relations.map((relation) => relation.qualifiedName),
              snapshotDate: context.activeSnapshot.snapshotDate,
              rowCount: context.activeSnapshot.rowCount,
              columnCount: context.relations.reduce((sum, relation) => sum + relation.columns.length, 0),
              exampleRowCount: context.relations.reduce((sum, relation) => sum + relation.exampleValues.length, 0),
              cautions: context.relations.flatMap((relation) => relation.cautions),
            }
          : undefined)
        return context
      },
    })

    const runReadonlyQuery = createTool({
      name: 'run_readonly_query',
      description: 'Execute one validated read-only DuckDB SELECT/WITH query over registered project.schema.table relations. JOINs among those triples are allowed. No source_data, URL, file function, extension, pragma, or mutation is accepted. Returns at most 500 rows and 2 MB. Does not write a summary table.',
      inputSchema: authoringQueryRequestSchema,
      execute: async (dataset: Omit<DatasetSpec, 'id'>) => {
        if (queryCount >= 20) return { output: { error: 'Per-run query budget exceeded' }, isError: true }
        queryCount += 1
        await input.onStage('querying', input.detailLevel === 'detailed'
          ? `Query ${queryCount}: ${dataset.question}`
          : `The agent is testing query ${queryCount}.`, input.detailLevel === 'detailed'
          ? {
              kind: 'query_plan',
              queryNumber: queryCount,
              question: dataset.question,
              sql: dataset.sql,
              expectedColumns: dataset.expectedColumns,
              maxRows: dataset.maxRows,
            }
          : undefined)
        try {
          const result = await executeDatasetQuery({ ...dataset, id: `agent-query-${queryCount}` })
          if (input.detailLevel === 'detailed') {
            await input.onStage('querying', `Query ${queryCount} returned ${result.rowCount.toLocaleString()} rows across ${result.columns.length} columns.`, {
              kind: 'query_result',
              queryNumber: queryCount,
              columns: result.columns,
              rowCount: result.rowCount,
              truncated: result.truncated,
            })
          }
          return { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (input.detailLevel === 'detailed') {
            await input.onStage('querying', `Query ${queryCount} was rejected and returned to the agent for correction.`, {
              kind: 'query_error', queryNumber: queryCount, question: dataset.question, error: message,
            })
          }
          return { output: { error: message }, isError: true }
        }
      },
      timeoutMs: config.QUERY_TIMEOUT_MS + 2_000,
      retryable: false,
    })

    const submitDashboard = createTool({
      name: 'submit_dashboard',
      description: 'Validate and submit the complete DashboardArtifactV1. This is the only way to finish the run. Validation errors are returned for correction.',
      inputSchema: dashboardArtifactSchema,
      execute: async (artifact: DashboardArtifactV1) => {
        try {
          submitted = validateDashboardArtifact(artifact)
          submissionError = undefined
          await input.onStage('composing', 'The agent composed a complete dashboard artifact.', input.detailLevel === 'detailed'
            ? {
                kind: 'artifact_summary',
                title: submitted.title,
                datasetCount: submitted.datasets.length,
                widgetCount: submitted.widgets.length,
                renderers: [...new Set(submitted.widgets.map((widget) => widget.engine))],
              }
            : undefined)
          return { accepted: true, title: submitted.title, datasets: submitted.datasets.length, widgets: submitted.widgets.length }
        } catch (error) {
          submitted = undefined
          submissionError = error instanceof Error ? error.message : String(error)
          await input.onStage('validating', `Dashboard submission rejected: ${submissionError}`, input.detailLevel === 'detailed'
            ? { kind: 'artifact_error', error: submissionError }
            : undefined)
          return { output: { accepted: false, error: submissionError }, isError: true }
        }
      },
      retryable: false,
    })

    const agentConfig = {
      providerId: 'openrouter',
      modelId: config.OPENROUTER_MODEL,
      apiKey: config.OPENROUTER_API_KEY,
      systemPrompt: dashboardAgentSystemPrompt,
      tools: [getSourceContext, runReadonlyQuery, submitDashboard],
      toolPolicies: {
        get_source_context: { enabled: true, autoApprove: true },
        run_readonly_query: { enabled: true, autoApprove: true },
        submit_dashboard: { enabled: true, autoApprove: true },
      },
      maxIterations: config.AGENT_MAX_ITERATIONS,
      maxTokensPerTurn: config.AGENT_MAX_TOKENS_PER_TURN,
      completionPolicy: {
        completionGuard: () => submitted
          ? undefined
          : submissionError
            ? `The dashboard was not accepted: ${submissionError}. Correct the artifact and call submit_dashboard again.`
            : 'You must call submit_dashboard with a complete, valid artifact before finishing.',
      },
    }
    const agent = new Agent(agentConfig)

    agent.subscribe((event: unknown) => {
      const value = event as { type?: string; usage?: { totalCost?: number } }
      if (value.type === 'usage-updated' && (value.usage?.totalCost ?? 0) > config.AGENT_MAX_COST_USD) {
        agent.abort(`Cost ceiling exceeded ($${config.AGENT_MAX_COST_USD.toFixed(2)})`)
      }
    })

    const runTimeout = setTimeout(() => {
      agent.abort(`Generation deadline exceeded (${Math.round(config.AGENT_RUN_TIMEOUT_MS / 1000)} seconds)`)
    }, config.AGENT_RUN_TIMEOUT_MS)
    const run = await agent.run(buildRunPrompt(input)).finally(() => clearTimeout(runTimeout))
    if (run.status !== 'completed') throw run.error ?? new Error(`Cline run ${run.status}`)
    if (!submitted) {
      throw new Error(submissionError
        ? `Cline completed without an accepted submit_dashboard call: ${submissionError}`
        : 'Cline completed without an accepted submit_dashboard call')
    }
    const artifact = validateDashboardArtifact(submitted)
    const results = await executeFinalQueries(artifact, input)
    return { artifact, results, usage: run.usage as unknown as Record<string, unknown> }
  }
}

export function getAgentAdapter(): DashboardAgentAdapter {
  return getConfig().AGENT_MODE === 'cline' ? new ClineAgentAdapter() : new DemoAgentAdapter()
}
