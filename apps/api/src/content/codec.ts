import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  fieldboardManifestSchema,
  fieldboardProvenanceSchema,
  validateDashboardArtifact,
  type DashboardArtifactV1,
  type FieldboardManifestV1,
  type FieldboardProvenanceV1,
} from '@fieldboard/contracts'
import { normalizeReadonlySql } from '../data/query-guard.js'

const MAX_BUNDLE_BYTES = 512_000
const DASHBOARD_PATH = /^dashboards\/[a-z0-9][a-z0-9-]{0,63}--([0-9a-f]{8})$/
const SAFE_ID = /^[a-z][a-z0-9_-]{1,63}$/

export interface BundleMetadata {
  dashboardId: string
  contentPath: string
  revisionId: string
  revisionNumber: number
  parentRevisionId: string | null
  restoredFromRevisionId: string | null
  sourceKind: FieldboardProvenanceV1['sourceKind']
  note: string
  model: string
  runId: string | null
  generatedAt: string
  sourceSnapshot: FieldboardProvenanceV1['sourceSnapshot']
}

export interface SerializedBundle {
  files: Map<string, string>
  artifact: DashboardArtifactV1
  manifest: FieldboardManifestV1
  provenance: FieldboardProvenanceV1
  artifactHash: string
}

export interface LoadedBundle extends Omit<SerializedBundle, 'files'> {
  contentPath: string
}

function lineText(value: string): string {
  return `${value.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n`
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  )
}

export function artifactSha256(artifact: DashboardArtifactV1): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(artifact))).digest('hex')
}

export function canonicalizeDashboardArtifact(artifactInput: DashboardArtifactV1): DashboardArtifactV1 {
  return validateDashboardArtifact({
    ...artifactInput,
    markdown: lineText(artifactInput.markdown),
    datasets: artifactInput.datasets.map((dataset) => ({
      ...dataset,
      sql: lineText(normalizeReadonlySql(dataset.sql)),
    })),
    widgets: artifactInput.widgets.map((widget) => widget.engine === 'd3'
      ? { ...widget, script: lineText(widget.script) }
      : widget),
  })
}

export function dashboardContentPath(title: string, dashboardId: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'dashboard'
  return `dashboards/${slug}--${dashboardId.slice(0, 8).toLowerCase()}`
}

export function assertDashboardContentPath(contentPath: string, dashboardId?: string): void {
  const match = DASHBOARD_PATH.exec(contentPath)
  if (!match || path.posix.normalize(contentPath) !== contentPath || contentPath.includes('..')) {
    throw new Error(`Invalid dashboard content path: ${contentPath}`)
  }
  if (dashboardId && match[1] !== dashboardId.slice(0, 8).toLowerCase()) {
    throw new Error('Dashboard path does not match dashboardId')
  }
}

export function serializeBundle(artifactInput: DashboardArtifactV1, metadata: BundleMetadata): SerializedBundle {
  assertDashboardContentPath(metadata.contentPath, metadata.dashboardId)
  const artifact = canonicalizeDashboardArtifact(artifactInput)
  const manifest: FieldboardManifestV1 = fieldboardManifestSchema.parse({
    schemaVersion: 1,
    dashboardId: metadata.dashboardId,
    title: artifact.title,
    summary: artifact.summary,
    datasets: artifact.datasets.map((dataset) => ({
      id: dataset.id,
      question: dataset.question,
      sqlFile: `queries/${dataset.id}.sql`,
      expectedColumns: dataset.expectedColumns,
      maxRows: dataset.maxRows,
    })),
    widgets: artifact.widgets.map((widget) => ({
      id: widget.id,
      datasetId: widget.datasetId,
      engine: widget.engine,
      title: widget.title,
      description: widget.description,
      height: widget.height,
      accessibilityText: widget.accessibilityText,
      sourceFile: widget.engine === 'echarts'
        ? `widgets/${widget.id}.echarts.json`
        : `widgets/${widget.id}.d3.js`,
    })),
  })
  const provenance = fieldboardProvenanceSchema.parse({
    schemaVersion: 1,
    revisionId: metadata.revisionId,
    revisionNumber: metadata.revisionNumber,
    parentRevisionId: metadata.parentRevisionId,
    restoredFromRevisionId: metadata.restoredFromRevisionId,
    sourceKind: metadata.sourceKind,
    note: metadata.note,
    model: metadata.model,
    runId: metadata.runId,
    generatedAt: metadata.generatedAt,
    publicationCommit: '$GIT_COMMIT',
    sourceSnapshot: metadata.sourceSnapshot,
  })
  const files = new Map<string, string>([
    ['fieldboard.json', jsonText(manifest)],
    ['dashboard.md', artifact.markdown],
    ['provenance.json', jsonText(provenance)],
  ])
  for (const dataset of artifact.datasets) files.set(`queries/${dataset.id}.sql`, dataset.sql)
  for (const widget of artifact.widgets) {
    files.set(
      widget.engine === 'echarts' ? `widgets/${widget.id}.echarts.json` : `widgets/${widget.id}.d3.js`,
      widget.engine === 'echarts' ? jsonText(widget.option) : widget.script,
    )
  }
  return { files, artifact, manifest, provenance, artifactHash: artifactSha256(artifact) }
}

function safeSidecarPath(relativePath: string): void {
  if (path.posix.normalize(relativePath) !== relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
    throw new Error(`Unsafe bundle sidecar path: ${relativePath}`)
  }
}

