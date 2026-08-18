import { validateDashboardArtifact, type GenerationEventType } from '@fieldboard/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetConfigForTests } from '../src/config.js'
import { assembleArtifact, defaultChartOption } from '../src/agent/crew/fallbacks.js'
import { runCrewPipeline, type RoleRunRequest, type RunRole } from '../src/agent/crew/orchestrator.js'
import { buildLayoutPrompt } from '../src/agent/crew/roles.js'
import { layoutSubmissionSchema, normalizeLayoutSubmission, salvageLayoutSubmission } from '../src/agent/crew/contracts.js'
import type { AgentRunInput } from '../src/agent/runner.js'
import { digestArtifact, type RevisionContext } from '../src/agent/revision-context.js'

const brief = {
  title: 'Yellow taxi Q1 performance',
  summary: 'Trips and fares across the quarter, with the airport premium called out.',
  decisionQuestion: 'Where did yellow taxi revenue concentrate in Q1?',
  datasets: [{
    id: 'monthly-volume',
    question: 'How did trips and fares move by month?',
    expectedColumns: ['data_month', 'trips', 'revenue_musd'],
    relationHints: ['tlc.taxi.yellow_trips'],
    analyticalNotes: 'Normalise for month length before any month-over-month claim.',
  }],
  widgets: [{
    id: 'monthly-volume-chart',
    datasetId: 'monthly-volume',
    chartForm: 'bar' as const,
    intent: 'Trips per month with fares in the tooltip',
    span: 'full' as const,
  }],
  narrativeSkeleton: [{ heading: 'Volume grew', claimToSupport: 'March was the strongest month.', widgetId: 'monthly-volume-chart' }],
}

const analysis = {
  headline: 'Yellow taxis recorded 11.08 million trips and $330.0M in fares across Q1 2026.',
  datasets: [{
    id: 'monthly-volume',
    question: 'How did trips and fares move by month?',
    sql: "SELECT data_month, COUNT(*) AS trips, ROUND(SUM(total_amount)/1000000, 2) AS revenue_musd FROM tlc.taxi.yellow_trips WHERE data_month BETWEEN DATE '2026-01-01' AND DATE '2026-03-01' GROUP BY data_month ORDER BY data_month",
    expectedColumns: ['data_month', 'trips', 'revenue_musd'],
    maxRows: 12,
    finding: 'February trails January in total trips but is 1.1% higher per day, so the drop is a calendar artifact.',
    caveats: ['Fares are as recorded by TLC and are not inflation-adjusted.'],
  }],
  amendments: [],
  cannotEstablish: ['Why demand collapsed on 23 February; this data carries no weather field.'],
}

const layout = {
  widgets: [{
    id: 'monthly-volume-chart',
    title: 'Trips and fares by month',
    description: 'Monthly trip counts with fares collected in the tooltip.',
    accessibilityText: 'A bar chart of monthly yellow taxi trips. March is highest at 3.95 million, February lowest at 3.40 million.',
    height: 420,
    span: 'full' as const,
    option: { xAxis: { type: 'category' }, yAxis: { type: 'value', name: 'Trips' }, series: [{ type: 'bar', encode: { x: 'data_month', y: 'trips' } }] },
  }],
  outline: [
    { kind: 'lede' as const, claim: 'Q1 delivered 11.08 million trips.' },
    { kind: 'heading' as const, level: 2 as const, text: 'Volume grew' },
    { kind: 'widget' as const, widgetId: 'monthly-volume-chart', span: 'full' as const },
  ],
  designNotes: 'One chart is enough for three data points.',
}

function makeInput(stages: GenerationEventType[], revisionContext?: RevisionContext): AgentRunInput {
  return {
    prompt: 'Summarize Q1 performance of the yellow taxi in NYC',
    detailLevel: 'detailed',
    revisionContext,
    onStage: async (type) => { stages.push(type) },
  }
}

const publishedSql = "SELECT data_month, COUNT(*) AS trips, ROUND(SUM(total_amount)/1000000, 2) AS revenue_musd FROM tlc.taxi.yellow_trips GROUP BY data_month ORDER BY data_month"

