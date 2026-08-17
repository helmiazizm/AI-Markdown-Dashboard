import type { DashboardArtifactV1 } from '@fieldboard/contracts'

function catalogVolumeSql(relations: readonly string[]): string {
  if (!relations.length) throw new Error('Demo artifact requires at least one warehouse relation')
  const unions = relations.map((relation) => `  SELECT '${relation.replaceAll("'", "''")}' AS relation, count(*) AS value FROM ${relation}`)
  return `SELECT relation, value FROM (
${unions.join('\n  UNION ALL\n')}
) catalog_counts
ORDER BY relation`
}

export function createDemoArtifact(
  prompt: string,
  revision = 1,
  relations: readonly string[] = ['fashion.catalog.products', 'tlc.taxi.yellow_trips'],
): DashboardArtifactV1 {
  const refinement = revision > 1 ? ` This revision responds to: “${prompt.slice(0, 140)}”.` : ''
  return {
    version: 1,
    title: 'Warehouse Catalog Overview',
    summary: `A catalog-level check of the governed DuckDB relations and their row volumes.${refinement}`,
    markdown: `# Warehouse Catalog Overview

This deterministic demonstration verifies that Fieldboard can query registered project.schema.table relations without assuming a single appointed grain table.

## Relation volume

\`\`\`dashboard
{"widgetId":"catalog-volume"}
\`\`\`

### Reading notes

- These counts reflect rows in each governed relation, not necessarily unique business entities.
- Use the catalog context to establish grain, units, identifiers, and time semantics before making business claims.
- Use the widget inspector for the exact warehouse query and snapshot provenance.`,
    datasets: [{
      id: 'catalog-volume',
      question: 'How many rows are present in each governed warehouse relation?',
      sql: catalogVolumeSql(relations),
      expectedColumns: ['relation', 'value'],
      maxRows: 8,
    }],
    widgets: [{
      id: 'catalog-volume',
      datasetId: 'catalog-volume',
      title: 'Rows in governed relations',
      description: 'Row counts for each registered project.schema.table relation in the warehouse catalog.',
      height: 320,
      accessibilityText: 'Bars showing the total number of rows in each governed warehouse relation.',
      engine: 'echarts',
      option: {
        grid: { left: 12, right: 24, top: 24, bottom: 12, containLabel: true },
        xAxis: { type: 'category' },
        yAxis: { type: 'value', name: 'Rows' },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        series: [{ type: 'bar', encode: { x: 'relation', y: 'value', tooltip: ['relation', 'value'] }, barMaxWidth: 72 }],
      },
    }],
  }
}
