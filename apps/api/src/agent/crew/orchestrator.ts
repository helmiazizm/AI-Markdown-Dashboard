import {
  authoringQueryRequestSchema,
  dashboardArtifactSchema,
  validateDashboardArtifact,
  type DashboardArtifactV1,
  type DatasetSpec,
} from '@fieldboard/contracts'
import { z } from 'zod'
import { getConfig } from '../../config.js'
import { normalizeReadonlySql } from '../../data/query-guard.js'
import { executeDatasetQuery } from '../../data/query-service.js'
import { getGovernedSourceContext } from '../../data/source-context.js'
import type { AgentRunInput } from '../runner.js'
import { renderPromptTrail } from '../revision-context.js'
import {
  analysisSubmissionSchema,
  dashboardBriefSchema,
  layoutSubmissionSchema,
  normalizeLayoutSubmission,
  salvageLayoutSubmission,
  type AnalysisSubmission,
  type CrewRole,
  type DashboardBrief,
  type LayoutSubmission,
} from './contracts.js'
import { carryOverAnalysis, carryOverArtifactSql, carryOverLayout, summarizeChangePlan } from './carry-over.js'
import { assembleArtifact } from './fallbacks.js'
import {
  analysisSystemPrompt,
  buildAnalysisPrompt,
  buildLayoutPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  layoutSystemPrompt,
  plannerSystemPrompt,
  reviewerSystemPrompt,
} from './roles.js'

export interface RoleTool {
  name: string
  description: string
  inputSchema: z.ZodType
  execute: (input: never) => Promise<unknown>
  timeoutMs?: number
  retryable?: boolean
}

export interface RoleRunRequest {
  role: CrewRole
  modelId: string
  systemPrompt: string
  prompt: string
  tools: RoleTool[]
  /** Returns a nudge while the role has not produced an acceptable submission yet. */
  completionGuard: () => string | undefined
}

export interface RoleRunResult {
  usage?: Record<string, unknown>
}

/** The single seam the pipeline needs to run without a network. Tests supply a stub. */
export type RunRole = (request: RoleRunRequest) => Promise<RoleRunResult>

const MAX_REVIEWER_ATTEMPTS = 2

/**
 * Role enum values are internal identifiers. Interpolating them straight into trail copy reads
 * as "The analysis is reading..."; the UI keeps the raw value in payload.role for its chip.
 */
const ROLE_NAMES: Record<CrewRole, string> = {
  planner: 'planner',
  analysis: 'analyst',
  layout: 'designer',
  reviewer: 'reviewer',
}

function roleModel(role: CrewRole): string {
  const config = getConfig()
  const overrides: Record<CrewRole, string> = {
    planner: config.CREW_PLANNER_MODEL,
    analysis: config.CREW_ANALYSIS_MODEL,
    layout: config.CREW_LAYOUT_MODEL,
    reviewer: config.CREW_REVIEWER_MODEL,
  }
  return overrides[role] || config.OPENROUTER_MODEL
}

function sourceContextTool(input: AgentRunInput, role: CrewRole): RoleTool {
  return {
    name: 'get_source_context',
    description: 'Return the governed warehouse catalog of project.schema.table relations, including grain, columns, cautions, snapshot metadata, and bounded example rows. Call this exactly once before planning or writing SQL.',
    inputSchema: z.object({}),
    execute: async () => {
      const context = await getGovernedSourceContext()
      await input.onStage('inspecting', `The ${ROLE_NAMES[role]} is reading the governed source context.`, input.detailLevel === 'detailed'
        ? {
            kind: 'source_context',
            role,
            relationCount: context.relations.length,
            relations: context.relations.map((relation) => relation.qualifiedName),
            snapshotDate: context.activeSnapshot.snapshotDate,
            rowCount: context.activeSnapshot.rowCount,
            cautions: context.relations.flatMap((relation) => relation.cautions),
          }
        : undefined)
      return context
    },
  }
}

