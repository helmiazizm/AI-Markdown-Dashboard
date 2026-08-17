import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(skillRoot, 'scripts', 'fieldboard-author.mjs')
const temporaryRoots = []
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'fieldboard-skill-'))
  temporaryRoots.push(root)
  await writeFile(path.join(root, 'package.json'), '{"name":"fieldboard"}\n')
  const content = path.join(root, 'content')
  await mkdir(path.join(content, '.git'), { recursive: true })
  return { root, content }
}

async function mockApi(handler) {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
    const result = await handler({ method: request.method, url: request.url, body })
    response.writeHead(result.status || 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

function runCli(args, { cwd, api, content }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: {
        ...process.env,
        FIELDBOARD_API_URL: api,
        FIELDBOARD_CONTENT_PATH: content,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const head = 'a'.repeat(40)
const fingerprint = 'b'.repeat(64)
const dashboardPath = 'dashboards/source-pulse--11111111'
const snapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  objectPrefix: 'warehouse:catalog@11111111-1111-4111-8111-111111111111',
  snapshotDate: '2026-03-19',
  rowCount: 1_447_795,
  datasetName: 'Operations data',
  relationName: 'catalog',
  profile: {},
}

test('doctor proves a clean aligned repository', async () => {
  const fixture = await fixtureRoot()
  const api = await mockApi(({ url }) => {
    if (url === '/api/health') return { body: { api: true, minio: true, warehouse: true, activeSnapshot: snapshot } }
    if (url === '/api/repository') return { body: { initialized: true, activated: true, readiness: 'ready', clean: true, branch: 'main', head, indexedHead: head } }
    return { status: 404, body: { error: 'missing' } }
  })
  const result = await runCli(['doctor'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).ready, true)
})

test('offline doctor keeps installation usable before content bootstrap', async () => {
  const fixture = await fixtureRoot()
  const missingContent = path.join(fixture.root, 'not-created-yet')
  const result = await runCli(['doctor', '--allow-offline'], {
    cwd: fixture.root,
    api: 'http://127.0.0.1:1',
    content: missingContent,
  })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).offline, true)
})

test('query forwards the bounded request to the governed endpoint', async () => {
  const fixture = await fixtureRoot()
  const input = path.join(fixture.root, 'query.json')
  const request = { question: 'Count source rows', sql: 'SELECT count(*) AS record_count FROM fashion.catalog.products', expectedColumns: ['record_count'], maxRows: 1 }
  await writeFile(input, JSON.stringify(request))
  const api = await mockApi(({ url, body }) => {
    assert.equal(url, '/api/authoring/queries')
    assert.deepEqual(body, request)
    return { body: { columns: ['record_count'], rows: [{ record_count: 42 }], rowCount: 1, truncated: false, sourceSnapshot: snapshot } }
  })
  const result = await runCli(['query', '--input', input], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).rows[0].record_count, 42)
})

