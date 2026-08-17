import { validateDashboardArtifact, type GenerationEventType } from '@fieldboard/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetConfigForTests } from '../src/config.js'
import { assembleArtifact, defaultChartOption } from '../src/agent/crew/fallbacks.js'
import { runCrewPipeline, type RoleRunRequest, type RunRole } from '../src/agent/crew/orchestrator.js'
import type { AgentRunInput } from '../src/agent/runner.js'

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

function makeInput(stages: GenerationEventType[]): AgentRunInput {
  return {
    prompt: 'Summarize Q1 performance of the yellow taxi in NYC',
    detailLevel: 'detailed',
    onStage: async (type) => { stages.push(type) },
  }
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

  it('rejects a malformed plan and reports it', async () => {
    await expect(runCrewPipeline(makeInput([]), {
      runRole: scriptedRunner({ planner: { title: 'no' } }),
    })).rejects.toThrow(/planner produced no usable brief/)
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
