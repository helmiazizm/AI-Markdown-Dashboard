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
