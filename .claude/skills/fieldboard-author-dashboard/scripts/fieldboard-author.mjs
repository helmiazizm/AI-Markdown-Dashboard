#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DEFAULT_API_URL = 'http://localhost:3000'
const DEFAULT_WEB_URL = 'http://localhost:5173'
const DASHBOARD_PATH = /^dashboards\/[a-z0-9][a-z0-9-]{0,63}--[0-9a-f]{8}$/

function parseOptions(values) {
  const options = new Map()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`)
    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) options.set(key, true)
    else {
      options.set(key, next)
      index += 1
    }
  }
  return options
}

function requiredOption(options, key) {
  const value = options.get(key)
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`)
  return value.trim()
}

function assertNote(note) {
  if (note.length < 5 || note.length > 240) throw new Error('The change note must contain 5-240 characters')
}

function apiUrl() {
  return (process.env.FIELDBOARD_API_URL || DEFAULT_API_URL).replace(/\/$/, '')
}

function webUrl() {
  return (process.env.FIELDBOARD_WEB_URL || DEFAULT_WEB_URL).replace(/\/$/, '')
}

async function request(route, init = {}) {
  const response = await fetch(`${apiUrl()}${route}`, {
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Fieldboard returned HTTP ${response.status}`)
  return body
}

async function findAppRoot(start = process.cwd()) {
  let candidate = path.resolve(start)
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'))
      if (manifest.name === 'fieldboard') return candidate
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(candidate)
    if (parent === candidate) return path.resolve(start)
    candidate = parent
  }
}

function unquote(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

async function configuredContentPath() {
  const appRoot = await findAppRoot()
  let configured = process.env.FIELDBOARD_CONTENT_PATH
  if (!configured) {
    try {
      const envText = await readFile(path.join(appRoot, '.env'), 'utf8')
      const match = envText.match(/^FIELDBOARD_CONTENT_PATH=(.*)$/m)
      if (match) configured = unquote(match[1])
    } catch {
      // Use the documented in-project default.
    }
  }
  return path.resolve(appRoot, configured || './fieldboard_content')
}

const CONTRACTS_ENTRY = 'packages/contracts/dist/index.js'
const CONTRACTS_BUILD_HINT = 'Run `npm run build -w @fieldboard/contracts` and rerun doctor to report the enforced field bounds'

// Unwraps modifiers such as .default() and .optional() to reach the schema carrying the checks.
function schemaCore(schema) {
  let node = schema
  while (node?.def?.innerType) node = node.def.innerType
  return node
}

// Renders the inclusive bounds Zod will enforce. The contract uses only .min()/.max(),
// so exclusive .gt()/.lt() checks are deliberately ignored rather than reported off by one.
function schemaBounds(schema) {
  const checks = schemaCore(schema)?.def?.checks || []
  let min
  let max
  for (const check of checks) {
    const def = check?._zod?.def
    if (!def) continue
    if (def.check === 'min_length') min = def.minimum
    else if (def.check === 'max_length') max = def.maximum
    else if (def.check === 'greater_than' && def.inclusive) min = def.value
    else if (def.check === 'less_than' && def.inclusive) max = def.value
  }
  if (min === undefined && max === undefined) return null
  return `${min ?? 'any'}-${max ?? 'any'}`
}

function boundedFields(shape, keys) {
  const limits = {}
  for (const key of keys) {
    const bounds = shape?.[key] ? schemaBounds(shape[key]) : null
    if (bounds) limits[key] = bounds
  }
  return limits
}

// Reads the bounds from the compiled contract the API resolves @fieldboard/contracts to,
// so the reported numbers are the ones validation will actually enforce.
async function contractLimits() {
  const appRoot = await findAppRoot()
  try {
    const contracts = await import(pathToFileURL(path.join(appRoot, CONTRACTS_ENTRY)).href)
    const limits = {
      units: 'strings and markdown in characters, datasets/widgets/expectedColumns in items, height in pixels',
      dashboard: boundedFields(contracts.dashboardArtifactSchema.shape, ['title', 'summary', 'markdown', 'datasets', 'widgets']),
      dataset: boundedFields(contracts.datasetSpecSchema.shape, ['question', 'sql', 'expectedColumns', 'maxRows']),
      widget: boundedFields(contracts.echartsWidgetSchema.shape, ['title', 'description', 'accessibilityText', 'height']),
      d3Widget: boundedFields(contracts.d3WidgetSchema.shape, ['script']),
    }
    if (!Object.keys(limits.widget).length) throw new Error('The compiled contract exposed no widget bounds')
    return limits
  } catch (error) {
    return { unavailable: error instanceof Error ? `${error.message}. ${CONTRACTS_BUILD_HINT}` : CONTRACTS_BUILD_HINT }
  }
}

async function doctor(options) {
  const allowOffline = options.has('allow-offline')
  const contentPath = await configuredContentPath()
  const limits = await contractLimits()
  try {
    await access(path.join(contentPath, '.git'))
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required')
    const [health, repository] = await Promise.all([request('/api/health'), request('/api/repository')])
    const ready = Boolean(
      health.api
      && (health.minio === true || health.minioSnapshot === true)
      && health.warehouse
      && health.activeSnapshot
      && repository.initialized
      && repository.activated
      && repository.readiness === 'ready'
      && repository.clean
      && repository.head
      && repository.head === repository.indexedHead,
    )
    if (!ready) throw new Error(repository.error || 'Fieldboard authoring is not ready and aligned')
    return {
      ready,
      apiUrl: apiUrl(),
      contentPath,
      repository: {
        branch: repository.branch,
        head: repository.head,
        indexedHead: repository.indexedHead,
        readiness: repository.readiness,
      },
      limits,
    }
  } catch (error) {
    if (!allowOffline) throw error
    return {
      ready: false,
      offline: true,
      apiUrl: apiUrl(),
      contentPath,
      warning: error instanceof Error ? error.message : String(error),
      limits,
    }
  }
}

async function context() {
  return request('/api/authoring/context')
}

async function query(options) {
  const inputPath = path.resolve(requiredOption(options, 'input'))
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  return request('/api/authoring/queries', { method: 'POST', body: JSON.stringify(input) })
}

function dashboardSlug(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'dashboard'
}

async function draftMetadata(options) {
  const title = requiredOption(options, 'title')
  const note = requiredOption(options, 'note')
  if (title.length < 3 || title.length > 120) throw new Error('The dashboard title must contain 3-120 characters')
  assertNote(note)
  const source = await context()
  const dashboardId = randomUUID()
  const revisionId = randomUUID()
  const generatedAt = new Date().toISOString()
  return {
    dashboardId,
    revisionId,
    contentPath: `dashboards/${dashboardSlug(title)}--${dashboardId.slice(0, 8)}`,
    generatedAt,
    provenance: {
      schemaVersion: 1,
      revisionId,
      revisionNumber: 1,
      parentRevisionId: null,
      restoredFromRevisionId: null,
      sourceKind: 'manual',
      note,
      model: 'claude-code/fieldboard-author-dashboard',
      runId: null,
      generatedAt,
      publicationCommit: '$GIT_COMMIT',
      sourceSnapshot: {
        id: source.activeSnapshot.id,
        objectPrefix: source.activeSnapshot.objectPrefix,
        snapshotDate: source.activeSnapshot.snapshotDate,
      },
    },
  }
}

async function pollValidation(id) {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const validation = await request(`/api/repository/validations/${id}`)
    if (['valid', 'invalid', 'imported', 'expired'].includes(validation.status)) return validation
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  throw new Error('Repository validation did not finish within 10 minutes')
}

async function pollPublication(id) {
  const deadline = Date.now() + 2 * 60_000
  while (Date.now() < deadline) {
    const publication = await request(`/api/publications/${id}`)
    if (['published', 'blocked', 'failed'].includes(publication.status)) return publication
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Publication ${id} did not finish within 2 minutes`)
}

async function validateImport(options) {
  const dashboard = requiredOption(options, 'dashboard')
  const note = requiredOption(options, 'note')
  if (!DASHBOARD_PATH.test(dashboard)) throw new Error('The dashboard path is not a valid stable Fieldboard content path')
  assertNote(note)
  const repository = await request('/api/repository')
  if (!repository.head || !repository.fingerprint || !['dirty', 'unindexed'].includes(repository.readiness)) {
    throw new Error(repository.error || 'The repository does not contain importable changes')
  }
  if (repository.affectedDashboards.length !== 1 || repository.affectedDashboards[0] !== dashboard) {
    throw new Error('Exactly the declared dashboard must be the only affected bundle')
  }
  const unrelated = repository.changedFiles.filter((file) => file.dashboardPath !== dashboard)
  if (unrelated.length) throw new Error(`Unsupported changes exist outside the dashboard: ${unrelated.map((file) => file.path).join(', ')}`)
  const deletions = repository.changedFiles.filter((file) => String(file.status).includes('D'))
  if (deletions.length) throw new Error(`Dashboard deletion or renaming is not supported: ${deletions.map((file) => file.path).join(', ')}`)

  const started = await request('/api/repository/validations', {
    method: 'POST',
    body: JSON.stringify({ expectedHead: repository.head, fingerprint: repository.fingerprint }),
  })
  const validation = await pollValidation(started.id)
  if (validation.status !== 'valid') {
    throw new Error(`Validation ${validation.status}: ${(validation.errors || []).join('; ') || 'See validation events for details'}`)
  }
  const imported = await request('/api/repository/imports', {
    method: 'POST',
    body: JSON.stringify({ validationId: validation.id, changeNote: note }),
  })
  const publications = await Promise.all((imported.publicationIds || []).map(pollPublication))
  if (!publications.length) throw new Error('Fieldboard did not return a publication')
  const unsuccessful = publications.filter((publication) => publication.status !== 'published')
  if (unsuccessful.length) {
    throw new Error(`Publication blocked: ${unsuccessful.map((publication) => publication.error || publication.id).join('; ')}`)
  }
  const finalRepository = await request('/api/repository')
  if (!finalRepository.clean || finalRepository.readiness !== 'ready' || finalRepository.head !== finalRepository.indexedHead) {
    throw new Error('Publication completed but the repository is not clean and aligned')
  }
  return {
    validationId: validation.id,
    publications: publications.map((publication) => ({
      id: publication.id,
      dashboardId: publication.dashboardId,
      revisionId: publication.revisionId,
      revisionNumber: publication.revisionNumber,
      commitSha: publication.commitSha,
      status: publication.status,
      dashboardUrl: `${webUrl()}/dashboards/${publication.dashboardId}`,
    })),
    repository: {
      head: finalRepository.head,
      indexedHead: finalRepository.indexedHead,
      readiness: finalRepository.readiness,
    },
  }
}

function help() {
  return {
    commands: [
      'doctor [--allow-offline]',
      'context',
      'query --input <json-file>',
      'draft-metadata --title <title> --note <note>',
      'validate-import --dashboard <content-path> --note <note>',
    ],
  }
}

async function main() {
  const command = process.argv[2] || 'help'
  const options = parseOptions(process.argv.slice(3))
  let result
  if (command === 'doctor') result = await doctor(options)
  else if (command === 'context') result = await context()
  else if (command === 'query') result = await query(options)
  else if (command === 'draft-metadata') result = await draftMetadata(options)
  else if (command === 'validate-import') result = await validateImport(options)
  else if (command === 'help' || command === '--help') result = help()
  else throw new Error(`Unknown command: ${command}`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  process.exitCode = 1
})
