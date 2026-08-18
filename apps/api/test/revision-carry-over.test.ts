import { describe, expect, it } from 'vitest'
import type { DashboardArtifactV1 } from '@fieldboard/contracts'
import { carryOverAnalysis, carryOverArtifact, carryOverLayout, preservedWidgets, summarizeChangePlan } from '../src/agent/crew/carry-over.js'
import { changePlanSchema, type ChangePlan } from '../src/agent/crew/contracts.js'
import { analystView, designerView, digestArtifact, hasAgentHistory, renderDocumentIntent, renderPromptTrail, type RevisionContext } from '../src/agent/revision-context.js'

const KEPT_SQL = "SELECT data_month, COUNT(*) AS trips FROM tlc.taxi.yellow_trips GROUP BY data_month ORDER BY data_month"
const KEPT_OPTION = {
  xAxis: { type: 'category' },
  yAxis: { type: 'value', name: 'Trips' },
  series: [{ type: 'bar', encode: { x: 'data_month', y: 'trips' } }],
}

const baseArtifact: DashboardArtifactV1 = {
  version: 1,
  title: 'Yellow taxi Q1 performance',
  summary: 'Trips and fares across the quarter, with the airport premium called out.',
  markdown: '# Yellow taxi Q1 performance\n\n> Q1 delivered 11.08 million trips.\n\n```dashboard\n{"widgetId":"monthly-volume-chart"}\n```\n',
  datasets: [
    { id: 'monthly-volume', question: 'How did trips move by month?', sql: KEPT_SQL, expectedColumns: ['data_month', 'trips'], maxRows: 12 },
    { id: 'retired-view', question: 'What did the heatmap show?', sql: 'SELECT 1 AS ok', expectedColumns: ['ok'], maxRows: 1 },
  ],
  widgets: [
    {
      id: 'monthly-volume-chart', datasetId: 'monthly-volume', engine: 'echarts',
      title: 'Trips by month', description: 'Monthly trip counts.',
      accessibilityText: 'A bar chart of monthly yellow taxi trips, highest in March.',
      height: 420, option: KEPT_OPTION,
    },
    {
      id: 'retired-heatmap', datasetId: 'retired-view', engine: 'echarts',
      title: 'Unreadable heatmap', description: 'The chart the analyst asked to remove.',
      accessibilityText: 'A heatmap that overlapped its own labels.',
      height: 420, option: { series: [{ type: 'heatmap' }] },
    },
  ],
}

const context: RevisionContext = {
  baseRevisionId: 'ddf25439-1111-4111-8111-111111111111',
  baseRevisionNumber: 2,
  baseNote: 'The heatmap does not make sense. Replace it with a weekday breakdown.',
  baseSourceKind: 'agent',
  baseArtifact,
  history: [
    digestArtifact({ revisionNumber: 1, note: 'Summarize the performance of NYC taxi in Q1', sourceKind: 'agent', artifact: baseArtifact }),
  ],
}

function plan(overrides: Partial<ChangePlan> = {}): ChangePlan {
  return changePlanSchema.parse({
    datasets: [
      { id: 'monthly-volume', disposition: 'keep' },
      { id: 'retired-view', disposition: 'remove' },
      { id: 'weekday-volume', disposition: 'add' },
    ],
    widgets: [
      { id: 'monthly-volume-chart', disposition: 'keep' },
      { id: 'retired-heatmap', disposition: 'remove' },
      { id: 'weekday-chart', disposition: 'add' },
    ],
    ...overrides,
  })
}