test('draft-metadata returns a stable new bundle identity and provisional provenance', async () => {
  const fixture = await fixtureRoot()
  const api = await mockApi(({ url }) => {
    assert.equal(url, '/api/authoring/context')
    return { body: { activeSnapshot: snapshot } }
  })
  const result = await runCli(['draft-metadata', '--title', 'Source Café Pulse', '--note', 'Create the source pulse'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 0)
  const metadata = JSON.parse(result.stdout)
  assert.match(metadata.contentPath, /^dashboards\/source-cafe-pulse--[0-9a-f]{8}$/)
  assert.equal(metadata.provenance.sourceKind, 'manual')
  assert.deepEqual(metadata.provenance.sourceSnapshot, {
    id: snapshot.id,
    objectPrefix: snapshot.objectPrefix,
    snapshotDate: snapshot.snapshotDate,
  })
})

test('validate-import publishes only a valid unchanged single-dashboard fingerprint', async () => {
  const fixture = await fixtureRoot()
  let repositoryReads = 0
  let importNote = ''
  const api = await mockApi(({ method, url, body }) => {
    if (url === '/api/repository' && method === 'GET') {
      repositoryReads += 1
      if (repositoryReads === 1) return { body: {
        head, indexedHead: head, fingerprint, readiness: 'dirty', clean: false,
        affectedDashboards: [dashboardPath], changedFiles: [{ path: `${dashboardPath}/dashboard.md`, status: 'M', dashboardPath }],
      } }
      return { body: { head: 'c'.repeat(40), indexedHead: 'c'.repeat(40), readiness: 'ready', clean: true } }
    }
    if (url === '/api/repository/validations' && method === 'POST') {
      assert.deepEqual(body, { expectedHead: head, fingerprint })
      return { status: 202, body: { id: '22222222-2222-4222-8222-222222222222' } }
    }
    if (url === '/api/repository/validations/22222222-2222-4222-8222-222222222222') {
      return { body: { id: '22222222-2222-4222-8222-222222222222', status: 'valid', errors: [] } }
    }
    if (url === '/api/repository/imports' && method === 'POST') {
      importNote = body.changeNote
      return { status: 201, body: { publicationIds: ['33333333-3333-4333-8333-333333333333'] } }
    }
    if (url === '/api/publications/33333333-3333-4333-8333-333333333333') {
      return { body: {
        id: '33333333-3333-4333-8333-333333333333',
        dashboardId: '11111111-1111-4111-8111-111111111111',
        revisionId: '44444444-4444-4444-8444-444444444444',
        revisionNumber: 2,
        commitSha: 'c'.repeat(40),
        status: 'published',
      } }
    }
    return { status: 404, body: { error: `Unhandled ${method} ${url}` } }
  })
  const result = await runCli(['validate-import', '--dashboard', dashboardPath, '--note', 'Clarify the availability narrative'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(importNote, 'Clarify the availability narrative')
  assert.equal(JSON.parse(result.stdout).publications[0].status, 'published')
})

test('validate-import never imports an invalid candidate', async () => {
  const fixture = await fixtureRoot()
  let imports = 0
  const api = await mockApi(({ method, url }) => {
    if (url === '/api/repository') return { body: {
      head, indexedHead: head, fingerprint, readiness: 'dirty', clean: false,
      affectedDashboards: [dashboardPath], changedFiles: [{ path: `${dashboardPath}/dashboard.md`, status: 'M', dashboardPath }],
    } }
    if (url === '/api/repository/validations' && method === 'POST') return { status: 202, body: { id: '55555555-5555-4555-8555-555555555555' } }
    if (url === '/api/repository/validations/55555555-5555-4555-8555-555555555555') return { body: { status: 'invalid', errors: ['Unknown widget'] } }
    if (url === '/api/repository/imports') imports += 1
    return { status: 500, body: { error: 'unexpected request' } }
  })
  const result = await runCli(['validate-import', '--dashboard', dashboardPath, '--note', 'Revise the dashboard prose'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Unknown widget/)
  assert.equal(imports, 0)
})

test('validate-import rejects unrelated dirty work before validation', async () => {
  const fixture = await fixtureRoot()
  let validations = 0
  const api = await mockApi(({ method, url }) => {
    if (url === '/api/repository') return { body: {
      head, indexedHead: head, fingerprint, readiness: 'dirty', clean: false,
      affectedDashboards: [dashboardPath, 'dashboards/another--22222222'],
      changedFiles: [
        { path: `${dashboardPath}/dashboard.md`, status: 'M', dashboardPath },
        { path: 'dashboards/another--22222222/dashboard.md', status: 'M', dashboardPath: 'dashboards/another--22222222' },
      ],
    } }
    if (url === '/api/repository/validations' && method === 'POST') validations += 1
    return { status: 500, body: { error: 'unexpected request' } }
  })
  const result = await runCli(['validate-import', '--dashboard', dashboardPath, '--note', 'Revise one dashboard only'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /only affected bundle/)
  assert.equal(validations, 0)
})

test('validate-import stops on a stale fingerprint', async () => {
  const fixture = await fixtureRoot()
  let imports = 0
  const api = await mockApi(({ method, url }) => {
    if (url === '/api/repository') return { body: {
      head, indexedHead: head, fingerprint, readiness: 'dirty', clean: false,
      affectedDashboards: [dashboardPath], changedFiles: [{ path: `${dashboardPath}/dashboard.md`, status: 'M', dashboardPath }],
    } }
    if (url === '/api/repository/validations' && method === 'POST') return { status: 409, body: { error: 'Repository fingerprint changed before validation started' } }
    if (url === '/api/repository/imports') imports += 1
    return { status: 500, body: { error: 'unexpected request' } }
  })
  const result = await runCli(['validate-import', '--dashboard', dashboardPath, '--note', 'Revise the dashboard safely'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /fingerprint changed/)
  assert.equal(imports, 0)
})

test('validate-import reports a blocked publication without Git repair', async () => {
  const fixture = await fixtureRoot()
  const api = await mockApi(({ method, url }) => {
    if (url === '/api/repository') return { body: {
      head, indexedHead: head, fingerprint, readiness: 'dirty', clean: false,
      affectedDashboards: [dashboardPath], changedFiles: [{ path: `${dashboardPath}/dashboard.md`, status: 'M', dashboardPath }],
    } }
    if (url === '/api/repository/validations' && method === 'POST') return { status: 202, body: { id: '66666666-6666-4666-8666-666666666666' } }
    if (url === '/api/repository/validations/66666666-6666-4666-8666-666666666666') return { body: { status: 'valid', errors: [] } }
    if (url === '/api/repository/imports' && method === 'POST') return { status: 201, body: { publicationIds: ['77777777-7777-4777-8777-777777777777'] } }
    if (url === '/api/publications/77777777-7777-4777-8777-777777777777') return { body: { id: '77777777-7777-4777-8777-777777777777', status: 'blocked', error: 'Repository HEAD changed' } }
    return { status: 500, body: { error: 'unexpected request' } }
  })
  const result = await runCli(['validate-import', '--dashboard', dashboardPath, '--note', 'Publish the validated dashboard'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Repository HEAD changed/)
})

test('validate-import surfaces an import failure', async () => {
  const fixture = await fixtureRoot()
  const api = await mockApi(({ method, url }) => {
    if (url === '/api/repository') return { body: {
      head, indexedHead: head, fingerprint, readiness: 'dirty', clean: false,
      affectedDashboards: [dashboardPath], changedFiles: [{ path: `${dashboardPath}/dashboard.md`, status: 'M', dashboardPath }],
    } }
    if (url === '/api/repository/validations' && method === 'POST') return { status: 202, body: { id: '88888888-8888-4888-8888-888888888888' } }
    if (url === '/api/repository/validations/88888888-8888-4888-8888-888888888888') return { body: { status: 'valid', errors: [] } }
    if (url === '/api/repository/imports' && method === 'POST') return { status: 500, body: { error: 'Import failed before publication' } }
    return { status: 500, body: { error: 'unexpected request' } }
  })
  const result = await runCli(['validate-import', '--dashboard', dashboardPath, '--note', 'Import the validated dashboard'], { cwd: fixture.root, api, content: fixture.content })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Import failed before publication/)
})

test('runtime helper has no shell or Git execution capability', async () => {
  const source = await readFile(script, 'utf8')
  assert.doesNotMatch(source, /node:child_process|\bexecFile\b|\bspawn\b/)
})
