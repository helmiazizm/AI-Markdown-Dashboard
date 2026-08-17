import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const enabled = process.env.RUN_FIELDBOARD_SKILL_SMOKE === '1'
const execute = promisify(execFile)
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = path.resolve(skillRoot, '../../..')
const helper = path.join(skillRoot, 'scripts', 'fieldboard-author.mjs')

async function command(args, environment) {
  const { stdout } = await execute(process.execPath, [helper, ...args], {
    cwd: appRoot,
    env: { ...process.env, ...environment },
    maxBuffer: 4_000_000,
  })
  return JSON.parse(stdout)
}

test('authors, validates, and imports a live fixture without OpenRouter', { skip: !enabled }, async () => {
  const contentRoot = path.resolve(process.env.FIELDBOARD_CONTENT_PATH || path.join(appRoot, 'fieldboard_content'))
  const environment = {
    FIELDBOARD_API_URL: process.env.FIELDBOARD_API_URL || 'http://localhost:3000',
    FIELDBOARD_CONTENT_PATH: contentRoot,
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'fieldboard-skill-smoke-'))
  let bundlePath
  let published = false
  try {
    const doctor = await command(['doctor'], environment)
    assert.equal(doctor.ready, true)
    const requestPath = path.join(temporary, 'query.json')
    const sql = `SELECT relation, record_count FROM (
  SELECT 'fashion.catalog.products' AS relation, count(*) AS record_count FROM fashion.catalog.products
  UNION ALL
  SELECT 'tlc.taxi.yellow_trips' AS relation, count(*) AS record_count FROM tlc.taxi.yellow_trips
) catalog_counts`
    await writeFile(requestPath, `${JSON.stringify({
      question: 'How many rows are present in the active warehouse source?',
      sql,
      expectedColumns: ['relation', 'record_count'],
      maxRows: 8,
    }, null, 2)}\n`)
    const result = await command(['query', '--input', requestPath], environment)
    assert.equal(result.columns.join(','), 'relation,record_count')

    const note = 'Run the governed authoring skill live smoke test'
    const metadata = await command(['draft-metadata', '--title', 'Fieldboard Authoring Skill Smoke', '--note', note], environment)
    bundlePath = path.join(contentRoot, metadata.contentPath)
    await mkdir(path.join(bundlePath, 'queries'), { recursive: true })
    await mkdir(path.join(bundlePath, 'widgets'), { recursive: true })
    await writeFile(path.join(bundlePath, 'dashboard.md'), `# Fieldboard Authoring Skill Smoke

This fixture proves that a Claude Code skill can query whichever governed source is active, author a Markdown-first bundle, validate every final query, and publish through Fieldboard without OpenRouter.

\`\`\`dashboard
{"widgetId":"source-volume"}
\`\`\`

The chart deliberately makes no domain-specific assumptions: it reports the active snapshot's row volume and labels it as a row count rather than a unique-entity count.
`)
    await writeFile(path.join(bundlePath, 'fieldboard.json'), `${JSON.stringify({
      schemaVersion: 1,
      dashboardId: metadata.dashboardId,
      title: 'Fieldboard Authoring Skill Smoke',
      summary: 'An opt-in fixture proving the governed Markdown authoring and automatic publication path without OpenRouter.',
      datasets: [{
        id: 'source-volume',
        question: 'How many rows are present in the active warehouse source?',
        sqlFile: 'queries/source-volume.sql',
        expectedColumns: ['relation', 'record_count'],
        maxRows: 8,
      }],
      widgets: [{
        id: 'source-volume',
        datasetId: 'source-volume',
        engine: 'echarts',
        title: 'Active source volume',
        description: 'A governed, schema-independent row count for each registered warehouse relation.',
        height: 420,
        accessibilityText: 'A bar chart shows the row count of each registered warehouse relation.',
        sourceFile: 'widgets/source-volume.echarts.json',
      }],
    }, null, 2)}\n`)
    await writeFile(path.join(bundlePath, 'provenance.json'), `${JSON.stringify(metadata.provenance, null, 2)}\n`)
    await writeFile(path.join(bundlePath, 'queries/source-volume.sql'), `${sql}\n`)
    await writeFile(path.join(bundlePath, 'widgets/source-volume.echarts.json'), `${JSON.stringify({
      grid: { left: 8, right: 20, top: 16, bottom: 8, containLabel: true },
      xAxis: { type: 'value', name: 'Rows' },
      yAxis: { type: 'category' },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      series: [{ type: 'bar', encode: { x: 'record_count', y: 'relation', tooltip: ['relation', 'record_count'] }, barMaxWidth: 72 }],
    }, null, 2)}\n`)

    const imported = await command(['validate-import', '--dashboard', metadata.contentPath, '--note', note], environment)
    assert.equal(imported.publications.length, 1)
    assert.equal(imported.publications[0].status, 'published')
    assert.match(imported.publications[0].commitSha, /^[0-9a-f]{40,64}$/)
    published = true
  } finally {
    await rm(temporary, { recursive: true, force: true })
    if (!published && bundlePath) await rm(bundlePath, { recursive: true, force: true })
  }
})