describe('analysis carry-over', () => {
  it('restores the published SQL for a kept dataset the analyst rewrote', () => {
    const submitted = {
      headline: 'Trips grew through the quarter.',
      datasets: [{
        id: 'monthly-volume',
        question: 'How did trips move by month?',
        sql: 'SELECT data_month, COUNT(*) AS journeys FROM tlc.taxi.yellow_trips GROUP BY 1',
        expectedColumns: ['data_month', 'journeys'],
        maxRows: 500,
        finding: 'March was the strongest month.',
        caveats: ['Fares are not inflation-adjusted.'],
      }],
    }
    const carried = carryOverAnalysis(submitted, context, plan()) as typeof submitted
    expect(carried.datasets[0]!.sql).toBe(KEPT_SQL)
    expect(carried.datasets[0]!.expectedColumns).toEqual(['data_month', 'trips'])
    expect(carried.datasets[0]!.maxRows).toBe(12)
    // The analyst's own prose survives; only the executed contract is pinned.
    expect(carried.datasets[0]!.finding).toBe('March was the strongest month.')
    expect(carried.datasets[0]!.caveats).toEqual(['Fares are not inflation-adjusted.'])
  })

  it('reinstates a kept dataset the analyst dropped entirely', () => {
    const carried = carryOverAnalysis({ headline: 'x', datasets: [] }, context, plan()) as { datasets: Array<{ id: string; sql: string }> }
    expect(carried.datasets.map((dataset) => dataset.id)).toEqual(['monthly-volume'])
    expect(carried.datasets[0]!.sql).toBe(KEPT_SQL)
  })

  it('drops a removed dataset even when the analyst resubmits it', () => {
    const submitted = {
      headline: 'x',
      datasets: [
        { id: 'retired-view', question: 'q', sql: 'SELECT 1 AS ok', expectedColumns: ['ok'], maxRows: 1, finding: 'f', caveats: [] },
        { id: 'weekday-volume', question: 'q', sql: 'SELECT 2 AS trips', expectedColumns: ['trips'], maxRows: 7, finding: 'f', caveats: [] },
      ],
    }
    const carried = carryOverAnalysis(submitted, context, plan()) as { datasets: Array<{ id: string; sql: string }> }
    expect(carried.datasets.map((dataset) => dataset.id)).toEqual(['weekday-volume', 'monthly-volume'])
    // An added dataset is left exactly as the analyst tested it.
    expect(carried.datasets[0]!.sql).toBe('SELECT 2 AS trips')
  })

  it('leaves a create-path submission untouched when there is no change plan', () => {
    const submitted = { headline: 'x', datasets: [{ id: 'monthly-volume', sql: 'SELECT 3', expectedColumns: ['a'], maxRows: 1 }] }
    expect(carryOverAnalysis(submitted, context, undefined)).toBe(submitted)
  })
})

describe('layout carry-over', () => {
  it('restores a kept widget option byte for byte while honouring a new span', () => {
    const submitted = {
      widgets: [{
        id: 'monthly-volume-chart', title: 'Redrawn', description: 'Redrawn.',
        accessibilityText: 'A redesigned chart nobody asked for.', height: 300, span: 'half',
        option: { series: [{ type: 'line' }] },
      }],
      outline: [{ kind: 'widget', widgetId: 'monthly-volume-chart', span: 'half' }],
      designNotes: '',
    }
    const carried = carryOverLayout(submitted, context, plan()) as {
      widgets: Array<{ id: string; title: string; height: number; span?: string; option: unknown }>
    }
    expect(carried.widgets[0]!.option).toEqual(KEPT_OPTION)
    expect(carried.widgets[0]!.title).toBe('Trips by month')
    expect(carried.widgets[0]!.height).toBe(420)
    expect(carried.widgets[0]!.span).toBe('half')
  })

  it('reinstates a dropped kept widget and gives it a place in the outline', () => {
    const submitted = {
      widgets: [{
        id: 'weekday-chart', title: 'Weekday volume', description: 'New chart.',
        accessibilityText: 'A bar chart of weekday trip volume.', height: 420,
        option: { series: [{ type: 'bar' }] },
      }],
      outline: [
        { kind: 'lede', claim: 'Weekdays carry the quarter.' },
        { kind: 'widget', widgetId: 'weekday-chart', span: 'full' },
      ],
      designNotes: '',
    }
    const carried = carryOverLayout(submitted, context, plan()) as {
      widgets: Array<{ id: string }>
      outline: Array<{ kind: string; widgetId?: string }>
    }
    expect(carried.widgets.map((widget) => widget.id)).toEqual(['weekday-chart', 'monthly-volume-chart'])
    expect(carried.outline.filter((block) => block.kind === 'widget').map((block) => block.widgetId))
      .toEqual(['weekday-chart', 'monthly-volume-chart'])
  })

  it('removes a retired widget and its fence, so nothing references a widget nobody submits', () => {
    const submitted = {
      widgets: [
        { id: 'retired-heatmap', title: 'Heatmap', description: 'Kept by mistake.', accessibilityText: 'A heatmap.', height: 420, option: {} },
        { id: 'monthly-volume-chart', title: 'Trips by month', description: 'Monthly trip counts.', accessibilityText: 'A bar chart.', height: 420, option: KEPT_OPTION },
      ],
      outline: [
        { kind: 'widget', widgetId: 'retired-heatmap', span: 'full' },
        { kind: 'widget', widgetId: 'monthly-volume-chart', span: 'full' },
      ],
      designNotes: '',
    }
    const carried = carryOverLayout(submitted, context, plan()) as {
      widgets: Array<{ id: string }>
      outline: Array<{ kind: string; widgetId?: string }>
    }
    expect(carried.widgets.map((widget) => widget.id)).toEqual(['monthly-volume-chart'])
    expect(carried.outline.map((block) => block.widgetId)).toEqual(['monthly-volume-chart'])
  })
})

