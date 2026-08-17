# Fieldboard bundle contract

## Directory shape

Author exactly one stable dashboard directory:

```text
dashboards/<initial-slug>--<first-eight-dashboard-uuid-chars>/
  dashboard.md
  fieldboard.json
  provenance.json
  queries/<dataset-id>.sql
  widgets/<widget-id>.echarts.json
  widgets/<widget-id>.d3.js
```

Use UTF-8, LF line endings, and final newlines. Keep the complete bundle below 512 KB. Do not add notes, temporary files, symlinks, nested metadata, Parquet summaries, or unknown file types. IDs must match `^[a-z][a-z0-9_-]{1,63}$`. Keep 1-8 datasets and 1-8 widgets. Summary Parquet is stored by Fieldboard in object storage and is not part of the Git bundle.

## Markdown

Keep `dashboard.md` readable without a renderer. Do not put YAML frontmatter, SQL, chart options, scripts, raw executable HTML, or cached rows in it. Place a widget with exactly:

````markdown
```dashboard
{"widgetId":"availability-by-category"}
```
````

Reference every declared widget exactly once and no undeclared widgets. Use answer-first prose and put qualifications next to the claim they constrain.

## Manifest

Write deterministic two-space JSON with this shape:

```json
{
  "schemaVersion": 1,
  "dashboardId": "UUID",
  "title": "Dashboard title",
  "summary": "Answer-first summary of the decision-relevant result",
  "datasets": [
    {
      "id": "availability-by-category",
      "question": "The analytical question this dataset answers",
      "sqlFile": "queries/availability-by-category.sql",
      "expectedColumns": ["category", "available_pct"],
      "maxRows": 20
    }
  ],
  "widgets": [
    {
      "id": "availability-by-category",
      "datasetId": "availability-by-category",
      "engine": "echarts",
      "title": "Availability by category",
      "description": "Plain-language chart purpose and interpretation.",
      "height": 420,
      "accessibilityText": "A standalone description of what the chart shows.",
      "sourceFile": "widgets/availability-by-category.echarts.json"
    }
  ]
}
```

Dataset filenames must equal `queries/<dataset-id>.sql`. Widget filenames must equal `widgets/<widget-id>.echarts.json` or `widgets/<widget-id>.d3.js`. Expected columns must exactly name the columns required by the widget.

Every string, array, and numeric field is bounded, and validation rejects the entire bundle when one field overruns. `doctor` reports the enforced bounds as `limits`, read from the same compiled contract the API validates against, so treat those numbers as authoritative rather than any figure copied into prose. Check the field lengths before running `validate-import`; `accessibilityText` is the field that overruns most easily, because it must stay self-contained while remaining the shortest of the descriptive fields.

## Provenance

Never edit `provenance.json` for an existing dashboard. Fieldboard replaces it during successful manual import.

For a new dashboard, use the entire provenance object returned by `draft-metadata`. It is provisional loader input; Fieldboard replaces its revision identity, note, timestamp, model, and publication metadata when importing.

## Revision rules

- Preserve the stable directory even when the title changes.
- Preserve `dashboardId` across all revisions.
- Do not rename or delete dashboard directories.
- Delete sidecars only when removing their manifest entries and Markdown references in the same change.
- Never edit more than one dashboard before validation and import completes.
