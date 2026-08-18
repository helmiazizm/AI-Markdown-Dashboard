import type { DashboardArtifactV1 } from '@fieldboard/contracts'
import type { RevisionContext } from '../revision-context.js'
import { dispositions, type ChangePlan } from './contracts.js'
import { fenceFor } from './fallbacks.js'

/**
 * Deterministic continuity for a refinement.
 *
 * A role told to "copy this verbatim" mostly will, and occasionally will not: it paraphrases a
 * finding, renames a column, or quietly rewrites an option object. On a revision that reads as
 * the dashboard being rebuilt, which is the bug these functions exist to close. So rather than
 * asking, the submit tools run their payload through here first -- they are wired into
 * submitTool's `normalize` hook, which already runs before validation. Restoring instead of
 * rejecting matters: a rejection loop could fail the whole run, while a restore cannot.
 *
 * Everything here is a pure function over the submitted payload, the base revision, and the
 * planner's change plan, so the rules are testable without a role runner.
 */

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Restores kept datasets to the SQL the warehouse already ran, inserts any the analyst dropped,
 * and removes the ones the plan retired. The analyst's own prose -- finding, caveats, question --
 * is always preserved: it is the part it was asked to write.
 */
export function carryOverAnalysis(payload: unknown, context: RevisionContext, plan?: ChangePlan): unknown {
  const submission = plainRecord(payload)
  if (!submission || !plan) return payload
  const planned = dispositions(plan.datasets)
  const baseById = new Map(context.baseArtifact.datasets.map((dataset) => [dataset.id, dataset]))
  const submitted = Array.isArray(submission.datasets) ? submission.datasets : []

  const kept: unknown[] = []
  const seen = new Set<string>()
  for (const entry of submitted) {
    const dataset = plainRecord(entry)
    const id = dataset ? identifier(dataset.id) : undefined
    if (!dataset || !id) {
      kept.push(entry)
      continue
    }
    if (planned.get(id) === 'remove') continue
    seen.add(id)
    const base = baseById.get(id)
    if (!base || planned.get(id) !== 'keep') {
      kept.push(dataset)
      continue
    }
    kept.push({
      ...dataset,
      question: dataset.question ?? base.question,
      sql: base.sql,
      expectedColumns: base.expectedColumns,
      maxRows: base.maxRows,
    })
  }

  // A kept dataset the analyst left out entirely still has to reach the artifact, or the widgets
  // encoding against it lose their source and the draft fails validation.
  for (const entry of plan.datasets) {
    if (entry.disposition !== 'keep' || seen.has(entry.id)) continue
    const base = baseById.get(entry.id)
    if (!base) continue
    kept.push({
      id: base.id,
      question: base.question,
      sql: base.sql,
      expectedColumns: base.expectedColumns,
      maxRows: base.maxRows,
      finding: `Carried over unchanged from revision ${context.baseRevisionNumber}.`,
      caveats: [],
    })
  }
  return { ...submission, datasets: kept }
}

/**
 * Restores kept widgets to the chart specs already published, inserts any the designer dropped,
 * removes retired ones, and makes sure every restored widget still has a place in the outline --
 * an artifact whose widget is never fenced does not validate.
 */
export function carryOverLayout(payload: unknown, context: RevisionContext, plan?: ChangePlan): unknown {
  const submission = plainRecord(payload)
  if (!submission || !plan) return payload
  const planned = dispositions(plan.widgets)
  const baseById = new Map(context.baseArtifact.widgets.map((widget) => [widget.id, widget]))
  const submitted = Array.isArray(submission.widgets) ? submission.widgets : []

  function restored(id: string): Record<string, unknown> | undefined {
    const base = baseById.get(id)
    if (!base || base.engine !== 'echarts') return undefined
    return {
      id: base.id,
      title: base.title,
      description: base.description,
      accessibilityText: base.accessibilityText,
      height: base.height,
      option: base.option,
    }
  }

  const widgets: unknown[] = []
  const seen = new Set<string>()
  for (const entry of submitted) {
    const widget = plainRecord(entry)
    const id = widget ? identifier(widget.id) : undefined
    if (!widget || !id) {
      widgets.push(entry)
      continue
    }
    if (planned.get(id) === 'remove') continue
    seen.add(id)
    const base = planned.get(id) === 'keep' ? restored(id) : undefined
    // span stays the designer's call even for a kept widget: the follow-up may be asking for a
    // different reading order without asking for a different chart.
    widgets.push(base ? { ...base, ...(widget.span === undefined ? {} : { span: widget.span }) } : widget)
  }

  for (const entry of plan.widgets) {
    if (entry.disposition !== 'keep' || seen.has(entry.id)) continue
    const base = restored(entry.id)
    if (!base) continue
    seen.add(entry.id)
    widgets.push(base)
  }

  const outline = Array.isArray(submission.outline) ? [...submission.outline] : []
  const placed = new Set(outline.flatMap((block) => {
    const record = plainRecord(block)
    const id = record && record.kind === 'widget' ? identifier(record.widgetId) : undefined
    return id ? [id] : []
  }))
  for (const widget of widgets) {
    const id = identifier(plainRecord(widget)?.id)
    if (!id || placed.has(id) || !baseById.has(id)) continue
    outline.push({ kind: 'widget', widgetId: id, span: 'full' })
    placed.add(id)
  }
  // Dropping a removed widget's fence keeps the outline from referencing a widget nobody submits.
  const cleaned = outline.filter((block) => {
    const record = plainRecord(block)
    if (!record || record.kind !== 'widget') return true
    const id = identifier(record.widgetId)
    return !id || planned.get(id) !== 'remove'
  })
  return { ...submission, widgets, outline: cleaned }
}