describe('reviewer artifact carry-over', () => {
  it('pins a kept dataset back to the statement that actually ran', () => {
    const artifact = {
      version: 1, title: 't', summary: 's', markdown: 'm',
      datasets: [
        { id: 'monthly-volume', question: 'q', sql: 'SELECT data_month FROM tlc.taxi.yellow_trips', expectedColumns: ['data_month'], maxRows: 500 },
        { id: 'weekday-volume', question: 'q', sql: 'SELECT 2 AS trips', expectedColumns: ['trips'], maxRows: 7 },
      ],
      widgets: [],
    }
    const carried = carryOverArtifact(artifact, context, plan()) as typeof artifact
    expect(carried.datasets[0]!.sql).toBe(KEPT_SQL)
    expect(carried.datasets[0]!.expectedColumns).toEqual(['data_month', 'trips'])
    // A newly added dataset keeps whatever the reviewer submitted and re-tested.
    expect(carried.datasets[1]!.sql).toBe('SELECT 2 AS trips')
  })
})

describe('revision context rendering', () => {
  it('keeps a digest free of the bulky fields', () => {
    const digest = digestArtifact({ revisionNumber: 1, note: 'n', sourceKind: 'agent', artifact: baseArtifact })
    expect(Object.keys(digest).sort()).toEqual(['datasets', 'note', 'revisionNumber', 'sourceKind', 'summary', 'title', 'widgets'])
    expect(JSON.stringify(digest)).not.toContain('SELECT')
    expect(JSON.stringify(digest)).not.toContain('xAxis')
    expect(JSON.stringify(digest)).not.toContain('# Yellow taxi')
  })

  it('renders the trail oldest first and labels a revision that was not an agent request', () => {
    const withImport: RevisionContext = {
      ...context,
      baseSourceKind: 'manual',
      baseNote: 'Imported external edit',
    }
    const trail = renderPromptTrail(withImport)
    const lines = trail.split('\n')
    expect(lines[0]).toContain('Revision 1 was requested with: Summarize the performance')
    expect(lines[1]).toContain('Revision 2 was a hand edit imported from Git, noted as: Imported external edit')
    expect(lines[1]).not.toMatch(/requested with/)
  })

  it('gives the analyst no chart options and the designer no SQL', () => {
    expect(JSON.stringify(analystView(context))).not.toContain('xAxis')
    expect(JSON.stringify(designerView(context))).not.toContain('SELECT')
    expect(designerView(context)[0]!.expectedColumns).toEqual(['data_month', 'trips'])
  })
})

