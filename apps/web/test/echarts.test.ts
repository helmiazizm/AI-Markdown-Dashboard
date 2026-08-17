import { describe, expect, it } from 'vitest'
import { prepareEChartsOption } from '../src/lib/echarts.js'

describe('ECharts host option preparation', () => {
  it('formats the encoded metric from ECharts object-row callback data', () => {
    const option = prepareEChartsOption({
      xAxis: { type: 'value' },
      yAxis: { type: 'category' },
      series: [{
        type: 'bar',
        encode: { x: 'distinct_products', y: 'category' },
        label: { show: true, formatter: '{b}: {c}' },
      }],
    })
    const series = (option.series as Array<Record<string, unknown>>)[0]!
    const formatter = (series.label as { formatter: (params: unknown) => string }).formatter
    expect(formatter({ data: { category: 'APPAREL', distinct_products: 20_530 } })).toBe('20,530')
  })
})