/**
 * Base widgets the crew has no way to express, and therefore no way to redesign.
 *
 * layoutWidgetSchema carries no engine and requires an ECharts option object, and assembleArtifact
 * stamps every widget it emits as echarts. That is deliberate -- a role cannot be trusted to author
 * a sandboxed D3 script -- but it means a D3 widget routed through the crew comes back as a generic
 * bar chart with its script gone from Git. So these widgets bypass the layout submission entirely
 * and are spliced back after assembly.
 *
 * A modify disposition collapses to keep: the crew cannot honour "change this chart" for a renderer
 * it cannot write, and quietly replacing it would be worse than leaving it alone. Only an explicit
 * remove retires one.
 */
export function preservedWidgets(context: RevisionContext, plan?: ChangePlan): DashboardArtifactV1['widgets'] {
  // changePlan is optional, so a planner can omit it. Everywhere else that means "treat the base
  // as new work", but here it would mean deleting an authored script nobody asked to delete, so
  // an absent plan preserves everything instead.
  const planned = dispositions(plan?.widgets ?? [])
  const retiredDatasets = new Set(
    (plan?.datasets ?? []).filter((entry) => entry.disposition === 'remove').map((entry) => entry.id),
  )
  return context.baseArtifact.widgets.filter((widget) => (
    widget.engine !== 'echarts'
    && planned.get(widget.id) !== 'remove'
    // A widget whose dataset is retired goes with it: a widget with no dataset cannot validate.
    && !retiredDatasets.has(widget.datasetId)
  ))
}

/**
 * Last line of defence at the reviewer's submission, and where preserved widgets rejoin the
 * document. The reviewer is told not to touch SQL that has already run and to return a preserved
 * widget verbatim; this makes both structural. SQL that never executed against the warehouse fails
 * the whole publication well after the crew has finished, and a lost D3 script is unrecoverable.
 */
export function carryOverArtifact(payload: unknown, context: RevisionContext, plan?: ChangePlan): unknown {
  const artifact = plainRecord(payload)
  if (!artifact) return payload
  const planned = dispositions(plan?.datasets ?? [])
  const baseById = new Map(context.baseArtifact.datasets.map((dataset) => [dataset.id, dataset]))

  const datasets = Array.isArray(artifact.datasets)
    ? artifact.datasets.map((entry) => {
      const dataset = plainRecord(entry)
      const id = dataset ? identifier(dataset.id) : undefined
      if (!dataset || !id || planned.get(id) !== 'keep') return entry
      const base = baseById.get(id)
      if (!base) return entry
      return { ...dataset, sql: base.sql, expectedColumns: base.expectedColumns, maxRows: base.maxRows }
    })
    : artifact.datasets

  const preserved = preservedWidgets(context, plan)
  if (preserved.length === 0) return { ...artifact, datasets }

  const preservedById = new Map(preserved.map((widget) => [widget.id, widget]))
  const submitted = Array.isArray(artifact.widgets) ? artifact.widgets : []
  const seen = new Set<string>()
  const widgets: unknown[] = []
  for (const entry of submitted) {
    const id = identifier(plainRecord(entry)?.id)
    // A preserved widget the crew rebuilt as ECharts is swapped back for the published object.
    const base = id ? preservedById.get(id) : undefined
    if (id && base) seen.add(id)
    widgets.push(base ?? entry)
  }
  const appended = preserved.filter((widget) => !seen.has(widget.id))
  widgets.push(...appended)

  // A dashboard fence carries only its widgetId, so a swapped widget keeps its place in the
  // narrative untouched. Only a widget the crew dropped altogether needs a new fence, and it is
  // placed the same way assembleArtifact places one the outline forgot.
  let markdown = typeof artifact.markdown === 'string' ? artifact.markdown : ''
  const unplaced = appended.filter((widget) => !markdown.includes(`"widgetId":"${widget.id}"`))
  if (unplaced.length > 0) {
    markdown = [
      markdown.trimEnd(),
      '## Supporting evidence',
      ...unplaced.flatMap((widget) => [fenceFor(widget.id, 'full'), widget.description]),
    ].join('\n\n')
  }
  return { ...artifact, datasets, widgets, markdown }
}

/**
 * What the crew reused rather than rebuilt, for the run trail.
 *
 * Ids are deduplicated across datasets and widgets: a planner often names a widget after the
 * dataset it plots, and listing "kids-season-coverage" twice reads as a mistake rather than as
 * one dataset and one chart.
 */
export function summarizeChangePlan(plan: ChangePlan): {
  kept: string[]
  modified: string[]
  added: string[]
  removed: string[]
} {
  const all = [...plan.datasets, ...plan.widgets]
  const of = (disposition: string): string[] => [...new Set(
    all.filter((entry) => entry.disposition === disposition).map((entry) => entry.id),
  )]
  return { kept: of('keep'), modified: of('modify'), added: of('add'), removed: of('remove') }
}
