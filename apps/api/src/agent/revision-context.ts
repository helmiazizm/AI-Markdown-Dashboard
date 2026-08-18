import type { DashboardArtifactV1, RevisionSourceKind } from '@fieldboard/contracts'
import { pool } from '../db/pool.js'

/** How many iterations the crew is given: the base revision plus the two before it. */
const HISTORY_DEPTH = 3

/**
 * A prior revision, compacted. Deliberately carries no markdown, SQL or chart options: this is
 * background for reading the dashboard's trajectory, and three full artifacts across four roles
 * would dominate every prompt.
 */
export interface RevisionDigest {
  revisionNumber: number
  /** provenance.note. Only an analytical prompt when sourceKind is 'agent'. */
  note: string
  sourceKind: RevisionSourceKind
  title: string
  summary: string
  datasets: Array<{ id: string; question: string; expectedColumns: string[] }>
  widgets: Array<{ id: string; datasetId: string; title: string }>
}

export interface RevisionContext {
  baseRevisionId: string
  baseRevisionNumber: number
  baseNote: string
  baseSourceKind: RevisionSourceKind
  baseArtifact: DashboardArtifactV1
  /** Up to two revisions before the base, newest first. */
  history: RevisionDigest[]
}

export function digestArtifact(input: {
  revisionNumber: number
  note: string
  sourceKind: RevisionSourceKind
  artifact: DashboardArtifactV1
}): RevisionDigest {
  return {
    revisionNumber: input.revisionNumber,
    note: input.note,
    sourceKind: input.sourceKind,
    title: input.artifact.title,
    summary: input.artifact.summary,
    datasets: input.artifact.datasets.map((dataset) => ({
      id: dataset.id,
      question: dataset.question,
      expectedColumns: dataset.expectedColumns,
    })),
    widgets: input.artifact.widgets.map((widget) => ({
      id: widget.id,
      datasetId: widget.datasetId,
      title: widget.title,
    })),
  }
}

/**
 * Reads the base revision and up to two before it from the Git projection.
 *
 * Ordered by revision_number rather than created_at, because the content indexer does not write
 * created_at and a rebuilt projection resets it to the rebuild time. Lineage is never walked
 * through parent_revision_id either: applyContentIndex nulls a parent pointer whose target is
 * absent from the scan, so a rebuilt chain can be severed at any link. Only published revisions
 * are considered, since a pending or blocked row carries a prompt but no Git commit and a full
 * reindex removes it.
 *
 * A short or non-contiguous history is normal, not an error.
 */
export async function loadRevisionContext(
  dashboardId: string,
  baseRevisionId: string,
): Promise<RevisionContext | null> {
  const result = await pool.query<{
    id: string
    revision_number: number
    prompt: string
    source_kind: RevisionSourceKind
    artifact: DashboardArtifactV1
  }>(`
    SELECT id, revision_number, prompt, source_kind, artifact
    FROM dashboard_revisions
    WHERE dashboard_id = $1
      AND publication_status = 'published'
      AND revision_number <= (SELECT revision_number FROM dashboard_revisions WHERE id = $2)
    ORDER BY revision_number DESC
    LIMIT $3
  `, [dashboardId, baseRevisionId, HISTORY_DEPTH])
  const [base, ...earlier] = result.rows
  if (!base || base.id !== baseRevisionId) return null
  return {
    baseRevisionId: base.id,
    baseRevisionNumber: base.revision_number,
    baseNote: base.prompt,
    baseSourceKind: base.source_kind,
    baseArtifact: base.artifact,
    history: earlier.map((row) => digestArtifact({
      revisionNumber: row.revision_number,
      note: row.prompt,
      sourceKind: row.source_kind,
      artifact: row.artifact,
    })),
  }
}

function trailLine(revisionNumber: number, sourceKind: RevisionSourceKind, note: string): string {
  // A revision's note only means "the analyst asked for this" when an agent produced it. An
  // import change note or a restore note is provenance, and presenting it as a request would
  // have the crew act on "Imported external edit" as though it were an analytical instruction.
  if (sourceKind === 'agent') return `Revision ${revisionNumber} was requested with: ${note}`
  if (sourceKind === 'manual') return `Revision ${revisionNumber} was a hand edit imported from Git, noted as: ${note}`
  if (sourceKind === 'restore') return `Revision ${revisionNumber} restored an earlier revision, noted as: ${note}`
  return `Revision ${revisionNumber} came from ${sourceKind} content, noted as: ${note}`
}

/**
 * Renders how the dashboard reached its current state, oldest first, so a role reads the
 * trajectory rather than only the latest sentence.
 */
export function renderPromptTrail(context: RevisionContext): string {
  const lines = [
    ...context.history
      .slice()
      .sort((left, right) => left.revisionNumber - right.revisionNumber)
      .map((item) => trailLine(item.revisionNumber, item.sourceKind, item.note)),
    trailLine(context.baseRevisionNumber, context.baseSourceKind, context.baseNote),
  ]
  return lines.join('\n')
}

/** What the analyst needs from the base revision: the tested SQL, and nothing about charts. */
export function analystView(context: RevisionContext): Array<{
  id: string
  question: string
  sql: string
  expectedColumns: string[]
  maxRows: number
}> {
  return context.baseArtifact.datasets.map((dataset) => ({
    id: dataset.id,
    question: dataset.question,
    sql: dataset.sql,
    expectedColumns: dataset.expectedColumns,
    maxRows: dataset.maxRows,
  }))
}

/** What the designer needs: the existing chart specs and the columns they encode against. */
export function designerView(context: RevisionContext): Array<{
  id: string
  datasetId: string
  title: string
  description: string
  accessibilityText: string
  height: number
  expectedColumns: string[]
  option?: Record<string, unknown>
}> {
  const columnsByDataset = new Map(context.baseArtifact.datasets.map((dataset) => [dataset.id, dataset.expectedColumns]))
  return context.baseArtifact.widgets.map((widget) => ({
    id: widget.id,
    datasetId: widget.datasetId,
    title: widget.title,
    description: widget.description,
    accessibilityText: widget.accessibilityText,
    height: widget.height,
    expectedColumns: columnsByDataset.get(widget.datasetId) ?? [],
    ...(widget.engine === 'echarts' ? { option: widget.option } : {}),
  }))
}
