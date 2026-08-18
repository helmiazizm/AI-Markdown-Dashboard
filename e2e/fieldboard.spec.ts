import { expect, test, type Page } from '@playwright/test'

const artifact = {
  version: 1,
  title: 'Operations Source Pulse',
  summary: 'A source-backed view of record volume and completion across the active governed snapshot.',
  markdown: '# Operations Source Pulse\n\nThe source is concentrated in a few broad segments.\n\n```dashboard\n{"widgetId":"segment-bars"}\n```\n\n## Completion geometry\n\n```dashboard\n{"widgetId":"completion-dots"}\n```',
  datasets: [
    { id: 'categories', question: 'How large is each segment?', sql: 'SELECT segment, count(*) AS record_count FROM fashion.catalog.products GROUP BY segment', expectedColumns: ['segment', 'record_count'], maxRows: 20 },
    { id: 'availability', question: 'What is the completion rate by segment?', sql: 'SELECT segment, avg(completed::int) * 100 AS completion_pct FROM fashion.catalog.products GROUP BY segment', expectedColumns: ['segment', 'completion_pct'], maxRows: 20 },
  ],
  widgets: [
    { id: 'segment-bars', datasetId: 'categories', title: 'Source volume', description: 'Record counts by segment.', height: 320, accessibilityText: 'Bars compare source record counts by segment.', engine: 'echarts', option: { xAxis: { type: 'value' }, yAxis: { type: 'category' }, series: [{ type: 'bar', encode: { x: 'record_count', y: 'segment' } }] } },
    { id: 'completion-dots', datasetId: 'availability', title: 'Completion dots', description: 'A custom dot row for segment completion.', height: 300, accessibilityText: 'Dots show completion percent by segment.', engine: 'd3', script: `const root=d3.select(container);root.selectAll('*').remove();const svg=root.append('svg').attr('width',width).attr('height',height);const x=d3.scaleLinear().domain([0,100]).range([50,width-30]);svg.selectAll('circle').data(data).join('circle').attr('cx',d=>x(d.completion_pct)).attr('cy',(d,i)=>45+i*45).attr('r',8).attr('fill',theme.signal);svg.selectAll('text').data(data).join('text').attr('x',12).attr('y',(d,i)=>49+i*45).attr('fill',theme.text).text(d=>d.segment);` },
  ],
}

const results = [
  { id: 'result-1', datasetId: 'categories', columns: ['segment', 'record_count'], rows: [{ segment: 'Enterprise', record_count: 720000 }, { segment: 'Growth', record_count: 480000 }, { segment: 'Starter', record_count: 170000 }], rowCount: 3, truncated: false, createdAt: '2026-08-16T08:00:00.000Z', summaryObjectPrefix: 'summaries/dashboard=ccf25439-1111-4111-8111-111111111111/dataset=categories/revision=11111111-1111-4111-8111-111111111111/version=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/as_of=2026-03-19', sourceSnapshot: { id: 'snapshot-1', objectPrefix: 'warehouse:catalog@snapshot-1', snapshotDate: '2026-03-19' } },
  { id: 'result-2', datasetId: 'availability', columns: ['segment', 'completion_pct'], rows: [{ segment: 'Enterprise', completion_pct: 84 }, { segment: 'Growth', completion_pct: 72 }, { segment: 'Starter', completion_pct: 65 }], rowCount: 3, truncated: false, createdAt: '2026-08-16T08:00:00.000Z', summaryObjectPrefix: 'summaries/dashboard=ccf25439-1111-4111-8111-111111111111/dataset=availability/revision=11111111-1111-4111-8111-111111111111/version=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/as_of=2026-03-19', sourceSnapshot: { id: 'snapshot-1', objectPrefix: 'warehouse:catalog@snapshot-1', snapshotDate: '2026-03-19' } },
]

