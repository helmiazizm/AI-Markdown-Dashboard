import type { RevisionContext } from '../revision-context.js'
import { dispositions, type ChangePlan } from './contracts.js'

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
 * Last line of defence at the reviewer's submission. The reviewer is told not to touch SQL that
 * has already run, and this makes it structural for kept datasets: SQL that never executed
 * against the warehouse fails the whole publication, well after the crew has finished.
 */
export function carryOverArtifactSql(payload: unknown, context: RevisionContext, plan?: ChangePlan): unknown {
  const artifact = plainRecord(payload)
  if (!artifact || !plan || !Array.isArray(artifact.datasets)) return payload
  const planned = dispositions(plan.datasets)
  const baseById = new Map(context.baseArtifact.datasets.map((dataset) => [dataset.id, dataset]))
  return {
    ...artifact,
    datasets: artifact.datasets.map((entry) => {
      const dataset = plainRecord(entry)
      const id = dataset ? identifier(dataset.id) : undefined
      if (!dataset || !id || planned.get(id) !== 'keep') return entry
      const base = baseById.get(id)
      if (!base) return entry
      return { ...dataset, sql: base.sql, expectedColumns: base.expectedColumns, maxRows: base.maxRows }
    }),
  }
}

/** Counts for the run trail, so the analyst can see what the crew reused rather than rebuilt. */
export function summarizeChangePlan(plan: ChangePlan): {
  kept: string[]
  modified: string[]
  added: string[]
  removed: string[]
} {
  const all = [...plan.datasets, ...plan.widgets]
  const of = (disposition: string): string[] => all.filter((entry) => entry.disposition === disposition).map((entry) => entry.id)
  return { kept: of('keep'), modified: of('modify'), added: of('add'), removed: of('remove') }
}