describe('change plan summary', () => {
  it('counts dataset and widget dispositions together for the run trail', () => {
    expect(summarizeChangePlan(plan())).toEqual({
      kept: ['monthly-volume', 'monthly-volume-chart'],
      modified: [],
      added: ['weekday-volume', 'weekday-chart'],
      removed: ['retired-view', 'retired-heatmap'],
    })
  })

  it('lists an id once when a widget is named after the dataset it plots', () => {
    const shared = changePlanSchema.parse({
      datasets: [{ id: 'kids-season-coverage', disposition: 'keep' }],
      widgets: [{ id: 'kids-season-coverage', disposition: 'keep' }],
    })
    expect(summarizeChangePlan(shared).kept).toEqual(['kids-season-coverage'])
  })
})

const D3_SCRIPT = "const root=d3.select(container);root.selectAll('*').remove();const svg=root.append('svg').attr('width',width).attr('height',height);svg.selectAll('circle').data(data).join('circle').attr('cx',(d,i)=>40+i*60).attr('cy',height/2).attr('r',9).attr('fill',theme.signal);"

/** A skill-authored base whose second widget uses a renderer the crew cannot write. */
const d3Context: RevisionContext = {
  ...context,
  baseSourceKind: 'manual',
  baseNote: 'Answer the spring boys-and-girls clothing question within catalog limits',
  history: [],
  baseArtifact: {
    ...baseArtifact,
    widgets: [
      baseArtifact.widgets[0]!,
      {
        id: 'completion-dots', datasetId: 'monthly-volume', engine: 'd3',
        title: 'Completion dots', description: 'A custom dot row for monthly completion.',
        accessibilityText: 'Dots show completion percent by month.',
        height: 300, script: D3_SCRIPT,
      },
    ],
  },
}

function d3Plan(disposition: 'keep' | 'modify' | 'remove'): ChangePlan {
  return changePlanSchema.parse({
    datasets: [{ id: 'monthly-volume', disposition: 'keep' }],
    widgets: [
      { id: 'monthly-volume-chart', disposition: 'keep' },
      { id: 'completion-dots', disposition },
    ],
  })
}

function draftWithoutD3(): Record<string, unknown> {
  return {
    version: 1, title: 't', summary: 'summary text', markdown: '# t\n\n```dashboard\n{"widgetId":"monthly-volume-chart"}\n```\n',
    datasets: [{ id: 'monthly-volume', question: 'q', sql: KEPT_SQL, expectedColumns: ['data_month', 'trips'], maxRows: 12 }],
    widgets: [{
      id: 'monthly-volume-chart', datasetId: 'monthly-volume', engine: 'echarts',
      title: 'Trips by month', description: 'Monthly trip counts.',
      accessibilityText: 'A bar chart of monthly trips.', height: 420, option: KEPT_OPTION,
    }],
  }
}