async function listBundleFiles(bundlePath: string): Promise<string[]> {
  const output: string[] = []
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      safeSidecarPath(relative)
      const absolute = path.join(directory, entry.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in bundles: ${relative}`)
      if (stat.isDirectory()) await visit(absolute, relative)
      else if (stat.isFile()) output.push(relative)
      else throw new Error(`Unsupported bundle entry: ${relative}`)
    }
  }
  await visit(bundlePath)
  return output.sort()
}

async function boundedText(bundlePath: string, relativePath: string, budget: { bytes: number }): Promise<string> {
  safeSidecarPath(relativePath)
  const absolute = path.resolve(bundlePath, relativePath)
  if (!absolute.startsWith(`${path.resolve(bundlePath)}${path.sep}`)) throw new Error('Bundle path escaped its dashboard directory')
  const stat = await lstat(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Bundle sidecar is not a regular file: ${relativePath}`)
  budget.bytes += stat.size
  if (budget.bytes > MAX_BUNDLE_BYTES) throw new Error('Dashboard bundle exceeds 512 KB')
  const bytes = await readFile(absolute)
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`Invalid UTF-8 in ${relativePath}`)
  }
  if (value.includes('\u0000')) throw new Error(`Invalid UTF-8 in ${relativePath}`)
  if (/\r/.test(value)) throw new Error(`${relativePath} must use LF line endings`)
  if (!value.endsWith('\n')) throw new Error(`${relativePath} must end with a newline`)
  return value
}

export async function loadBundle(repositoryRoot: string, contentPath: string): Promise<LoadedBundle> {
  assertDashboardContentPath(contentPath)
  const root = await realpath(repositoryRoot)
  const requestedPath = path.join(root, contentPath)
  const requestedStat = await lstat(requestedPath)
  if (requestedStat.isSymbolicLink()) throw new Error('Dashboard bundle directories may not be symlinks')
  const bundlePath = await realpath(requestedPath)
  if (!bundlePath.startsWith(`${root}${path.sep}`)) throw new Error('Dashboard bundle resolves outside the content repository')
  const files = await listBundleFiles(bundlePath)
  const budget = { bytes: 0 }
  const manifest = fieldboardManifestSchema.parse(JSON.parse(await boundedText(bundlePath, 'fieldboard.json', budget)))
  assertDashboardContentPath(contentPath, manifest.dashboardId)
  const provenance = fieldboardProvenanceSchema.parse(JSON.parse(await boundedText(bundlePath, 'provenance.json', budget)))
  const markdown = await boundedText(bundlePath, 'dashboard.md', budget)
  const expected = new Set(['dashboard.md', 'fieldboard.json', 'provenance.json'])
  const datasets = []
  for (const dataset of manifest.datasets) {
    if (!SAFE_ID.test(dataset.id) || dataset.sqlFile !== `queries/${dataset.id}.sql`) throw new Error(`Dataset sidecar does not match id: ${dataset.id}`)
    expected.add(dataset.sqlFile)
    const sql = await boundedText(bundlePath, dataset.sqlFile, budget)
    normalizeReadonlySql(sql)
    datasets.push({ id: dataset.id, question: dataset.question, sql, expectedColumns: dataset.expectedColumns, maxRows: dataset.maxRows })
  }
  const widgets = []
  for (const widget of manifest.widgets) {
    const expectedFile = widget.engine === 'echarts'
      ? `widgets/${widget.id}.echarts.json`
      : `widgets/${widget.id}.d3.js`
    if (!SAFE_ID.test(widget.id) || widget.sourceFile !== expectedFile) throw new Error(`Widget sidecar does not match id: ${widget.id}`)
    expected.add(widget.sourceFile)
    const source = await boundedText(bundlePath, widget.sourceFile, budget)
    widgets.push(widget.engine === 'echarts'
      ? { ...widget, option: JSON.parse(source), sourceFile: undefined }
      : { ...widget, script: source, sourceFile: undefined })
  }
  const unknown = files.filter((file) => !expected.has(file))
  const missing = [...expected].filter((file) => !files.includes(file))
  if (unknown.length) throw new Error(`Unsupported bundle files: ${unknown.join(', ')}`)
  if (missing.length) throw new Error(`Missing bundle files: ${missing.join(', ')}`)
  const artifact = validateDashboardArtifact({
    version: 1,
    title: manifest.title,
    summary: manifest.summary,
    markdown,
    datasets,
    widgets: widgets.map(({ sourceFile: _sourceFile, ...widget }) => widget),
  })
  return { contentPath, artifact, manifest, provenance, artifactHash: artifactSha256(artifact) }
}

export async function writeBundleAtomically(repositoryRoot: string, bundle: SerializedBundle, contentPath: string, journalId: string): Promise<void> {
  assertDashboardContentPath(contentPath, bundle.manifest.dashboardId)
  const stagingRoot = path.join(repositoryRoot, '.fieldboard-tmp', journalId)
  const nextPath = path.join(stagingRoot, 'next')
  const previousPath = path.join(stagingRoot, 'previous')
  await rm(stagingRoot, { recursive: true, force: true })
  for (const [relative, value] of bundle.files) {
    safeSidecarPath(relative)
    const target = path.join(nextPath, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, value, { encoding: 'utf8', flag: 'wx' })
  }
  const targetPath = path.join(repositoryRoot, contentPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  try {
    await rename(targetPath, previousPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rename(nextPath, targetPath)
  await rm(stagingRoot, { recursive: true, force: true })
}
