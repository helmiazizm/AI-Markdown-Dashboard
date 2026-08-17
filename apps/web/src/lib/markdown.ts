import { scanWidgetPlacements, type WidgetSpan } from '@fieldboard/contracts'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

export interface WidgetPlacementSegment {
  widgetId: string
  span: WidgetSpan
}

export type DashboardDocumentSegment =
  | { type: 'html'; html: string }
  | { type: 'widget'; widgetId: string }
  | { type: 'widget-row'; widgets: WidgetPlacementSegment[] }

const WIDGETS_PER_ROW = 2

export function renderDashboardMarkdown(markdown: string): DashboardDocumentSegment[] {
  const segments: DashboardDocumentSegment[] = []
  const fence = /```dashboard\s*\r?\n([\s\S]*?)\r?\n```/g
  // Spans come from the shared contract scanner so the renderer and server agree on placement.
  const placements = scanWidgetPlacements(markdown).placements
  let placementIndex = 0
  let cursor = 0
  for (const match of markdown.matchAll(fence)) {
    const index = match.index ?? 0
    // Whitespace-only gaps carry no prose, so they must not split a row of adjacent halves.
    const between = markdown.slice(cursor, index)
    if (between.trim()) segments.push({ type: 'html', html: sanitize(between) })
    const placement = placements[placementIndex]
    placementIndex += 1
    // Server validation rejects malformed references. Omit them defensively here.
    if (placement) {
      segments.push(placement.span === 'half'
        ? { type: 'widget-row', widgets: [placement] }
        : { type: 'widget', widgetId: placement.widgetId })
    }
    cursor = index + match[0].length
  }
  const trailing = markdown.slice(cursor)
  if (trailing.trim()) segments.push({ type: 'html', html: sanitize(trailing) })
  return groupWidgetRows(segments)
}

/**
 * Collapses runs of adjacent half-span widgets into shared rows. Prose between two halves
 * breaks the run, and a half left without a partner renders full width.
 */
function groupWidgetRows(segments: DashboardDocumentSegment[]): DashboardDocumentSegment[] {
  const grouped: DashboardDocumentSegment[] = []
  for (const segment of segments) {
    const previous = grouped[grouped.length - 1]
    if (
      segment.type === 'widget-row'
      && previous?.type === 'widget-row'
      && previous.widgets.length < WIDGETS_PER_ROW
    ) {
      previous.widgets.push(...segment.widgets)
      continue
    }
    grouped.push(segment.type === 'widget-row' ? { type: 'widget-row', widgets: [...segment.widgets] } : segment)
  }
  return grouped.map((segment) => segment.type === 'widget-row' && segment.widgets.length === 1
    ? { type: 'widget', widgetId: segment.widgets[0]!.widgetId }
    : segment)
}

function sanitize(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'style'],
    FORBID_ATTR: ['style', 'srcdoc'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  })
}