/** A published revision 2 whose single dataset and widget are the ones a follow-up should keep. */
function makeRevisionContext(): RevisionContext {
  const baseArtifact = validateDashboardArtifact(assembleArtifact(brief, {
    ...analysis,
    datasets: [{ ...analysis.datasets[0]!, sql: publishedSql }],
  }, layout))
  return {
    baseRevisionId: 'ddf25439-1111-4111-8111-111111111111',
    baseRevisionNumber: 2,
    baseNote: 'Add the airport premium to the narrative',
    baseSourceKind: 'agent',
    baseArtifact,
    history: [digestArtifact({
      revisionNumber: 1,
      note: 'Summarize the performance of NYC taxi in Q1',
      sourceKind: 'agent',
      artifact: baseArtifact,
    })],
  }
}

const keepEverything = {
  datasets: [{ id: 'monthly-volume', disposition: 'keep' as const, reason: 'still answers the question' }],
  widgets: [{ id: 'monthly-volume-chart', disposition: 'keep' as const, reason: 'unchanged' }],
  narrativeChanges: 'Only the closing caveat changes.',
}

/** Drives each role by invoking its submit tool with a canned payload. */
function scriptedRunner(payloads: Partial<Record<string, unknown>>, log: string[] = []): RunRole {
  return async (request: RoleRunRequest) => {
    log.push(request.role)
    const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))
    if (!submit) throw new Error(`No submit tool offered to ${request.role}`)
    const payload = payloads[request.role]
    if (payload === undefined) throw new Error(`role ${request.role} failed`)
    await submit.execute(payload as never)
    return { usage: { role: request.role } }
  }
}

