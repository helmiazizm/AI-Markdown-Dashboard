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
  const runtime = JSON.parse(JSON.stringify(option)) as Record<string, unknown>
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