describe('widgets the crew cannot author', () => {
  it('preserves a kept D3 widget, and treats modify as keep because it cannot be redrawn', () => {
    for (const disposition of ['keep', 'modify'] as const) {
      const preserved = preservedWidgets(d3Context, d3Plan(disposition))
      expect(preserved.map((widget) => widget.id)).toEqual(['completion-dots'])
      expect(preserved[0]).toEqual(d3Context.baseArtifact.widgets[1])
    }
  })

  it('preserves one even when the planner omitted a change plan entirely', () => {
    // An absent plan means "new work" everywhere else, but deleting an authored script nobody
    // asked to delete is not a defensible default.
    expect(preservedWidgets(d3Context, undefined).map((widget) => widget.id)).toEqual(['completion-dots'])
    const carried = carryOverArtifact(draftWithoutD3(), d3Context, undefined) as { widgets: Array<Record<string, unknown>> }
    expect(carried.widgets.map((widget) => widget.id)).toEqual(['monthly-volume-chart', 'completion-dots'])
    expect(carried.widgets[1]!.script).toBe(D3_SCRIPT)
  })

  it('retires one only when the plan says remove', () => {
    expect(preservedWidgets(d3Context, d3Plan('remove'))).toEqual([])
  })

  it('retires one whose dataset was removed, since a widget with no dataset cannot validate', () => {
    const plan = changePlanSchema.parse({
      datasets: [{ id: 'monthly-volume', disposition: 'remove' }],
      widgets: [{ id: 'completion-dots', disposition: 'keep' }],
    })
    expect(preservedWidgets(d3Context, plan)).toEqual([])
  })

  it('swaps a D3 widget the crew rebuilt as ECharts back for the published object, in place', () => {
    const draft = draftWithoutD3()
    draft.widgets = [
      ...(draft.widgets as unknown[]),
      // What assembleArtifact produces today: the right id, the wrong everything else.
      { id: 'completion-dots', datasetId: 'monthly-volume', engine: 'echarts', title: 'Completion dots', description: 'd', accessibilityText: 'a', height: 420, option: { series: [{ type: 'bar' }] } },
    ]
    draft.markdown = `${draft.markdown as string}\n\`\`\`dashboard\n{"widgetId":"completion-dots"}\n\`\`\`\n`
    const carried = carryOverArtifact(draft, d3Context, d3Plan('keep')) as {
      widgets: Array<Record<string, unknown>>
      markdown: string
    }
    const restored = carried.widgets.find((widget) => widget.id === 'completion-dots')!
    expect(restored.engine).toBe('d3')
    expect(restored.script).toBe(D3_SCRIPT)
    expect(restored.option).toBeUndefined()
    // The fence was already there, so no second one is added.
    expect(carried.markdown.match(/"widgetId":"completion-dots"/g)).toHaveLength(1)
    expect(carried.markdown).not.toContain('Supporting evidence')
  })

  it('reinstates and fences a D3 widget the crew dropped entirely', () => {
    const carried = carryOverArtifact(draftWithoutD3(), d3Context, d3Plan('keep')) as {
      widgets: Array<Record<string, unknown>>
      markdown: string
    }
    expect(carried.widgets.map((widget) => widget.id)).toEqual(['monthly-volume-chart', 'completion-dots'])
    expect(carried.widgets[1]!.script).toBe(D3_SCRIPT)
    expect(carried.markdown.match(/"widgetId":"completion-dots"/g)).toHaveLength(1)
    expect(carried.markdown).toContain('Supporting evidence')
  })

  it('leaves a removed D3 widget out without fencing it', () => {
    const carried = carryOverArtifact(draftWithoutD3(), d3Context, d3Plan('remove')) as {
      widgets: Array<Record<string, unknown>>
      markdown: string
    }
    expect(carried.widgets.map((widget) => widget.id)).toEqual(['monthly-volume-chart'])
    expect(carried.markdown).not.toContain('completion-dots')
  })

  it('tells the designer a preserved widget has no option to copy', () => {
    const view = designerView(d3Context)
    const dots = view.find((widget) => widget.id === 'completion-dots')!
    expect(dots.preserved).toBe(true)
    expect(dots.engine).toBe('d3')
    expect(dots.option).toBeUndefined()
    // An ECharts widget is still handed over with its option, and is not flagged.
    const bar = view.find((widget) => widget.id === 'monthly-volume-chart')!
    expect(bar.preserved).toBe(false)
    expect(bar.option).toEqual(KEPT_OPTION)
    // The script never reaches the designer either way.
    expect(JSON.stringify(view)).not.toContain('d3.select')
  })
})

describe('intent read from the document', () => {
  it('states the title, summary, dataset questions and chart titles', () => {
    const intent = renderDocumentIntent(d3Context)
    expect(intent).toContain('Yellow taxi Q1 performance')
    expect(intent).toContain('How did trips move by month?')
    expect(intent).toContain('completion-dots (d3): Completion dots')
    // Markdown is deliberately excluded to keep the analyst and designer prompts small.
    expect(intent).not.toContain('# Yellow taxi Q1 performance')
    expect(intent).not.toContain('SELECT')
  })

  it('knows when there are no prior requests to read', () => {
    expect(hasAgentHistory(d3Context)).toBe(false)
    expect(hasAgentHistory(context)).toBe(true)
    // A manual base with one agent revision behind it still has a usable trail.
    expect(hasAgentHistory({ ...d3Context, history: context.history })).toBe(true)
  })
})
