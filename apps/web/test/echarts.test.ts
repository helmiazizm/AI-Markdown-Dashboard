import { describe, expect, it } from 'vitest'
import { formatTooltipValue, HOST_PALETTE, prepareEChartsOption, withSanctionedPalette } from '../src/lib/echarts.js'

// The real option the crew produced for the zone ranking, which rendered a tooltip titled "8"
// listing raw 15-digit floats, with the rotated axis name overlapping clipped zone labels.
const zoneRanking = {
  grid: { top: 16, left: 8, right: 28, bottom: 8, containLabel: true },
  xAxis: { name: 'Average passenger total (USD per trip)', type: 'value', nameGap: 28, nameLocation: 'middle' },
  yAxis: { name: 'Pickup zone', type: 'category', inverse: true, nameGap: 96, nameLocation: 'middle', axisLabel: { interval: 0 } },
  series: [{
    type: 'bar',
    barMaxWidth: 16,
    encode: { x: 'avg_total_usd', y: 'pu_zone', tooltip: ['pu_zone', 'pu_borough', 'avg_total_usd', 'trips'] },
  }],
  tooltip: { trigger: 'item' },
}

const zoneRow = { pu_zone: 'Flushing Meadows-Corona Park', pu_borough: 'Queens', avg_total_usd: 30.270362786862794, trips: 443_897 }

describe('tooltip value formatting', () => {
  it('keeps thousands separators on integers and trims float noise', () => {
    expect(formatTooltipValue(443_897)).toBe('443,897')
    expect(formatTooltipValue(30.270362786862794)).toBe('30.27')
    expect(formatTooltipValue(19.035330080326318)).toBe('19.04')
  })

  it('keeps enough precision for small fractions to stay meaningful', () => {
    expect(formatTooltipValue(0.0043)).toBe('0.0043')
  })

  it('renders absent and non-finite values as a dash', () => {
    expect(formatTooltipValue(null)).toBe('—')
    expect(formatTooltipValue(undefined)).toBe('—')
    expect(formatTooltipValue(Number.NaN)).toBe('—')
  })
})

describe('default tooltip formatter', () => {
  it('titles the tooltip with the category value and names every dimension', () => {
    const option = prepareEChartsOption(zoneRanking)
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter
    const html = formatter({ seriesIndex: 0, marker: '<span></span>', name: '8', data: zoneRow })
    expect(html).toContain('Flushing Meadows-Corona Park')
    expect(html).toContain('avg_total_usd: <strong>30.27</strong>')
    expect(html).toContain('trips: <strong>443,897</strong>')
    expect(html).not.toContain('30.270362786862794')
    // The category is the heading, so it is not repeated as a row.
    expect(html).not.toContain('pu_zone:')
  })

  it('handles an axis-trigger array of params', () => {
    const option = prepareEChartsOption({ ...zoneRanking, tooltip: { trigger: 'axis' } })
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter
    expect(formatter([{ seriesIndex: 0, marker: '', data: zoneRow }])).toContain('Queens')
  })

  it('escapes markup arriving from warehouse values', () => {
    const option = prepareEChartsOption(zoneRanking)
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter
    const html = formatter({ seriesIndex: 0, marker: '', data: { ...zoneRow, pu_borough: '<img src=x>' } })
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).not.toContain('<img')
  })

  it('falls back to the plotted measure when no tooltip columns are declared', () => {
    const option = prepareEChartsOption({
      xAxis: { type: 'category' },
      yAxis: { type: 'value', name: 'Trips' },
      tooltip: { trigger: 'axis' },
      series: [{ type: 'bar', encode: { x: 'month', y: 'trips' } }],
    })
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter
    const html = formatter({ seriesIndex: 0, marker: '', data: { month: 'January', trips: 3_724_889.4 } })
    expect(html).toContain('January')
    expect(html).toContain('trips: <strong>3,724,889.4</strong>')
  })

  it('never overrides an author-supplied formatter', () => {
    const option = prepareEChartsOption({ ...zoneRanking, tooltip: { trigger: 'item', formatter: 'fixed {b}' } })
    expect((option.tooltip as { formatter: unknown }).formatter).toBe('fixed {b}')
  })
})

describe('axis name room', () => {
  it('reserves the name gap that containLabel ignores', () => {
    const grid = prepareEChartsOption(zoneRanking).grid as Record<string, number | boolean>
    expect(grid.left).toBe(110)
    expect(grid.bottom).toBe(42)
    expect(grid.containLabel).toBe(true)
  })

  it('forces containLabel even when the author omitted the grid', () => {
    const grid = prepareEChartsOption({ series: [{ type: 'bar' }] }).grid as Record<string, unknown>
    expect(grid.containLabel).toBe(true)
  })

  it('leaves a generous author gap alone and respects a right-hand axis', () => {
    const grid = prepareEChartsOption({
      grid: { left: 200, right: 4 },
      yAxis: { name: 'Rate', type: 'value', nameLocation: 'middle', nameGap: 40, position: 'right' },
      series: [{ type: 'line' }],
    }).grid as Record<string, number>
    expect(grid.left).toBe(200)
    expect(grid.right).toBe(54)
  })

  it('ignores an axis name placed at the end, which does not overlap labels', () => {
    const grid = prepareEChartsOption({
      grid: { bottom: 8 },
      xAxis: { name: 'Month', type: 'category', nameLocation: 'end', nameGap: 60 },
      series: [{ type: 'bar' }],
    }).grid as Record<string, number>
    expect(grid.bottom).toBe(8)
  })
})

describe('document palette enforcement', () => {
  it('keeps a reordered or subset document palette', () => {
    const reordered = [HOST_PALETTE[2]!, HOST_PALETTE[0]!]
    expect(withSanctionedPalette({ color: reordered }).color).toEqual(reordered)
  })

  it('drops a palette containing any foreign colour so the host default applies', () => {
    expect(withSanctionedPalette({ color: ['#5b8ff9', '#61d9a8'] })).not.toHaveProperty('color')
    expect(withSanctionedPalette({ color: [HOST_PALETTE[0]!, '#5b8ff9'] })).not.toHaveProperty('color')
    expect(withSanctionedPalette({ color: [] })).not.toHaveProperty('color')
  })

  it('leaves an option without a palette untouched and preserves other keys', () => {
    const option = { series: [{ type: 'bar', itemStyle: { color: '#5b8ff9' } }] }
    expect(withSanctionedPalette(option)).toBe(option)
    expect(withSanctionedPalette({ color: ['#5b8ff9'], series: [] })).toEqual({ series: [] })
  })
})

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
