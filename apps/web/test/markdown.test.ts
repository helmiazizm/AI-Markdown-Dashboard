import { describe, expect, it } from 'vitest'
import { renderDashboardMarkdown } from '../src/lib/markdown.js'

describe('dashboard markdown renderer', () => {
  it('extracts deterministic widget mount points', () => {
    const result = renderDashboardMarkdown('# Brief\n\n```dashboard\n{"widgetId":"chart-one"}\n```')
    expect(result).toEqual([
      expect.objectContaining({ type: 'html' }),
      { type: 'widget', widgetId: 'chart-one' },
    ])
  })

  it('sanitizes raw executable HTML', () => {
    const result = renderDashboardMarkdown('# Safe\n<script>alert(1)</script>')
    expect(JSON.stringify(result)).not.toContain('<script')
  })

  it('groups adjacent half-span widgets into one row', () => {
    const result = renderDashboardMarkdown(
      '```dashboard\n{"widgetId":"left","span":"half"}\n```\n```dashboard\n{"widgetId":"right","span":"half"}\n```',
    )
    expect(result).toEqual([{
      type: 'widget-row',
      widgets: [{ widgetId: 'left', span: 'half' }, { widgetId: 'right', span: 'half' }],
    }])
  })

  it('starts a new row after two halves', () => {
    const fence = (id: string) => `\`\`\`dashboard\n{"widgetId":"${id}","span":"half"}\n\`\`\``
    const result = renderDashboardMarkdown([fence('a'), fence('b'), fence('c'), fence('d')].join('\n'))
    expect(result).toEqual([
      { type: 'widget-row', widgets: [{ widgetId: 'a', span: 'half' }, { widgetId: 'b', span: 'half' }] },
      { type: 'widget-row', widgets: [{ widgetId: 'c', span: 'half' }, { widgetId: 'd', span: 'half' }] },
    ])
  })

  it('breaks a row when prose separates two halves', () => {
    const result = renderDashboardMarkdown(
      '```dashboard\n{"widgetId":"left","span":"half"}\n```\n\nSome prose.\n\n```dashboard\n{"widgetId":"right","span":"half"}\n```',
    )
    expect(result.map((segment) => segment.type)).toEqual(['widget', 'html', 'widget'])
  })

  it('renders a partnerless half at full width', () => {
    const result = renderDashboardMarkdown('```dashboard\n{"widgetId":"lonely","span":"half"}\n```')
    expect(result).toEqual([{ type: 'widget', widgetId: 'lonely' }])
  })

  it('omits malformed placements without dropping surrounding prose', () => {
    const result = renderDashboardMarkdown('Intro.\n\n```dashboard\n{"widgetId":"x","spann":"half"}\n```\n\nOutro.')
    expect(result.map((segment) => segment.type)).toEqual(['html', 'html'])
  })
})
