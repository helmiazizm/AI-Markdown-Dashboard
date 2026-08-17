export const HOST_PALETTE = ['#f5a300', '#f3eee3', '#8f6c2c', '#777166', '#cfc5b1']
export const HOST_TEXT_STYLE = { color: '#969083', fontFamily: 'Sometype Mono, monospace' }

const PALETTE_MEMBERS = new Set(HOST_PALETTE)

/**
 * An author may reorder or subset the document palette, which is how one series is emphasised
 * over another. A colour from outside it is dropped, because a stray charting-library default
 * clashes with every other chart on the page. Per-series itemStyle and lineStyle stay open for
 * the cases where a specific hue genuinely carries analytical meaning.
 */
export function withSanctionedPalette(option: Record<string, unknown>): Record<string, unknown> {
  const color = option.color
  if (color === undefined) return option
  const sanctioned = Array.isArray(color)
    && color.length > 0
    && color.every((entry) => typeof entry === 'string' && PALETTE_MEMBERS.has(entry.toLowerCase()))
  if (sanctioned) return option
  const { color: _unsanctioned, ...rest } = option
  return rest
}

/**
 * Tooltip values arrive straight from DuckDB, so an unrounded average shows all 15 digits.
 * Integers keep thousands separators; fractions get enough precision to stay meaningful without
 * printing float noise.
 */
export function formatTooltipValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—'
    if (Number.isInteger(value)) return new Intl.NumberFormat('en-US').format(value)
    const digits = Math.abs(value) >= 1 ? 2 : 4
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)
  }
  if (typeof value === 'object') return ''
  return String(value)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char
  ))
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function axisList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => plainObject(entry) ? [plainObject(entry)!] : [])
  const single = plainObject(value)
  return single ? [single] : []
}

function categoryDimension(option: Record<string, unknown>, series: Record<string, unknown>): string | undefined {
  const encode = plainObject(series.encode)
  if (!encode) return undefined
  if (axisList(option.xAxis).some((axis) => axis.type === 'category')) return firstDimension(encode.x)
  if (axisList(option.yAxis).some((axis) => axis.type === 'category')) return firstDimension(encode.y)
  return firstDimension(encode.itemName)
}

function tooltipDimensions(series: Record<string, unknown>): string[] {
  const encode = plainObject(series.encode)
  const declared = encode?.tooltip
  if (Array.isArray(declared)) return declared.filter((entry): entry is string => typeof entry === 'string')
  if (typeof declared === 'string') return [declared]
  return []
}

function rowOf(params: { data?: unknown; value?: unknown }): Record<string, unknown> | undefined {
  return plainObject(params.data) ?? plainObject(params.value)
}

/**
 * Artifact options are JSON, so an author can never supply a formatter function. Without one,
 * ECharts labels a tooltip with the row index and prints every encoded dimension raw and
 * unnamed. This installs a default formatter that titles the tooltip with the category value and
 * lists each dimension as a named, formatted row. An author-supplied formatter is left alone.
 */
function withDefaultTooltip(option: Record<string, unknown>): Record<string, unknown> {
  const tooltip = plainObject(option.tooltip)
  if (!tooltip || tooltip.formatter !== undefined) return option
  const seriesList = (Array.isArray(option.series) ? option.series : option.series ? [option.series] : [])
    .flatMap((entry) => plainObject(entry) ? [plainObject(entry)!] : [])
  if (seriesList.length === 0) return option
  const specs = seriesList.map((series) => {
    const declared = tooltipDimensions(series)
    // With no declared tooltip columns, fall back to the plotted measure so its value is still
    // formatted rather than printed at full float precision.
    const measure = valueDimension(option, series)
    return {
      category: categoryDimension(option, series),
      dimensions: declared.length > 0 ? declared : measure ? [measure] : [],
      name: typeof series.name === 'string' ? series.name : undefined,
    }
  })
  if (specs.every((spec) => spec.dimensions.length === 0)) return option

  option.tooltip = {
    ...tooltip,
    formatter: (received: unknown) => {
      const list = (Array.isArray(received) ? received : [received]) as {
        seriesIndex?: number
        marker?: string
        name?: unknown
        data?: unknown
        value?: unknown
      }[]
      if (list.length === 0) return ''
      const lead = list[0]!
      const leadSpec = specs[lead.seriesIndex ?? 0] ?? specs[0]!
      const leadRow = rowOf(lead)
      const heading = leadSpec.category && leadRow
        ? formatTooltipValue(leadRow[leadSpec.category])
        : typeof lead.name === 'string' ? lead.name : ''
      const lines: string[] = []
      for (const params of list) {
        const spec = specs[params.seriesIndex ?? 0] ?? leadSpec
        const row = rowOf(params)
        const marker = typeof params.marker === 'string' ? params.marker : ''
        const shown = spec.dimensions.filter((dimension) => dimension !== spec.category)
        if (shown.length === 0) {
          lines.push(`${marker} ${escapeHtml(formatTooltipValue(params.value))}`)
          continue
        }
        shown.forEach((dimension, index) => {
          const label = escapeHtml(dimension)
          const cell = escapeHtml(formatTooltipValue(row?.[dimension]))
          lines.push(`${index === 0 ? marker : '<span style="display:inline-block;width:10px"></span>'} ${label}: <strong>${cell}</strong>`)
        })
      }
      const title = heading ? `<div style="margin-bottom:4px"><strong>${escapeHtml(heading)}</strong></div>` : ''
      return `${title}${lines.join('<br/>')}`
    },
  }
  return option
}

