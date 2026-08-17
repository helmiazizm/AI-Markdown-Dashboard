import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AnalysisTrail from '../src/components/AnalysisTrail.vue'

const queryEvent = {
  id: 3,
  type: 'querying' as const,
  message: 'Query 1: Which segments contain the most records?',
  createdAt: '2026-08-16T08:00:00.000Z',
  payload: {
    kind: 'query_plan',
    queryNumber: 1,
    question: 'Which segments contain the most records?',
    sql: 'SELECT segment, count(*) AS records FROM fashion.catalog.products GROUP BY segment',
    expectedColumns: ['segment', 'records'],
    maxRows: 20,
  },
}

describe('detailed analysis trail', () => {
  it('shows the analytical question, governed SQL, and query contract when enabled', () => {
    const wrapper = mount(AnalysisTrail, { props: { events: [queryEvent], detailed: true } })

    expect(wrapper.text()).toContain('Which segments contain the most records?')
    expect(wrapper.text()).toContain('DuckDB SQL')
    expect(wrapper.find('pre').text()).toContain('count(*)')
    expect(wrapper.text()).toContain('Expected · segment · records')
    expect(wrapper.text()).toContain('Limit 20')
  })

  it('keeps structured payloads hidden in standard mode', () => {
    const wrapper = mount(AnalysisTrail, { props: { events: [queryEvent], detailed: false } })

    expect(wrapper.find('.trail-detail').exists()).toBe(false)
    expect(wrapper.find('pre').exists()).toBe(false)
  })
})

const crewEvents = [
  { id: 1, type: 'queued' as const, message: 'Prompt received.', createdAt: 'now' },
  { id: 2, type: 'planning' as const, message: 'Planning the analysis and the document layout.', createdAt: 'now' },
  { id: 3, type: 'inspecting' as const, message: 'The planner is reading the source context.', createdAt: 'now', payload: { kind: 'source_context', role: 'planner' } },
  { id: 4, type: 'designing' as const, message: 'Analysing and designing in parallel.', createdAt: 'now' },
  { id: 5, type: 'querying' as const, message: "The analyst's query 1 returned 3 rows.", createdAt: 'now', payload: { kind: 'query_result', role: 'analysis' } },
  { id: 6, type: 'designing' as const, message: 'Layout accepted for 5 widgets.', createdAt: 'now', payload: { kind: 'crew_layout', role: 'layout' } },
  { id: 7, type: 'reviewing' as const, message: 'A senior analyst-engineer is reviewing.', createdAt: 'now' },
  { id: 8, type: 'completed' as const, message: 'Dashboard published.', createdAt: 'now' },
]

describe('trail phase grouping', () => {
  it('groups a crew run into ordered phases', () => {
    const wrapper = mount(AnalysisTrail, { props: { events: crewEvents } })
    const labels = wrapper.findAll('.trail-phase-label').map((node) => node.text())

    expect(labels).toEqual(['Planning', 'Analysing and designing, in parallel', 'Senior review', 'Validation and publication'])
    expect(wrapper.findAll('.trail-step')).toHaveLength(crewEvents.length)
  })

  it('marks the parallel phase and labels each role lane', () => {
    const wrapper = mount(AnalysisTrail, { props: { events: crewEvents } })
    const parallel = wrapper.find('.trail-phase.is-parallel')

    expect(parallel.exists()).toBe(true)
    expect(parallel.findAll('.trail-role').map((node) => node.text())).toEqual(['Analyst', 'Designer'])
  })

  it('renders an unknown role rather than dropping the step', () => {
    const wrapper = mount(AnalysisTrail, {
      props: { events: [{ id: 1, type: 'querying' as const, message: 'x', createdAt: 'now', payload: { role: 'auditor' } }] },
    })
    expect(wrapper.find('.trail-role').text()).toBe('auditor')
  })

  // A single-agent run carries no roles and no crew-only stages, so it must keep the original
  // flat chronological trail with no phase headers at all.
  it('keeps a single-agent run flat with no phase headers', () => {
    const singleAgent = [
      { id: 1, type: 'queued' as const, message: 'Prompt received.', createdAt: 'now' },
      { id: 2, type: 'inspecting' as const, message: 'Reading the source context.', createdAt: 'now' },
      queryEvent,
      { id: 4, type: 'completed' as const, message: 'Published.', createdAt: 'now' },
    ]
    const wrapper = mount(AnalysisTrail, { props: { events: singleAgent } })

    expect(wrapper.findAll('.trail-phase-label')).toHaveLength(0)
    expect(wrapper.findAll('.trail-phase')).toHaveLength(1)
    expect(wrapper.findAll('.trail-step')).toHaveLength(singleAgent.length)
    expect(wrapper.find('.trail-role').exists()).toBe(false)
  })

  it('never renders an empty phase group', () => {
    const wrapper = mount(AnalysisTrail, {
      props: { events: [crewEvents[1]!, crewEvents[2]!] },
    })
    expect(wrapper.findAll('.trail-phase-label').map((node) => node.text())).toEqual(['Planning'])
    expect(wrapper.findAll('.trail-phase')).toHaveLength(1)
  })
})
