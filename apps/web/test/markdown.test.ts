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
})