/**
 * `containLabel` reserves room for tick labels but ignores an axis `name`, so a name placed at
 * the middle of an axis is drawn outside the grid and overlaps or clips. Reserve its gap on the
 * side the axis sits on.
 */
function withAxisRoom(option: Record<string, unknown>): Record<string, unknown> {
  const grid = { ...(plainObject(option.grid) ?? {}) }
  grid.containLabel = true
  for (const [axes, primary] of [[option.xAxis, 'bottom'], [option.yAxis, 'left']] as [unknown, 'bottom' | 'left'][]) {
    for (const axis of axisList(axes)) {
      if (typeof axis.name !== 'string' || axis.name.length === 0) continue
      const location = axis.nameLocation
      if (location !== undefined && location !== 'middle' && location !== 'center') continue
      const gap = typeof axis.nameGap === 'number' && Number.isFinite(axis.nameGap) ? axis.nameGap : 15
      const side = primary === 'bottom'
        ? (axis.position === 'top' ? 'top' : 'bottom')
        : (axis.position === 'right' ? 'right' : 'left')
      const current = grid[side]
      if (current !== undefined && typeof current !== 'number') continue
      grid[side] = Math.max(typeof current === 'number' ? current : 0, gap + 14)
    }
  }
  option.grid = grid
  return option
}

function firstDimension(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string')
  return undefined
}

function valueDimension(option: Record<string, unknown>, series: Record<string, unknown>): string | undefined {
  if (!series.encode || typeof series.encode !== 'object' || Array.isArray(series.encode)) return undefined
  const encode = series.encode as Record<string, unknown>
  const xAxis = option.xAxis && typeof option.xAxis === 'object' && !Array.isArray(option.xAxis)
    ? option.xAxis as Record<string, unknown>
    : undefined
  const yAxis = option.yAxis && typeof option.yAxis === 'object' && !Array.isArray(option.yAxis)
    ? option.yAxis as Record<string, unknown>
    : undefined
  if (xAxis?.type === 'value') return firstDimension(encode.x)
  if (yAxis?.type === 'value') return firstDimension(encode.y)
  return firstDimension(encode.value) ?? firstDimension(encode.y) ?? firstDimension(encode.x)
}

function formatScalar(value: unknown): string {
  if (typeof value === 'number') return new Intl.NumberFormat('en-US').format(value)
  if (value === null || value === undefined || typeof value === 'object') return ''
  return String(value)
}

export function prepareEChartsOption(option: Record<string, unknown>): Record<string, unknown> {
  // Artifact options are validated as JSON-only; a JSON clone also unwraps Vue's reactive proxy.
  const runtime = withDefaultTooltip(withAxisRoom(JSON.parse(JSON.stringify(option)) as Record<string, unknown>))
  const series = Array.isArray(runtime.series) ? runtime.series : runtime.series ? [runtime.series] : []
  for (const candidate of series) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const item = candidate as Record<string, unknown>
    if (!item.label || typeof item.label !== 'object' || Array.isArray(item.label)) continue
    const label = item.label as Record<string, unknown>
    if (typeof label.formatter !== 'string' || !label.formatter.includes('{c}')) continue
    const dimension = valueDimension(runtime, item)
    label.formatter = (params: {
      data?: unknown
      value?: unknown
      dimensionNames?: unknown
    }) => {
      const row = params.data ?? params.value
      if (dimension && row && typeof row === 'object' && !Array.isArray(row)) {
        return formatScalar((row as Record<string, unknown>)[dimension])
      }
      if (dimension && Array.isArray(row) && Array.isArray(params.dimensionNames)) {
        const index = params.dimensionNames.indexOf(dimension)
        if (index >= 0) return formatScalar(row[index])
      }
      return formatScalar(row)
    }
  }
  return runtime
}