const revision = { id: '11111111-1111-4111-8111-111111111111', revisionNumber: 1, prompt: 'Show source volume and completion', createdAt: '2026-08-16T08:00:00.000Z', restoredFromRevisionId: null }

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', postgres: true, warehouse: true, minio: true, minioSnapshot: true, agentMode: 'demo', openRouterConfigured: false, repository: { enabled: true, initialized: true, activated: true, readiness: 'ready', branch: 'main', clean: true, head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', indexedHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', error: null }, relations: [{ qualifiedName: 'fashion.catalog.products', datasetName: 'Fashion product catalog', rowCount: 44424 }, { qualifiedName: 'tlc.taxi.yellow_trips', datasetName: 'NYC TLC yellow taxi trips', rowCount: 11077206 }], activeSnapshot: { snapshotDate: '2026-03-19', rowCount: 11121630, objectPrefix: 'warehouse:catalog@snapshot-1', datasetName: 'Warehouse catalog', relationName: 'catalog' } } }))
  await page.route(/\/api\/repository$/, (route) => route.fulfill({ json: {
    enabled: true, configuredPath: '/content', initialized: true, activated: true, branch: 'main', expectedBranch: 'main',
    head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', indexedHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', clean: false,
    readiness: 'dirty', fingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    changedFiles: [{ path: 'dashboards/operations-pulse--ccf25439/dashboard.md', status: 'M', dashboardPath: 'dashboards/operations-pulse--ccf25439' }],
    affectedDashboards: ['dashboards/operations-pulse--ccf25439'], unindexedCommits: [], blockedPublications: [], lastSuccessfulScan: revision.createdAt,
    error: 'The content worktree has uncommitted changes.', repair: 'Review, validate, and import these changes from the repository sync center.',
  } }))
  await page.route('**/api/repository/diff?*', (route) => route.fulfill({ json: { path: 'dashboards/operations-pulse--ccf25439/dashboard.md', diff: '--- a/dashboard.md\n+++ b/dashboard.md\n@@ -1 +1 @@\n-Old narrative\n+Validated narrative' } }))
  await page.route('**/api/repository/validations', (route) => route.fulfill({ status: 202, json: { id: '22222222-2222-4222-8222-222222222222' } }))
  await page.route('**/api/repository/validations/22222222-2222-4222-8222-222222222222/events', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `id: 1\nevent: inspecting\ndata: {"id":1,"type":"inspecting","message":"Checking changed paths.","createdAt":"2026-08-16T08:00:00.000Z"}\n\nid: 2\nevent: valid\ndata: {"id":2,"type":"valid","message":"All affected bundles are valid.","createdAt":"2026-08-16T08:00:01.000Z"}\n\n`,
  }))
  await page.route('**/api/repository/validations/22222222-2222-4222-8222-222222222222', (route) => route.fulfill({ json: { id: '22222222-2222-4222-8222-222222222222', status: 'valid', expectedHead: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', affectedDashboards: ['dashboards/operations-pulse--ccf25439'], errors: [], expiresAt: '2026-08-16T08:20:00.000Z', createdAt: '2026-08-16T08:00:00.000Z', completedAt: '2026-08-16T08:00:01.000Z', events: [] } }))
  await page.route('**/api/dashboards', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: [{ id: 'dashboard-1', title: artifact.title, summary: artifact.summary, prompt: revision.prompt, currentRevisionId: revision.id, revisionNumber: 1, widgetCount: 2, updatedAt: revision.createdAt }], nextCursor: null } })
    return route.continue()
  })
  await page.route('**/api/dashboards/dashboard-1', (route) => route.fulfill({ json: { id: 'dashboard-1', currentRevisionId: revision.id, revision, artifact, results, revisions: [revision] } }))
  await page.route('**/api/dashboards/dashboard-1/refresh', (route) => route.fulfill({ json: { refreshed: ['categories', 'availability'] } }))
  await page.route('**/api/generations', (route) => route.fulfill({ status: 202, json: { id: 'generation-1' } }))
  await page.route('**/api/generations/generation-1/events', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `id: 1\nevent: queued\ndata: {"id":1,"type":"queued","message":"Prompt received.","createdAt":"2026-08-16T08:00:00.000Z"}\n\nid: 2\nevent: completed\ndata: {"id":2,"type":"completed","message":"Dashboard ready.","createdAt":"2026-08-16T08:00:01.000Z"}\n\n`,
  }))
  await page.route('**/api/generations/generation-1', (route) => route.fulfill({ json: { id: 'generation-1', dashboardId: 'dashboard-1', revisionId: revision.id, status: 'completed', mode: 'create', prompt: 'Show assortment', error: null, createdAt: revision.createdAt, completedAt: revision.createdAt, events: [] } }))
}

test.beforeEach(async ({ page }) => mockApi(page))

test('creates a fieldboard, reviews the trail in a modal, then opens it', async ({ page }) => {
  let requestBody: unknown
  await page.route('**/api/generations', async (route) => {
    requestBody = route.request().postDataJSON()
    await route.fulfill({ status: 202, json: { id: 'generation-1' } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Ask your data/i })).toBeVisible()
  await page.getByRole('textbox', { name: 'What should we investigate?' }).fill('Show assortment and availability')
  await page.getByRole('button', { name: 'Generate fieldboard' }).click()
  // The trail is captured unconditionally now; there is no detail switch to set.
  expect(requestBody).toEqual({ prompt: 'Show assortment and availability', detailLevel: 'detailed' })

  // Completion presents the fieldboard instead of navigating away from the composer.
  await expect(page.getByText('Fieldboard ready')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  await page.getByRole('button', { name: /View analysis trail/ }).click()
  const trail = page.getByRole('dialog', { name: 'Analysis trail' })
  await expect(trail).toBeVisible()
  await expect(trail.getByText('Prompt received.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trail).toBeHidden()

  await page.getByRole('link', { name: /Open dashboard/ }).click()
  await expect(page).toHaveURL(/\/dashboards\/dashboard-1/)
  await expect(page.getByRole('heading', { name: 'Operations Source Pulse' })).toBeVisible()
})

test('renders ECharts, sandboxed D3, inspector SQL, and accessible table', async ({ page }) => {
  await page.goto('/dashboards/dashboard-1')
  await expect(page.locator('canvas')).toBeVisible()
  const frame = page.locator('iframe[sandbox="allow-scripts"]')
  await expect(frame).toBeVisible()
  await expect(frame.contentFrame().locator('svg')).toBeVisible()
  await page.getByRole('button', { name: 'Inspect evidence' }).first().click()
  await expect(page.getByText('DUCKDB SQL', { exact: true })).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()
})

test('supports keyboard focus and a compact mobile layout', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Fieldboard home' })).toBeFocused()
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByText('Local analytical instrument')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Generate fieldboard' })).toBeVisible()
  }
})

test('reviews a bounded repository diff and reaches the validated import gate', async ({ page }) => {
  await page.goto('/repository')
  await expect(page.getByRole('heading', { name: /Repository sync center/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /dashboards\/operations-pulse--ccf25439\/dashboard.md/ })).toBeVisible()
  await expect(page.getByText('+Validated narrative')).toBeVisible()
  await page.getByRole('button', { name: /Validate changes/i }).click()
  await expect(page.getByText('All affected bundles are valid.')).toBeVisible()
  await expect(page.getByLabel('Human change note')).toBeVisible()
})