function queryTool(input: AgentRunInput, role: CrewRole, budget: number, state: { count: number }): RoleTool {
  const config = getConfig()
  return {
    name: 'run_readonly_query',
    description: `Execute one validated read-only DuckDB SELECT/WITH query over registered project.schema.table relations. JOINs among those triples are allowed. No source_data, URL, file function, extension, pragma, or mutation is accepted. Returns at most 500 rows and 2 MB. Budget for this role: ${budget} queries.`,
    inputSchema: authoringQueryRequestSchema,
    execute: async (dataset: never) => {
      const request = dataset as Omit<DatasetSpec, 'id'>
      if (state.count >= budget) return { output: { error: `Query budget exceeded for the ${ROLE_NAMES[role]}` }, isError: true }
      state.count += 1
      const queryNumber = state.count
      await input.onStage('querying', input.detailLevel === 'detailed'
        ? `The ${ROLE_NAMES[role]}'s query ${queryNumber}: ${request.question}`
        : `The ${ROLE_NAMES[role]} is testing query ${queryNumber}.`, input.detailLevel === 'detailed'
        ? { kind: 'query_plan', role, queryNumber, question: request.question, sql: request.sql, expectedColumns: request.expectedColumns, maxRows: request.maxRows }
        : undefined)
      try {
        const result = await executeDatasetQuery({ ...request, id: `crew-${role}-${queryNumber}` })
        if (input.detailLevel === 'detailed') {
          await input.onStage('querying', `The ${ROLE_NAMES[role]}'s query ${queryNumber} returned ${result.rowCount.toLocaleString()} rows across ${result.columns.length} columns.`, {
            kind: 'query_result', role, queryNumber, columns: result.columns, rowCount: result.rowCount, truncated: result.truncated,
          })
        }
        return { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (input.detailLevel === 'detailed') {
          await input.onStage('querying', `The ${ROLE_NAMES[role]}'s query ${queryNumber} was rejected and returned for correction.`, {
            kind: 'query_error', role, queryNumber, question: request.question, error: message,
          })
        }
        return { output: { error: message }, isError: true }
      }
    },
    timeoutMs: config.QUERY_TIMEOUT_MS + 2_000,
    retryable: false,
  }
}

/** What a submit tool captured: the accepted submission, or the best of a rejected one. */
export interface SubmissionSlot<T> {
  value?: T
  /** Whatever survived validation of a rejected payload, used only if the role never recovers. */
  salvaged?: T
  error?: string
}

interface SubmitOptions<T> {
  /** Translates known near-miss shapes into the contract before validation. */
  normalize?: (payload: unknown) => unknown
  /** Keeps the usable part of a payload that still failed, rather than losing all of it. */
  salvage?: (payload: unknown) => T | undefined
}

/**
 * Builds a submit tool that captures a schema-validated payload into `slot`. Validation errors
 * are returned to the role for correction, mirroring how submit_dashboard already behaves.
 */
function submitTool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  slot: SubmissionSlot<T>,
  onAccepted: (value: T) => Promise<void>,
  options: SubmitOptions<T> = {},
): RoleTool {
  return {
    name,
    description,
    inputSchema: schema,
    execute: async (payload: never) => {
      const parsed = schema.safeParse(options.normalize ? options.normalize(payload) : payload)
      if (!parsed.success) {
        slot.value = undefined
        slot.salvaged = options.salvage?.(payload) ?? slot.salvaged
        slot.error = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ')
        return { output: { accepted: false, error: slot.error }, isError: true }
      }
      slot.value = parsed.data
      slot.error = undefined
      await onAccepted(parsed.data)
      return { accepted: true }
    },
    retryable: false,
  }
}

export interface CrewPipelineOptions {
  runRole: RunRole
}