describe('crew generation pipeline', () => {
  beforeEach(() => {
    resetConfigForTests()
    process.env.CREW_REVIEW_QUERY_BUDGET = '0'
  })

  it('runs all four roles and returns the reviewer submission', async () => {
    const stages: GenerationEventType[] = []
    const order: string[] = []
    const reviewed = { ...assembleArtifact(brief, analysis, layout), title: 'Reviewed title' }
    const result = await runCrewPipeline(makeInput(stages), {
      runRole: scriptedRunner({ planner: brief, analysis, layout, reviewer: reviewed }, order),
    })
    expect(order).toEqual(['planner', 'analysis', 'layout', 'reviewer'])
    expect(result.artifact.title).toBe('Reviewed title')
    expect(stages).toEqual(expect.arrayContaining(['planning', 'designing', 'reviewing']))
  })

  it('offers a query tool only to the analyst so the parallel phase cannot run two queries', async () => {
    const toolsByRole = new Map<string, string[]>()
    await runCrewPipeline(makeInput([]), {
      runRole: async (request) => {
        toolsByRole.set(request.role, request.tools.map((tool) => tool.name))
        const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
        const payload = { planner: brief, analysis, layout, reviewer: assembleArtifact(brief, analysis, layout) }[request.role]
        await submit.execute(payload as never)
        return {}
      },
    })
    expect(toolsByRole.get('analysis')).toContain('run_readonly_query')
    expect(toolsByRole.get('layout')).not.toContain('run_readonly_query')
    expect(toolsByRole.get('planner')).not.toContain('run_readonly_query')
  })

  it('falls back to the assembled draft when the reviewer fails', async () => {
    const stages: GenerationEventType[] = []
    const result = await runCrewPipeline(makeInput(stages), {
      runRole: scriptedRunner({ planner: brief, analysis, layout }),
    })
    expect(result.artifact.title).toBe(brief.title)
    expect(result.artifact.widgets[0]!.option).toEqual(layout.widgets[0]!.option)
  })

  it('falls back to default chart options when the designer fails', async () => {
    const result = await runCrewPipeline(makeInput([]), {
      runRole: scriptedRunner({ planner: brief, analysis }),
    })
    expect(result.artifact.widgets).toHaveLength(1)
    expect(result.artifact.widgets[0]!.option).toEqual(defaultChartOption('bar', ['data_month', 'trips', 'revenue_musd']))
  })

  it('fails when the analyst produces nothing, since there is no evidence to publish', async () => {
    await expect(runCrewPipeline(makeInput([]), {
      runRole: scriptedRunner({ planner: brief, layout }),
    })).rejects.toThrow(/analyst produced no usable analysis/)
  })

  it('rejects reviewer SQL that never ran, instead of letting it fail at publication', async () => {
    const smuggled = assembleArtifact(brief, analysis, layout)
    smuggled.datasets[0]!.sql = 'SELECT data_month FROM tlc.taxi.yellow_trips; DROP TABLE x'
    const attempts: string[] = []
    const result = await runCrewPipeline(makeInput([]), {
      runRole: async (request) => {
        const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
        if (request.role === 'reviewer') {
          attempts.push('reviewer')
          const outcome = await submit.execute(smuggled as never) as { isError?: boolean }
          expect(outcome.isError).toBe(true)
          return {}
        }
        await submit.execute({ planner: brief, analysis, layout }[request.role] as never)
        return {}
      },
    })
    // Rejected in the reviewer loop, so the deterministic draft is published instead.
    expect(attempts).toHaveLength(2)
    expect(result.artifact.datasets[0]!.sql).not.toContain('DROP TABLE')
  })

  it('accepts an outline written with the synonyms models reach for', async () => {
    const looselyShaped = {
      ...layout,
      outline: [
        { type: 'h2', title: 'Volume grew' },
        { kind: 'paragraph', content: 'March was the strongest month.' },
        { type: 'chart', id: 'monthly-volume-chart' },
      ],
    }
    const stages: GenerationEventType[] = []
    const result = await runCrewPipeline(makeInput(stages), {
      runRole: scriptedRunner({ planner: brief, analysis, layout: looselyShaped }),
    })
    expect(result.artifact.markdown).toContain('## Volume grew')
    expect(result.artifact.markdown).toContain('March was the strongest month.')
    expect(result.artifact.markdown).toContain('{"widgetId":"monthly-volume-chart"}')
    // The design was accepted, so nothing fell back to a default option.
    expect(result.artifact.widgets[0]!.option).toEqual(layout.widgets[0]!.option)
  })

  it('keeps the designer chart specs when only the outline is unusable', async () => {
    const brokenOutline = { ...layout, outline: [{ kind: 'widget' }, { kind: 'prose' }] }
    const stages: GenerationEventType[] = []
    const result = await runCrewPipeline(makeInput(stages), {
      runRole: scriptedRunner({ planner: brief, analysis, layout: brokenOutline }),
    })
    expect(result.artifact.widgets[0]!.option).toEqual(layout.widgets[0]!.option)
    // The outline was dropped, so the planner's narrative skeleton shapes the document instead.
    expect(result.artifact.markdown).toContain('## Volume grew')
    expect(result.artifact.markdown.match(/```dashboard/g)).toHaveLength(1)
  })

  it('rejects a malformed plan and reports it', async () => {
    await expect(runCrewPipeline(makeInput([]), {
      runRole: scriptedRunner({ planner: { title: 'no' } }),
    })).rejects.toThrow(/planner produced no usable brief/)
  })
})

describe('layout submission tolerance', () => {
  it('translates block shapes that carry the same meaning under different keys', () => {
    const parsed = layoutSubmissionSchema.parse(normalizeLayoutSubmission({
      widgets: layout.widgets,
      outline: [
        '## Volume grew',
        'A bare string is prose.',
        { kind: 'lede', text: 'Q1 delivered 11.08 million trips.' },
        { kind: 'heading', level: '3', label: 'Detail' },
        { kind: 'figure', widget_id: 'monthly-volume-chart', width: 'Half' },
      ],
    }))
    expect(parsed.outline).toEqual([
      { kind: 'heading', level: 2, text: 'Volume grew' },
      { kind: 'prose', claim: 'A bare string is prose.' },
      { kind: 'lede', claim: 'Q1 delivered 11.08 million trips.' },
      { kind: 'heading', level: 3, text: 'Detail' },
      { kind: 'widget', widgetId: 'monthly-volume-chart', span: 'half' },
    ])
  })

  it('leaves a block whose meaning is genuinely missing to fail validation', () => {
    const normalized = normalizeLayoutSubmission({ widgets: layout.widgets, outline: [{ kind: 'widget' }, { kind: 'heading', level: 2, text: 'Fine' }] })
    expect(layoutSubmissionSchema.safeParse(normalized).success).toBe(false)
  })

  it('salvages the widgets of a submission the outline made invalid', () => {
    const salvaged = salvageLayoutSubmission({ widgets: layout.widgets, outline: [{ kind: 'widget' }], designNotes: 'kept' })
    expect(salvaged?.widgets).toHaveLength(1)
    expect(salvaged?.outline).toEqual([])
    expect(salvaged?.designNotes).toBe('kept')
    expect(salvageLayoutSubmission({ widgets: [{ id: 'x' }], outline: [] })).toBeUndefined()
  })
})

describe('crew artifact assembly', () => {
  it('produces a valid artifact that places every widget exactly once', () => {
    const artifact = validateDashboardArtifact(assembleArtifact(brief, analysis, layout))
    const fences = artifact.markdown.match(/```dashboard/g) ?? []
    expect(fences).toHaveLength(1)
    expect(artifact.markdown).toContain('> Yellow taxis recorded')
    expect(artifact.markdown).toContain('not inflation-adjusted')
    expect(artifact.markdown).toContain('Not established by this data')
  })

  it('applies an analyst amendment to the dataset contract', () => {
    const amended = {
      ...analysis,
      amendments: [{ datasetId: 'monthly-volume', expectedColumns: ['data_month', 'trips'], reason: 'revenue_musd was not computable at this grain' }],
    }
    const artifact = assembleArtifact(brief, amended, layout)
    expect(artifact.datasets[0]!.expectedColumns).toEqual(['data_month', 'trips'])
  })

  it('places a widget the outline forgot rather than failing validation', () => {
    const forgetful = { ...layout, outline: [{ kind: 'heading' as const, level: 2 as const, text: 'Only a heading' }, { kind: 'prose' as const, claim: 'No widget here.' }] }
    const artifact = validateDashboardArtifact(assembleArtifact(brief, analysis, forgetful))
    expect(artifact.markdown).toContain('Supporting evidence')
    expect(artifact.markdown.match(/```dashboard/g)).toHaveLength(1)
  })

  it('emits a half-span fence only when the span is half', () => {
    const paired = { ...layout, widgets: [{ ...layout.widgets[0]!, span: 'half' as const }] }
    expect(assembleArtifact(brief, analysis, paired).markdown).toContain('{"widgetId":"monthly-volume-chart","span":"half"}')
    expect(assembleArtifact(brief, analysis, layout).markdown).toContain('{"widgetId":"monthly-volume-chart"}')
  })
})

describe('crew revisions continue the published dashboard', () => {
  beforeEach(() => {
    resetConfigForTests()
    process.env.CREW_REVIEW_QUERY_BUDGET = '0'
  })

  it('gives every role the published state and the prompt trail, not just the planner', async () => {
    const revision = makeRevisionContext()
    const prompts = new Map<string, string>()
    const revisedBrief = { ...brief, changePlan: keepEverything }
    await runCrewPipeline(makeInput([], revision), {
      runRole: async (request) => {
        prompts.set(request.role, request.prompt)
        const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
        const payload = {
          planner: revisedBrief,
          analysis,
          layout,
          reviewer: assembleArtifact(revisedBrief, analysis, layout),
        }[request.role]
        await submit.execute(payload as never)
        return {}
      },
    })
    for (const role of ['planner', 'analysis', 'layout', 'reviewer']) {
      const prompt = prompts.get(role) ?? ''
      expect(prompt, `${role} prompt names the published dataset`).toContain('monthly-volume')
      expect(prompt, `${role} prompt carries the prompt trail`).toContain('Revision 1 was requested with')
      expect(prompt, `${role} prompt states which revision it is producing`).toContain('revision 3')
    }
    // Each role is given only the slice it can act on.
    expect(prompts.get('analysis')).toContain(publishedSql)
    expect(prompts.get('analysis')).not.toContain('xAxis')
    expect(prompts.get('layout')).not.toContain(publishedSql)
  })

  it('publishes the SQL that already ran even when the analyst rewrites a kept dataset', async () => {
    const revision = makeRevisionContext()
    const revisedBrief = { ...brief, changePlan: keepEverything }
    const rewritten = {
      ...analysis,
      datasets: [{ ...analysis.datasets[0]!, sql: 'SELECT data_month, COUNT(*) AS journeys FROM tlc.taxi.yellow_trips GROUP BY 1', expectedColumns: ['data_month', 'journeys'] }],
    }
    const result = await runCrewPipeline(makeInput([], revision), {
      runRole: scriptedRunner({ planner: revisedBrief, analysis: rewritten, layout }),
    })
    expect(result.artifact.datasets[0]!.sql).toBe(publishedSql)
    expect(result.artifact.datasets[0]!.expectedColumns).toEqual(['data_month', 'trips', 'revenue_musd'])
    expect(result.artifact.widgets[0]!.id).toBe('monthly-volume-chart')
  })

  it('restores a kept widget the designer redrew, so an untouched chart stays untouched', async () => {
    const revision = makeRevisionContext()
    const revisedBrief = { ...brief, changePlan: keepEverything }
    const redrawn = {
      ...layout,
      widgets: [{ ...layout.widgets[0]!, title: 'Redrawn without being asked', height: 300, option: { series: [{ type: 'line' }] } }],
    }
    const result = await runCrewPipeline(makeInput([], revision), {
      runRole: scriptedRunner({ planner: revisedBrief, analysis, layout: redrawn }),
    })
    expect(result.artifact.widgets[0]!.option).toEqual(revision.baseArtifact.widgets[0]!.option)
    expect(result.artifact.widgets[0]!.title).toBe(revision.baseArtifact.widgets[0]!.title)
  })

  it('reports the revision context and the change plan in the run trail', async () => {
    const revision = makeRevisionContext()
    const revisedBrief = { ...brief, changePlan: keepEverything }
    const payloads: Array<Record<string, unknown>> = []
    await runCrewPipeline({
      prompt: 'Soften the closing caveat',
      detailLevel: 'detailed',
      revisionContext: revision,
      onStage: async (_type, _message, payload) => { if (payload) payloads.push(payload) },
    }, {
      runRole: scriptedRunner({ planner: revisedBrief, analysis, layout, reviewer: assembleArtifact(revisedBrief, analysis, layout) }),
    })
    const kinds = payloads.map((payload) => payload.kind)
    expect(kinds).toContain('revision_context')
    expect(kinds).toContain('crew_change_plan')
    const change = payloads.find((payload) => payload.kind === 'crew_change_plan')!
    expect(change.kept).toEqual(['monthly-volume', 'monthly-volume-chart'])
  })

  it('asks the analyst only for datasets that change, and says the rest are carried over', async () => {
    const revision = makeRevisionContext()
    const revisedBrief = {
      ...brief,
      datasets: [
        ...brief.datasets,
        { id: 'weekday-volume', question: 'How do weekdays compare with weekends?', expectedColumns: ['day_type', 'trips'], relationHints: [], analyticalNotes: '' },
      ],
      widgets: [
        ...brief.widgets,
        { id: 'weekday-chart', datasetId: 'weekday-volume', chartForm: 'bar' as const, intent: 'Weekday versus weekend volume', span: 'full' as const },
      ],
      changePlan: {
        datasets: [
          { id: 'monthly-volume', disposition: 'keep' as const, reason: 'unchanged' },
          { id: 'weekday-volume', disposition: 'add' as const, reason: 'the follow-up asks for it' },
        ],
        widgets: [
          { id: 'monthly-volume-chart', disposition: 'keep' as const, reason: 'unchanged' },
          { id: 'weekday-chart', disposition: 'add' as const, reason: 'new' },
        ],
        narrativeChanges: '',
      },
    }
    let analysisPrompt = ''
    const result = await runCrewPipeline(makeInput([], revision), {
      runRole: async (request) => {
        if (request.role === 'analysis') analysisPrompt = request.prompt
        const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
        if (request.role === 'planner') await submit.execute(revisedBrief as never)
        if (request.role === 'analysis') {
          // Only the added dataset, as instructed.
          await submit.execute({
            ...analysis,
            datasets: [{
              id: 'weekday-volume', question: 'How do weekdays compare with weekends?',
              sql: 'SELECT day_type, COUNT(*) AS trips FROM tlc.taxi.yellow_trips GROUP BY day_type',
              expectedColumns: ['day_type', 'trips'], maxRows: 2,
              finding: 'Weekdays carry 71 percent of the trips in the quarter.', caveats: [],
            }],
          } as never)
        }
        if (request.role === 'layout') await submit.execute(layout as never)
        return {}
      },
    })
    // Carry-over reinstates the kept dataset the analyst never mentioned, so the published chart
    // keeps its source and the artifact still validates.
    expect(result.artifact.datasets.map((dataset) => dataset.id).sort()).toEqual(['monthly-volume', 'weekday-volume'])
    expect(result.artifact.datasets.find((dataset) => dataset.id === 'monthly-volume')!.sql).toBe(publishedSql)
    expect(analysisPrompt).toContain('carried over for you automatically')
    // The kept dataset is named as carried over, not handed back as work to redo.
    const requested = analysisPrompt.slice(analysisPrompt.indexOf('Produce the SQL and findings'))
    expect(requested).toContain('weekday-volume')
    expect(requested).not.toContain('monthly-volume')
  })

  it('leaves the create path exactly as it was, with no revision language in any prompt', async () => {
    const prompts: string[] = []
    await runCrewPipeline(makeInput([]), {
      runRole: async (request) => {
        prompts.push(request.prompt)
        const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
        const payload = { planner: brief, analysis, layout, reviewer: assembleArtifact(brief, analysis, layout) }[request.role]
        await submit.execute(payload as never)
        return {}
      },
    })
    expect(prompts).toHaveLength(4)
    for (const prompt of prompts) {
      expect(prompt).not.toContain('revision')
      expect(prompt).not.toContain('change plan')
    }
    expect(prompts[0]).toContain('Plan a new dashboard from the governed warehouse catalog')
  })
})

const SKILL_D3_SCRIPT = "const root=d3.select(container);root.selectAll('*').remove();const svg=root.append('svg').attr('width',width).attr('height',height);svg.append('circle').attr('cx',width/2).attr('cy',height/2).attr('r',10).attr('fill',theme.signal);"

/**
 * A base as the fieldboard-author-dashboard skill would leave it: imported from Git, so its only
 * recorded prompt is a change note, and carrying a D3 widget the crew cannot author.
 */
function makeSkillAuthoredContext(): RevisionContext {
  const assembled = validateDashboardArtifact(assembleArtifact(brief, {
    ...analysis,
    datasets: [{ ...analysis.datasets[0]!, sql: publishedSql }],
  }, layout))
  const baseArtifact = validateDashboardArtifact({
    ...assembled,
    widgets: [
      ...assembled.widgets,
      {
        id: 'completion-dots', datasetId: 'monthly-volume', engine: 'd3' as const,
        title: 'Completion dots', description: 'A custom dot row the skill authored.',
        accessibilityText: 'Dots show completion percent by month.',
        height: 300, script: SKILL_D3_SCRIPT,
      },
    ],
    markdown: `${assembled.markdown}\n\n\`\`\`dashboard\n{"widgetId":"completion-dots"}\n\`\`\`\n`,
  })
  return {
    baseRevisionId: 'ccf25439-1111-4111-8111-111111111111',
    baseRevisionNumber: 1,
    baseNote: 'Answer the spring boys-and-girls clothing question within catalog limits',
    baseSourceKind: 'manual',
    baseArtifact,
    history: [],
  }
}

describe('crew revisions of a skill-authored dashboard', () => {
  beforeEach(() => {
    resetConfigForTests()
    process.env.CREW_REVIEW_QUERY_BUDGET = '0'
  })

  const skillBrief = {
    ...brief,
    changePlan: {
      datasets: [{ id: 'monthly-volume', disposition: 'keep' as const, reason: 'unchanged' }],
      widgets: [
        { id: 'monthly-volume-chart', disposition: 'keep' as const, reason: 'unchanged' },
        { id: 'completion-dots', disposition: 'keep' as const, reason: 'custom renderer' },
      ],
      narrativeChanges: '',
    },
  }

  it('takes intent from the document and never presents an import note as a request', async () => {
    const revision = makeSkillAuthoredContext()
    const prompts = new Map<string, string>()
    await runCrewPipeline(makeInput([], revision), {
      runRole: async (request) => {
        prompts.set(request.role, request.prompt)
        const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
        const payload = { planner: skillBrief, analysis, layout, reviewer: undefined }[request.role]
        if (payload !== undefined) await submit.execute(payload as never)
        return {}
      },
    })
    for (const role of ['planner', 'analysis', 'layout', 'reviewer']) {
      const prompt = prompts.get(role) ?? ''
      expect(prompt, `${role} reads intent from the document`).toContain('What this dashboard already argues')
      expect(prompt, `${role} sees the dataset question`).toContain('How did trips and fares move by month?')
      expect(prompt, `${role} is told there are no prior requests`).toContain('authored outside the crew')
      // The import note must never be dressed up as an analytical request.
      expect(prompt, `${role} gets no fabricated request line`).not.toContain('was requested with')
    }
  })

  it('publishes the D3 widget with its script intact, fenced exactly once', async () => {
    const revision = makeSkillAuthoredContext()
    const result = await runCrewPipeline(makeInput([], revision), {
      runRole: scriptedRunner({ planner: skillBrief, analysis, layout }),
    })
    const dots = result.artifact.widgets.find((widget) => widget.id === 'completion-dots')
    expect(dots?.engine).toBe('d3')
    expect(dots && 'script' in dots ? dots.script : undefined).toBe(SKILL_D3_SCRIPT)
    expect(result.artifact.markdown.match(/"widgetId":"completion-dots"/g)).toHaveLength(1)
    // The ECharts widget beside it is still carried over normally.
    expect(result.artifact.widgets.find((widget) => widget.id === 'monthly-volume-chart')!.option)
      .toEqual(revision.baseArtifact.widgets[0]!.option)
  })

  it('reports the preserved widget rather than swapping it silently', async () => {
    const revision = makeSkillAuthoredContext()
    const payloads: Array<Record<string, unknown>> = []
    await runCrewPipeline({
      prompt: 'Soften the closing caveat',
      detailLevel: 'detailed',
      revisionContext: revision,
      onStage: async (_type, _message, payload) => { if (payload) payloads.push(payload) },
    }, {
      runRole: scriptedRunner({ planner: skillBrief, analysis, layout }),
    })
    const preserved = payloads.find((payload) => payload.kind === 'crew_preserved_widgets')
    expect(preserved).toBeDefined()
    expect(preserved!.widgets).toEqual(['completion-dots'])
    expect(preserved!.engines).toEqual(['d3'])
  })

  it('still renders the prompt trail when the dashboard does have agent history', async () => {
    const agentRevision = makeRevisionContext()
    let plannerPrompt = ''
    await runCrewPipeline(makeInput([], agentRevision), {
      runRole: async (request) => {
        if (request.role === 'planner') plannerPrompt = request.prompt
        const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
        const payload = { planner: { ...brief, changePlan: keepEverything }, analysis, layout, reviewer: undefined }[request.role]
        if (payload !== undefined) await submit.execute(payload as never)
        return {}
      },
    })
    expect(plannerPrompt).toContain('Revision 1 was requested with')
    expect(plannerPrompt).not.toContain('authored outside the crew')
    // The derived brief is present either way.
    expect(plannerPrompt).toContain('What this dashboard already argues')
  })
})

describe('the designer runs on the analysis rather than beside it', () => {
  beforeEach(() => {
    resetConfigForTests()
    process.env.CREW_REVIEW_QUERY_BUDGET = '0'
  })

  function capture(payloads: Partial<Record<string, unknown>>): { prompts: Map<string, string>; order: string[]; run: () => Promise<unknown> } {
    const prompts = new Map<string, string>()
    const order: string[] = []
    return {
      prompts,
      order,
      run: () => runCrewPipeline(makeInput([]), {
        runRole: async (request) => {
          order.push(request.role)
          prompts.set(request.role, request.prompt)
          const submit = request.tools.find((tool) => tool.name.startsWith('submit_'))!
          const payload = payloads[request.role]
          if (payload === undefined) throw new Error(`role ${request.role} failed`)
          await submit.execute(payload as never)
          return {}
        },
      }),
    }
  }

  it('hands the designer the analyst headline, findings and delivered columns', async () => {
    const probe = capture({ planner: brief, analysis, layout, reviewer: assembleArtifact(brief, analysis, layout) })
    await probe.run()
    expect(probe.order).toEqual(['planner', 'analysis', 'layout', 'reviewer'])
    const designer = probe.prompts.get('layout') ?? ''
    expect(designer).toContain(analysis.headline)
    expect(designer).toContain('February trails January in total trips')
    expect(designer).toContain('What the analyst concluded')
    // No query ran in this scripted run, so the designer is told the profile is missing rather
    // than being left to assume a row count.
    expect(designer).toContain('No tested result was captured for monthly-volume')
  })

  it('gives the designer the amended columns, not the ones the planner predicted', async () => {
    const amendedAnalysis = {
      ...analysis,
      datasets: [{ ...analysis.datasets[0]!, expectedColumns: ['data_month', 'trips'] }],
      amendments: [{ datasetId: 'monthly-volume', expectedColumns: ['data_month', 'trips'], reason: 'revenue_musd was not computable at this grain' }],
    }
    const probe = capture({ planner: brief, analysis: amendedAnalysis, layout, reviewer: assembleArtifact(brief, amendedAnalysis, layout) })
    await probe.run()
    const designer = probe.prompts.get('layout') ?? ''
    // The planner asked for revenue_musd; the analyst could not deliver it. Running second is what
    // lets the designer know that before it encodes anything.
    const delivered = designer.slice(designer.indexOf('The datasets as delivered'))
    expect(delivered).toContain('data_month')
    expect(delivered).toContain('trips')
    expect(delivered).not.toContain('revenue_musd')
  })

  it('never pays for a design when the analyst produced nothing', async () => {
    const probe = capture({ planner: brief, layout, reviewer: assembleArtifact(brief, analysis, layout) })
    await expect(probe.run()).rejects.toThrow(/analyst produced no usable analysis/)
    // The designer is not in the order at all: previously it ran in parallel and its tokens were
    // spent before anyone knew the analysis had failed.
    expect(probe.order).toEqual(['planner', 'analysis'])
  })
})

describe('layout prompt data profile', () => {
  const analysed = [{
    id: 'monthly-volume',
    question: 'How did trips move by month?',
    expectedColumns: ['data_month', 'trips'],
    finding: 'March was the strongest month.',
    caveats: [],
    profile: {
      columns: ['data_month', 'trips'],
      rowCount: 3,
      truncated: false,
      exampleRows: [{ data_month: '2026-01-01', trips: 3_400_000 }],
    },
  }]

  it('shows what the tested query returned, so the chart form follows the real shape', () => {
    const prompt = buildLayoutPrompt({ prompt: 'p', brief, headline: 'h', analysed })
    expect(prompt).toContain('"rowCount": 3')
    expect(prompt).toContain('3400000')
    expect(prompt).toContain('amendments already applied')
    expect(prompt).not.toContain('No tested result was captured')
  })

  it('names the datasets it could not profile instead of implying a row count', () => {
    const prompt = buildLayoutPrompt({
      prompt: 'p', brief, headline: 'h',
      analysed: [{ ...analysed[0]!, profile: undefined }],
    })
    expect(prompt).toContain('No tested result was captured for monthly-volume')
  })
})
