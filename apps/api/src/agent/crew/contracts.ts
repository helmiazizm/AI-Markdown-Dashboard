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

/**
 * What happens to each dataset and widget the base revision already had. This is what turns a
 * refinement into a continuation: anything marked keep is restored from the base artifact
 * verbatim rather than re-derived, so the analyst and designer only work on what actually
 * changed. Present only on a revision.
 */
export const changeDispositionSchema = z.enum(['keep', 'modify', 'add', 'remove'])

export type ChangeDisposition = z.infer<typeof changeDispositionSchema>

const changeEntrySchema = z.object({
  id: identifierSchema,
  disposition: changeDispositionSchema,
  reason: z.string().max(300).default(''),
})

export const changePlanSchema = z.object({
  datasets: z.array(changeEntrySchema).max(16).default([]),
  widgets: z.array(changeEntrySchema).max(16).default([]),
  narrativeChanges: z.string().max(600).default(''),
})

export type ChangePlan = z.infer<typeof changePlanSchema>

export const dashboardBriefSchema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(8).max(600),
  decisionQuestion: z.string().min(8).max(400),
  datasets: z.array(briefDatasetSchema).min(1).max(8),
  widgets: z.array(briefWidgetSchema).min(1).max(8),
  narrativeSkeleton: z.array(narrativeBeatSchema).min(1).max(12),
  changePlan: changePlanSchema.optional(),
})

export type DashboardBrief = z.infer<typeof dashboardBriefSchema>

/** Ids the plan says to carry over untouched, or to drop. Unlisted ids are treated as new work. */
export function dispositions(entries: ChangePlan['datasets']): Map<string, ChangeDisposition> {
  return new Map(entries.map((entry) => [entry.id, entry.disposition]))
}

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

const HEADING_MAX = 120
const CLAIM_MAX = 1_000

export const outlineBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), text: z.string().min(2).max(HEADING_MAX) }),
  z.object({ kind: z.literal('lede'), claim: z.string().min(4).max(CLAIM_MAX) }),
  z.object({ kind: z.literal('prose'), claim: z.string().min(4).max(CLAIM_MAX) }),
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

/**
 * The outline is a discriminated union of four small block shapes, and models reach for the
 * synonym rather than the field name often enough that a literal schema check throws away an
 * otherwise complete design: a heading arrives as {kind:"h2", title}, a widget as {type:"chart",
 * id}, prose as {kind:"paragraph", content}. Those all carry the same information, so they are
 * translated to the contract here rather than bounced back as a validation error. Anything whose
 * meaning is genuinely absent — a widget block naming no widget — is left to fail validation.
 */
const OUTLINE_KINDS: Record<string, OutlineBlock['kind']> = {
  heading: 'heading', h2: 'heading', h3: 'heading', header: 'heading', section: 'heading', subheading: 'heading', title: 'heading',
  lede: 'lede', lead: 'lede', callout: 'lede', highlight: 'lede', quote: 'lede', summary: 'lede',
  prose: 'prose', paragraph: 'prose', text: 'prose', markdown: 'prose', body: 'prose', note: 'prose', copy: 'prose',
  widget: 'widget', chart: 'widget', figure: 'widget', visual: 'widget', fence: 'widget',
}

const TEXT_KEYS = ['text', 'heading', 'title', 'label', 'claim', 'content', 'body', 'markdown', 'prose', 'value']
const CLAIM_KEYS = ['claim', 'text', 'content', 'body', 'markdown', 'prose', 'lede', 'value']
const WIDGET_ID_KEYS = ['widgetId', 'widget_id', 'widget', 'id', 'ref', 'widgetRef', 'chartId']

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** Cuts at a word boundary so a truncated block does not end mid-word. */
function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()
}

function headingLevel(raw: unknown, rawKind: string): 2 | 3 {
  const digits = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(/[^0-9]/g, '')) : Number.NaN
  if (Number.isFinite(digits) && digits > 0) return digits >= 3 ? 3 : 2
  return rawKind === 'h3' || rawKind === 'subheading' ? 3 : 2
}

function normalizeOutlineBlock(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text.startsWith('#')
      ? { kind: 'heading', level: text.startsWith('###') ? 3 : 2, text: clamp(text.replace(/^#+\s*/, ''), HEADING_MAX) }
      : { kind: 'prose', claim: clamp(text, CLAIM_MAX) }
  }
  const block = plainRecord(raw)
  if (!block) return raw

  const rawKind = firstString(block, ['kind', 'type', 'block', 'blockType'])?.toLowerCase() ?? ''
  const widgetId = firstString(block, WIDGET_ID_KEYS)
  const prose = firstString(block, CLAIM_KEYS)
  // With no kind at all, an id and no copy means a widget placement; anything carrying a level
  // or a title is a heading; everything else is prose.
  const kind = OUTLINE_KINDS[rawKind]
    ?? (widgetId && !prose ? 'widget' : block.level !== undefined || firstString(block, ['heading', 'title']) ? 'heading' : 'prose')

  if (kind === 'widget') {
    const span = firstString(block, ['span', 'width'])?.toLowerCase()
    return {
      kind,
      ...(widgetId === undefined ? {} : { widgetId }),
      ...(span === undefined ? {} : { span: span.startsWith('half') ? 'half' : 'full' }),
    }
  }
  if (kind === 'heading') {
    const text = firstString(block, TEXT_KEYS)
    return { kind, level: headingLevel(block.level ?? block.depth, rawKind), ...(text === undefined ? {} : { text: clamp(text, HEADING_MAX) }) }
  }
  return { kind, ...(prose === undefined ? {} : { claim: clamp(prose, CLAIM_MAX) }) }
}

/** Translates a near-miss layout payload into the contract shape before it is validated. */
export function normalizeLayoutSubmission(payload: unknown): unknown {
  const submission = plainRecord(payload)
  if (!submission) return payload
  const outline = submission.outline ?? submission.document ?? submission.blocks ?? submission.narrative
  if (!Array.isArray(outline)) return submission
  return { ...submission, outline: outline.map(normalizeOutlineBlock) }
}

/**
 * Last resort when a layout payload still fails validation: keep whatever validates so a design
 * that is only wrong in its outline does not cost every chart option the designer produced. The
 * assembler falls back to the planner's narrative skeleton when the outline is empty.
 */
export function salvageLayoutSubmission(payload: unknown): LayoutSubmission | undefined {
  const submission = plainRecord(normalizeLayoutSubmission(payload))
  if (!submission) return undefined
  const widgets = z.array(layoutWidgetSchema).min(1).max(8).safeParse(submission.widgets)
  if (!widgets.success) return undefined
  const outline = Array.isArray(submission.outline)
    ? submission.outline.flatMap((block) => {
      const parsed = outlineBlockSchema.safeParse(block)
      return parsed.success ? [parsed.data] : []
    })
    : []
  const designNotes = typeof submission.designNotes === 'string' ? submission.designNotes.slice(0, 1_200) : ''
  return { widgets: widgets.data, outline: outline.length >= 2 ? outline : [], designNotes }
}
