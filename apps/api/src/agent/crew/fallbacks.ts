import type { DashboardArtifactV1, WidgetSpan } from '@fieldboard/contracts'
import type { AnalysisSubmission, ChartForm, DashboardBrief, LayoutSubmission, OutlineBlock } from './contracts.js'

const GRID = { left: 8, right: 20, top: 24, bottom: 8, containLabel: true }
const AXIS_TOOLTIP = { trigger: 'axis', axisPointer: { type: 'shadow' } }

/**
 * A sane ECharts option per chart form, used when the layout role fails or returns an empty
 * option. Encodes against the dataset's own column names so it renders against real rows.
 */
export function defaultChartOption(form: ChartForm, columns: string[]): Record<string, unknown> {
  const first = columns[0] ?? 'category'
  const second = columns[1] ?? first
  const third = columns[2] ?? second
  switch (form) {
    case 'horizontal-bar':
      return {
        grid: GRID,
        tooltip: AXIS_TOOLTIP,
        xAxis: { type: 'value', name: second, nameLocation: 'middle', nameGap: 30 },
        yAxis: { type: 'category', axisTick: { show: false } },
        series: [{ type: 'bar', barMaxWidth: 24, encode: { x: second, y: first } }],
      }
    case 'bar':
      return {
        grid: GRID,
        tooltip: AXIS_TOOLTIP,
        xAxis: { type: 'category', name: first, nameLocation: 'middle', nameGap: 30, axisLabel: { hideOverlap: true } },
        yAxis: { type: 'value', name: second },
        series: [{ type: 'bar', barMaxWidth: 28, encode: { x: first, y: second } }],
      }
    case 'line':
    case 'area':
      return {
        grid: GRID,
        tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
        xAxis: { type: 'category', name: first, nameLocation: 'middle', nameGap: 30, axisLabel: { hideOverlap: true } },
        yAxis: { type: 'value', name: second },
        series: [{
          type: 'line',
          showSymbol: false,
          encode: { x: first, y: second },
          ...(form === 'area' ? { areaStyle: {} } : {}),
        }],
      }
    case 'scatter':
      return {
        grid: GRID,
        tooltip: { trigger: 'item' },
        xAxis: { type: 'value', name: first, nameLocation: 'middle', nameGap: 30 },
        yAxis: { type: 'value', name: second },
        series: [{ type: 'scatter', symbolSize: 8, encode: { x: first, y: second } }],
      }
    case 'heatmap':
      return {
        grid: { ...GRID, bottom: 56 },
        tooltip: { trigger: 'item' },
        xAxis: { type: 'category', name: first, nameLocation: 'middle', nameGap: 30, splitArea: { show: true } },
        yAxis: { type: 'category', splitArea: { show: true } },
        visualMap: { type: 'continuous', dimension: third, calculable: true, orient: 'horizontal', left: 'center', bottom: 0 },
        series: [{ type: 'heatmap', encode: { x: first, y: second, value: third } }],
      }
    case 'pie':
      return {
        tooltip: { trigger: 'item' },
        legend: { top: 0 },
        series: [{ type: 'pie', radius: ['42%', '68%'], encode: { itemName: first, value: second } }],
      }
  }
}

function fenceFor(widgetId: string, span: WidgetSpan): string {
  const payload = span === 'half' ? { widgetId, span } : { widgetId }
  return ['```dashboard', JSON.stringify(payload), '```'].join('\n')
}

function renderOutline(
  outline: OutlineBlock[],
  findings: Map<string, string>,
  placed: Set<string>,
  spans: Map<string, WidgetSpan>,
): string[] {
  const lines: string[] = []
  for (const block of outline) {
    if (block.kind === 'heading') {
      lines.push(`${block.level === 3 ? '###' : '##'} ${block.text}`)
      continue
    }
    if (block.kind === 'lede') {
      lines.push(block.claim.split('\n').map((line) => `> ${line}`).join('\n'))
      continue
    }
    if (block.kind === 'prose') {
      lines.push(block.claim)
      continue
    }
    // A widget may only be placed once, or the bidirectional fence check fails.
    if (placed.has(block.widgetId)) continue
    placed.add(block.widgetId)
    lines.push(fenceFor(block.widgetId, spans.get(block.widgetId) ?? block.span))
    const finding = findings.get(block.widgetId)
    if (finding) lines.push(finding)
  }
  return lines
}

