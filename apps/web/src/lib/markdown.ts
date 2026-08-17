import DOMPurify from 'dompurify'
import { marked } from 'marked'

export type DashboardDocumentSegment =
  | { type: 'html'; html: string }
  | { type: 'widget'; widgetId: string }

export function renderDashboardMarkdown(markdown: string): DashboardDocumentSegment[] {
  const segments: DashboardDocumentSegment[] = []
  const fence = /```dashboard\s*\r?\n([\s\S]*?)\r?\n```/g
  let cursor = 0
  for (const match of markdown.matchAll(fence)) {
    const index = match.index ?? 0
    if (index > cursor) segments.push({ type: 'html', html: sanitize(markdown.slice(cursor, index)) })
    try {
      const parsed = JSON.parse(match[1] ?? '') as { widgetId?: unknown }
      if (typeof parsed.widgetId === 'string') segments.push({ type: 'widget', widgetId: parsed.widgetId })
    } catch {
      // Server validation prevents invalid references. Omit malformed local content defensively.
    }
    cursor = index + match[0].length
  }
  if (cursor < markdown.length) segments.push({ type: 'html', html: sanitize(markdown.slice(cursor)) })
  return segments
}

function sanitize(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'style'],
    FORBID_ATTR: ['style', 'srcdoc'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  })
}
