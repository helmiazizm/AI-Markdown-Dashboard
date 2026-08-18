# Chart authoring

## Choose the renderer

Use ECharts for bars, lines, areas, scatter plots, heatmaps, treemaps, pies, gauges, and ordinary multi-axis charts. Use a readable Markdown table instead of a chart when there are only a few exact values. Use D3 only for custom geometry, layout, or interaction that cannot be expressed clearly with native ECharts.

## ECharts sidecars

Write JSON-only native ECharts options. Fieldboard injects `dataset.source` from the materialized summary table, plus dimensions, palette, typography, background, accessibility, and responsive rendering.

- Use `series[].encode` with SQL output column names.
- Omit rows of your own — `dataset`, `series[].data`, axis `data`, any `source` — along with functions, executable formatters, prototype keys, and external URLs. `legend.data` is allowed, because it names series rather than carrying rows.
- Label the measure axis with its metric and unit. Do not `name` a category axis whose own labels already say what they are — at `nameLocation: middle` that name is drawn rotated across the axis, where it collides with the labels.
- Round every measure to its display precision in SQL. An unrounded `AVG` reaches the tooltip with full floating-point precision.
- Prefer horizontal bars for long category labels and sorted rankings.
- Avoid pies for close comparisons or many categories.
- Keep `encode.tooltip` to at most four columns, with the hovered category first. Every listed column becomes a tooltip row.
- Avoid literal `{c}` label formatters for object-row datasets unless the encoded numeric dimension is unambiguous.

Example:

```json
{
  "grid": { "left": 8, "right": 20, "top": 16, "bottom": 8, "containLabel": true },
  "xAxis": { "type": "value", "name": "Rate (%)" },
  "yAxis": { "type": "category" },
  "tooltip": { "trigger": "axis", "axisPointer": { "type": "shadow" } },
  "series": [
    {
      "type": "bar",
      "encode": {
        "x": "rate_pct",
        "y": "segment",
        "tooltip": ["segment", "rate_pct", "record_count"]
      },
      "barMaxWidth": 28
    }
  ]
}
```

## D3 sidecars

The script receives only `data`, `container`, `width`, `height`, `theme`, `tooltip`, `emit`, `onResize`, and `d3`. Render inside `container` and clear previous content before drawing.

Do not access `document`, `window`, `globalThis`, `parent`, navigation, storage, network APIs, workers, dynamic imports, `eval`, `Function`, timers, script tags, prototype machinery, or external resources. Keep the visualization useful without pointer interaction and supply equivalent accessibility text in the manifest.

## Accessibility and narrative agreement

Write `accessibilityText` as a self-contained description including chart form, compared dimensions, and the main pattern. Do not merely repeat the title. It must fit inside the `limits.widget.accessibilityText` bound that `doctor` reports, which is tighter than a full narration of the chart allows: name the two or three values that carry the pattern instead of walking every series, and check the length of both `accessibilityText` and `description` before validating. Ensure the Markdown claim, description, axes, tooltips, and query output all use the same metric definition and unit.