/**
 * Deterministically merges the three role outputs into a candidate artifact. Used both as the
 * draft handed to the reviewer and as the fallback when the reviewer cannot finish. The result
 * is not validated here — callers run validateDashboardArtifact so failures surface as issues.
 */
export function assembleArtifact(
  brief: DashboardBrief,
  analysis: AnalysisSubmission,
  layout: LayoutSubmission | undefined,
): DashboardArtifactV1 {
  const amended = new Map(analysis.amendments.map((amendment) => [amendment.datasetId, amendment.expectedColumns]))
  const analysisById = new Map(analysis.datasets.map((dataset) => [dataset.id, dataset]))

  const datasets = analysis.datasets.map((dataset) => ({
    id: dataset.id,
    question: dataset.question,
    sql: dataset.sql,
    expectedColumns: amended.get(dataset.id) ?? dataset.expectedColumns,
    maxRows: dataset.maxRows,
  }))
  const datasetIds = new Set(datasets.map((dataset) => dataset.id))

  const layoutById = new Map((layout?.widgets ?? []).map((widget) => [widget.id, widget]))
  const widgets: DashboardArtifactV1['widgets'] = []
  const spans = new Map<string, WidgetSpan>()

  for (const planned of brief.widgets) {
    if (!datasetIds.has(planned.datasetId)) continue
    const designed = layoutById.get(planned.id)
    const columns = datasets.find((dataset) => dataset.id === planned.datasetId)?.expectedColumns ?? []
    const option = designed && Object.keys(designed.option).length > 0
      ? designed.option
      : defaultChartOption(planned.chartForm, columns)
    const span = designed?.span ?? planned.span
    spans.set(planned.id, span)
    widgets.push({
      id: planned.id,
      datasetId: planned.datasetId,
      engine: 'echarts',
      title: designed?.title ?? planned.intent.slice(0, 120),
      description: designed?.description ?? planned.intent.slice(0, 320),
      height: designed?.height ?? 420,
      accessibilityText: designed?.accessibilityText
        ?? `${planned.chartForm} chart. ${planned.intent}`.slice(0, 500),
      option,
    })
  }

  const findings = new Map<string, string>()
  for (const planned of brief.widgets) {
    const finding = analysisById.get(planned.datasetId)?.finding
    if (finding) findings.set(planned.id, finding)
  }

  const placed = new Set<string>()
  const body = layout?.outline?.length
    ? renderOutline(layout.outline, findings, placed, spans)
    : brief.narrativeSkeleton.flatMap((beat) => {
      const lines = [`## ${beat.heading}`, beat.claimToSupport]
      if (beat.widgetId && !placed.has(beat.widgetId)) {
        placed.add(beat.widgetId)
        lines.push(fenceFor(beat.widgetId, spans.get(beat.widgetId) ?? 'full'))
        const finding = findings.get(beat.widgetId)
        if (finding) lines.push(finding)
      }
      return lines
    })

  // Every declared widget must be referenced exactly once, so place any the outline missed.
  const orphaned = widgets.filter((widget) => !placed.has(widget.id))
  if (orphaned.length > 0) {
    body.push('## Supporting evidence')
    for (const widget of orphaned) {
      placed.add(widget.id)
      body.push(fenceFor(widget.id, spans.get(widget.id) ?? 'full'))
      const finding = findings.get(widget.id)
      if (finding) body.push(finding)
    }
  }

  const caveats = [
    ...analysis.datasets.flatMap((dataset) => dataset.caveats),
    ...analysis.cannotEstablish.map((item) => `Not established by this data: ${item}`),
  ]
  if (caveats.length > 0) {
    body.push('## How to read these numbers')
    body.push(caveats.map((caveat) => `- ${caveat}`).join('\n'))
  }

  const markdown = [`# ${brief.title}`, `> ${analysis.headline}`, ...body].join('\n\n')

  return {
    version: 1,
    title: brief.title,
    summary: brief.summary,
    markdown: markdown.length > 32_000 ? `${markdown.slice(0, 31_900)}\n` : markdown,
    datasets,
    widgets,
  }
}
