import { describe, expect, it } from 'vitest'
import { extractWidgetReferences, validateDashboardArtifact } from '../src/index.js'

const base = {
  version: 1 as const,
  title: 'Segment pulse',
  summary: 'A concise view of the active source.',
  markdown: '# Segment pulse\n\n```dashboard\n{"widgetId":"by-segment"}\n```',
  datasets: [{
    id: 'segment-counts',
    question: 'How large is each segment?',
    sql: 'SELECT segment, count(*) AS records FROM fashion.catalog.products GROUP BY 1',
    expectedColumns: ['segment', 'records'],
    maxRows: 100,
  }],
  widgets: [{
    id: 'by-segment',
    datasetId: 'segment-counts',
    engine: 'echarts' as const,
    title: 'Records by segment',
    description: 'The largest segments by source record count.',
    height: 420,
    accessibilityText: 'Horizontal bars compare source records by segment.',
    option: { xAxis: { type: 'value' }, yAxis: { type: 'category' }, series: [{ type: 'bar', encode: { x: 'records', y: 'segment' } }] },
  }],
}

describe('dashboard artifact contract', () => {
  it('accepts a complete referenced artifact', () => {
    expect(validateDashboardArtifact(base).title).toBe('Segment pulse')
    expect(extractWidgetReferences(base.markdown)).toEqual(['by-segment'])
  })

  it('rejects embedded data and external URLs', () => {
    const unsafe = structuredClone(base)
    unsafe.widgets[0]!.option = { series: [{ type: 'bar', data: [1, 2] }], image: 'https://example.com/a.png' }
    expect(() => validateDashboardArtifact(unsafe)).toThrow(/host dataset|external/)
  })

  it('rejects dangerous D3 capabilities', () => {
    for (const script of ['fetch("https://example.com")', 'localStorage.getItem("x")', 'parent.location = "https://example.com"']) {
      const unsafe = structuredClone(base) as any
      unsafe.widgets = [{ ...unsafe.widgets[0], engine: 'd3', script }]
      expect(() => validateDashboardArtifact(unsafe)).toThrow(/blocked D3 capability/)
    }
  })

  it('rejects prototype pollution keys and forged widget references', () => {
    const pollution = structuredClone(base) as any
    pollution.widgets[0].option = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}')
    expect(() => validateDashboardArtifact(pollution)).toThrow(/not allowed/)
    const missing = structuredClone(base)
    missing.markdown = '```dashboard\n{"widgetId":"unknown-chart"}\n```'
    expect(() => validateDashboardArtifact(missing)).toThrow(/unknown widget/)
  })
})