export async function runCrewPipeline(
  input: AgentRunInput,
  options: CrewPipelineOptions,
): Promise<{ artifact: DashboardArtifactV1; usage: Record<string, unknown> }> {
  const config = getConfig()
  const usageByRole: Record<string, unknown> = {}
  const revision = input.revisionContext

  // 1. Planner: produces the contract both parallel roles are bound to. On a revision that
  //    contract also says what to carry over, which is what keeps the crew from rebuilding.
  if (revision) {
    await input.onStage('planning', `Planning revision ${revision.baseRevisionNumber + 1} against the published dashboard.`, input.detailLevel === 'detailed'
      ? {
          kind: 'revision_context',
          baseRevisionNumber: revision.baseRevisionNumber,
          priorPrompts: renderPromptTrail(revision),
          datasetCount: revision.baseArtifact.datasets.length,
          widgetCount: revision.baseArtifact.widgets.length,
        }
      : undefined)
  } else {
    await input.onStage('planning', 'Planning the analysis and the document layout.')
  }
  const briefSlot: SubmissionSlot<DashboardBrief> = {}
  const plannerResult = await options.runRole({
    role: 'planner',
    modelId: roleModel('planner'),
    systemPrompt: plannerSystemPrompt,
    prompt: buildPlannerPrompt({ prompt: input.prompt, revision }),
    tools: [
      sourceContextTool(input, 'planner'),
      submitTool('submit_plan', 'Submit the complete dashboard brief. This is the only way to finish planning.', dashboardBriefSchema, briefSlot, async (brief) => {
        await input.onStage('planning', `Plan accepted: ${brief.datasets.length} datasets and ${brief.widgets.length} widgets.`, input.detailLevel === 'detailed'
          ? { kind: 'crew_plan', title: brief.title, decisionQuestion: brief.decisionQuestion, datasets: brief.datasets, widgets: brief.widgets }
          : undefined)
        if (!brief.changePlan) return
        const change = summarizeChangePlan(brief.changePlan)
        await input.onStage('planning', `Carrying over ${change.kept.length} items, changing ${change.modified.length}, adding ${change.added.length}, removing ${change.removed.length}.`, input.detailLevel === 'detailed'
          ? { kind: 'crew_change_plan', ...change, narrativeChanges: brief.changePlan.narrativeChanges }
          : undefined)
      }),
    ],
    completionGuard: () => briefSlot.value
      ? undefined
      : briefSlot.error
        ? `The plan was not accepted: ${briefSlot.error}. Correct it and call submit_plan again.`
        : 'You must call submit_plan with a complete brief before finishing.',
  })
  usageByRole.planner = plannerResult.usage
  const brief = briefSlot.value
  if (!brief) throw new Error(briefSlot.error ? `The planner produced no usable brief: ${briefSlot.error}` : 'The planner produced no brief')

  // 2. Analysis and layout in parallel. Only the analyst holds a query tool, so the parallel
  //    phase can never put two DuckDB workers in flight.
  await input.onStage('designing', 'Analysing the warehouse and designing the layout in parallel.')
  const analysisSlot: SubmissionSlot<AnalysisSubmission> = {}
  const layoutSlot: SubmissionSlot<LayoutSubmission> = {}
  const analysisQueries = { count: 0 }

  const [analysisOutcome, layoutOutcome] = await Promise.allSettled([
    options.runRole({
      role: 'analysis',
      modelId: roleModel('analysis'),
      systemPrompt: analysisSystemPrompt,
      prompt: buildAnalysisPrompt({ prompt: input.prompt, brief, revision }),
      tools: [
        sourceContextTool(input, 'analysis'),
        queryTool(input, 'analysis', config.CREW_ANALYSIS_QUERY_BUDGET, analysisQueries),
        submitTool('submit_analysis', 'Submit the tested SQL and findings for every planned dataset. This is the only way to finish the analysis.', analysisSubmissionSchema, analysisSlot, async (analysis) => {
          await input.onStage('composing', `Analysis accepted for ${analysis.datasets.length} datasets.`, input.detailLevel === 'detailed'
            ? { kind: 'crew_analysis', headline: analysis.headline, amendments: analysis.amendments, cannotEstablish: analysis.cannotEstablish }
            : undefined)
        }, revision
          ? { normalize: (payload) => carryOverAnalysis(payload, revision, brief.changePlan) }
          : {}),
      ],
      completionGuard: () => analysisSlot.value
        ? undefined
        : analysisSlot.error
          ? `The analysis was not accepted: ${analysisSlot.error}. Correct it and call submit_analysis again.`
          : 'You must call submit_analysis with tested SQL and findings before finishing.',
    }),
    options.runRole({
      role: 'layout',
      modelId: roleModel('layout'),
      systemPrompt: layoutSystemPrompt,
      prompt: buildLayoutPrompt({ prompt: input.prompt, brief, revision }),
      tools: [
        sourceContextTool(input, 'layout'),
        submitTool('submit_layout', 'Submit the widget specifications and document outline. This is the only way to finish the design.', layoutSubmissionSchema, layoutSlot, async (layout) => {
          await input.onStage('designing', `Layout accepted for ${layout.widgets.length} widgets.`, input.detailLevel === 'detailed'
            ? { kind: 'crew_layout', widgetCount: layout.widgets.length, outlineBlocks: layout.outline.length, designNotes: layout.designNotes }
            : undefined)
        }, {
          // Carry-over runs after the near-miss shape translation, so a restored widget is
          // matched by id against an outline that already uses the contract's field names.
          normalize: (payload) => {
            const shaped = normalizeLayoutSubmission(payload)
            return revision ? carryOverLayout(shaped, revision, brief.changePlan) : shaped
          },
          salvage: salvageLayoutSubmission,
        }),
      ],
      completionGuard: () => layoutSlot.value
        ? undefined
        : layoutSlot.error
          ? `The layout was not accepted: ${layoutSlot.error}. Correct it and call submit_layout again.`
          : 'You must call submit_layout with widget options and a document outline before finishing.',
    }),
  ])

  usageByRole.analysis = analysisOutcome.status === 'fulfilled' ? analysisOutcome.value.usage : { error: String(analysisOutcome.reason) }
  usageByRole.layout = layoutOutcome.status === 'fulfilled' ? layoutOutcome.value.usage : { error: String(layoutOutcome.reason) }

  const analysis = analysisSlot.value
  if (!analysis) {
    const detail = analysisSlot.error ?? (analysisOutcome.status === 'rejected' ? String(analysisOutcome.reason) : 'no submission')
    throw new Error(`The analyst produced no usable analysis: ${detail}`)
  }
  // A design rejected only for the shape of its outline still carries usable chart specs, so
  // the salvaged part is preferred over dropping every widget to a default option.
  const layout = layoutSlot.value ?? layoutSlot.salvaged
  if (!layoutSlot.value) {
    const error = layoutSlot.error ?? (layoutOutcome.status === 'rejected' ? String(layoutOutcome.reason) : 'no submission')
    await input.onStage('designing', layout
      ? `The designer's submission was rejected; keeping the ${layout.widgets.length} chart specifications that validated and rebuilding the outline.`
      : 'The designer did not deliver; falling back to default chart options.', input.detailLevel === 'detailed'
      ? { kind: 'crew_layout_fallback', error, salvagedWidgets: layout?.widgets.length ?? 0, salvagedOutlineBlocks: layout?.outline.length ?? 0 }
      : undefined)
  }

  // 3. Deterministic draft, so a failed reviewer still yields a publishable dashboard.
  const draft = assembleArtifact(brief, analysis, layout)
  let draftIssues: string | undefined
  let fallback: DashboardArtifactV1 | undefined
  try {
    fallback = validateDashboardArtifact(draft)
  } catch (error) {
    draftIssues = error instanceof Error ? error.message : String(error)
  }

  // 4. Reviewer polishes and owns the only submission.
  await input.onStage('reviewing', 'A senior analyst-engineer is reviewing and polishing the dashboard.')
  const reviewQueries = { count: 0 }
  const submissionSlot: SubmissionSlot<DashboardArtifactV1> = {}
  const reviewerTools: RoleTool[] = [sourceContextTool(input, 'reviewer')]
  if (config.CREW_REVIEW_QUERY_BUDGET > 0) {
    reviewerTools.push(queryTool(input, 'reviewer', config.CREW_REVIEW_QUERY_BUDGET, reviewQueries))
  }
  reviewerTools.push({
    name: 'submit_dashboard',
    description: 'Validate and submit the complete DashboardArtifactV1. This is the only way to finish the run. Validation errors are returned for correction.',
    inputSchema: dashboardArtifactSchema,
    execute: async (payload: never) => {
      try {
        const accepted = validateDashboardArtifact(revision ? carryOverArtifactSql(payload, revision, brief.changePlan) : payload)
        // The analyst tests its own SQL, but the reviewer assembles the final artifact and can
        // submit a statement nobody ran. validateDashboardArtifact does not screen SQL, so
        // without this the guard would only fire at canonicalisation, past the point where the
        // reviewer could still correct it, and the run would fail outright.
        const rejected = accepted.datasets.flatMap((dataset) => {
          try {
            normalizeReadonlySql(dataset.sql)
            return []
          } catch (error) {
            return [`dataset ${dataset.id}: ${error instanceof Error ? error.message : String(error)}`]
          }
        })
        if (rejected.length > 0) throw new Error(`Rejected SQL: ${rejected.join('; ')}`)
        submissionSlot.value = accepted
        submissionSlot.error = undefined
        await input.onStage('composing', 'The reviewer submitted a complete dashboard artifact.', input.detailLevel === 'detailed'
          ? { kind: 'artifact_summary', title: accepted.title, datasetCount: accepted.datasets.length, widgetCount: accepted.widgets.length, renderers: [...new Set(accepted.widgets.map((widget) => widget.engine))] }
          : undefined)
        return { accepted: true, title: accepted.title }
      } catch (error) {
        submissionSlot.value = undefined
        submissionSlot.error = error instanceof Error ? error.message : String(error)
        await input.onStage('validating', `Dashboard submission rejected: ${submissionSlot.error}`, input.detailLevel === 'detailed'
          ? { kind: 'artifact_error', error: submissionSlot.error }
          : undefined)
        return { output: { accepted: false, error: submissionSlot.error }, isError: true }
      }
    },
    retryable: false,
  })

  for (let attempt = 1; attempt <= MAX_REVIEWER_ATTEMPTS && !submissionSlot.value; attempt += 1) {
    try {
      const reviewerResult = await options.runRole({
        role: 'reviewer',
        modelId: roleModel('reviewer'),
        systemPrompt: reviewerSystemPrompt,
        prompt: buildReviewerPrompt({
          prompt: input.prompt,
          brief,
          analysis,
          layout,
          draft,
          draftIssues: submissionSlot.error ?? draftIssues,
          revision,
        }),
        tools: reviewerTools,
        completionGuard: () => submissionSlot.value
          ? undefined
          : submissionSlot.error
            ? `The dashboard was not accepted: ${submissionSlot.error}. Correct the artifact and call submit_dashboard again.`
            : 'You must call submit_dashboard with a complete, valid artifact before finishing.',
      })
      usageByRole[`reviewer_${attempt}`] = reviewerResult.usage
    } catch (error) {
      usageByRole[`reviewer_${attempt}`] = { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const artifact = submissionSlot.value ?? fallback
  if (!artifact) {
    throw new Error(`The crew produced no valid dashboard. Reviewer: ${submissionSlot.error ?? 'no submission'}. Draft: ${draftIssues ?? 'unavailable'}`)
  }
  if (!submissionSlot.value) {
    await input.onStage('reviewing', 'The reviewer did not deliver; publishing the deterministically assembled dashboard.', input.detailLevel === 'detailed'
      ? { kind: 'crew_review_fallback', error: submissionSlot.error ?? 'no submission' }
      : undefined)
  }
  return { artifact, usage: { adapter: 'crew', roles: usageByRole, analysisQueries: analysisQueries.count, reviewQueries: reviewQueries.count } }
}
