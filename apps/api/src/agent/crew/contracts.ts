import { identifierSchema, widgetSpanSchema } from '@fieldboard/contracts'
import { z } from 'zod'

export type CrewRole = 'planner' | 'analysis' | 'layout' | 'reviewer'

/**
 * Chart forms the layout role may choose. These are shared labels so the fallback option
 * library has something deterministic to build from. Crew mode emits ECharts only — D3 stays
 * available to the single-agent adapter, where a script can be authored and sandbox-checked.
 */
export const chartFormSchema = z.enum([
  'line',
  'bar',
  'horizontal-bar',
  'area',
  'scatter',
  'heatmap',
  'pie',
])

export type ChartForm = z.infer<typeof chartFormSchema>

const briefDatasetSchema = z.object({
  id: identifierSchema,
  question: z.string().min(4).max(240),
  // The binding half of the contract: the analysis role must produce exactly these columns,
  // because query-service re-checks them and a mismatch fails the whole generation.
  expectedColumns: z.array(identifierSchema).min(1).max(30),
  relationHints: z.array(z.string().max(160)).max(8).default([]),
  analyticalNotes: z.string().max(600).default(''),
})

const briefWidgetSchema = z.object({
  id: identifierSchema,
  datasetId: identifierSchema,
  chartForm: chartFormSchema,
  intent: z.string().min(4).max(320),
  span: widgetSpanSchema.default('full'),
})

const narrativeBeatSchema = z.object({
  heading: z.string().min(2).max(120),
  claimToSupport: z.string().min(4).max(400),
  widgetId: identifierSchema.optional(),
})

export const dashboardBriefSchema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(8).max(600),
  decisionQuestion: z.string().min(8).max(400),
  datasets: z.array(briefDatasetSchema).min(1).max(8),
  widgets: z.array(briefWidgetSchema).min(1).max(8),
  narrativeSkeleton: z.array(narrativeBeatSchema).min(1).max(12),
})

export type DashboardBrief = z.infer<typeof dashboardBriefSchema>

const analysisDatasetSchema = z.object({
  id: identifierSchema,
  question: z.string().min(4).max(240),
  sql: z.string().min(8).max(12_000),
  expectedColumns: z.array(identifierSchema).min(1).max(30),
  maxRows: z.coerce.number().int().min(1).max(500).default(500),
  finding: z.string().min(20).max(1200),
  caveats: z.array(z.string().max(400)).max(6).default([]),
})

export const analysisSubmissionSchema = z.object({
  headline: z.string().min(20).max(1200),
  datasets: z.array(analysisDatasetSchema).min(1).max(8),
  // Escape hatch when the planner's column contract turns out to be wrong. Declaring an
  // amendment is mandatory; silently returning different columns is what breaks the run.
  amendments: z.array(z.object({
    datasetId: identifierSchema,
    expectedColumns: z.array(identifierSchema).min(1).max(30),
    reason: z.string().min(4).max(400),
  })).max(8).default([]),
  cannotEstablish: z.array(z.string().max(400)).max(8).default([]),
})

export type AnalysisSubmission = z.infer<typeof analysisSubmissionSchema>

const layoutWidgetSchema = z.object({
  id: identifierSchema,
  title: z.string().min(2).max(120),
  description: z.string().min(4).max(320),
  accessibilityText: z.string().min(8).max(500),
  height: z.coerce.number().int().min(240).max(760).default(420),
  span: widgetSpanSchema.default('full'),
  option: z.record(z.string(), z.unknown()),
})

export const outlineBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), text: z.string().min(2).max(120) }),
  z.object({ kind: z.literal('lede'), claim: z.string().min(4).max(400) }),
  z.object({ kind: z.literal('prose'), claim: z.string().min(4).max(400) }),
  z.object({ kind: z.literal('widget'), widgetId: identifierSchema, span: widgetSpanSchema.default('full') }),
])

export type OutlineBlock = z.infer<typeof outlineBlockSchema>

export const layoutSubmissionSchema = z.object({
  widgets: z.array(layoutWidgetSchema).min(1).max(8),
  outline: z.array(outlineBlockSchema).min(2).max(40),
  designNotes: z.string().max(1200).default(''),
})

export type LayoutSubmission = z.infer<typeof layoutSubmissionSchema>
export type LayoutWidget = z.infer<typeof layoutWidgetSchema>
