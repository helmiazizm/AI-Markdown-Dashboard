import { z } from 'zod'

export const identifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)

export const datasetSpecSchema = z.object({
  id: identifierSchema,
  question: z.string().min(4).max(240),
  sql: z.string().min(8).max(12_000),
  expectedColumns: z.array(identifierSchema).min(1).max(30),
  maxRows: z.number().int().min(1).max(500).default(500),
})

const widgetBaseSchema = z.object({
  id: identifierSchema,
  datasetId: identifierSchema,
  title: z.string().min(2).max(120),
  description: z.string().min(4).max(320),
  height: z.number().int().min(240).max(760).default(420),
  accessibilityText: z.string().min(8).max(500),
})

export const echartsWidgetSchema = widgetBaseSchema.extend({
  engine: z.literal('echarts'),
  option: z.record(z.string(), z.unknown()),
})

export const d3WidgetSchema = widgetBaseSchema.extend({
  engine: z.literal('d3'),
  script: z.string().min(12).max(20_000),
})

export const widgetSpecSchema = z.discriminatedUnion('engine', [
  echartsWidgetSchema,
  d3WidgetSchema,
])

export const dashboardArtifactSchema = z.object({
  version: z.literal(1),
  title: z.string().min(3).max(120),
  summary: z.string().min(8).max(600),
  markdown: z.string().min(10).max(32_000),
  datasets: z.array(datasetSpecSchema).min(1).max(8),
  widgets: z.array(widgetSpecSchema).min(1).max(8),
})

export type DatasetSpec = z.infer<typeof datasetSpecSchema>
export type EChartsWidgetSpec = z.infer<typeof echartsWidgetSchema>
export type D3WidgetSpec = z.infer<typeof d3WidgetSchema>
export type WidgetSpec = z.infer<typeof widgetSpecSchema>
export type DashboardArtifactV1 = z.infer<typeof dashboardArtifactSchema>

export const authoringQueryRequestSchema = datasetSpecSchema.omit({ id: true })

export type AuthoringQueryRequest = z.infer<typeof authoringQueryRequestSchema>

export interface WarehouseRelationContext {
  qualifiedName: string
  project: string
  schemaName: string
  tableName: string
  datasetName: string
  grain: string
  snapshotColumn: string | null
  rowCount: number
  columns: string[]
  cautions: string[]
  exampleValues: Record<string, unknown>[]
}

export interface AuthoringSourceContext {
  relations: WarehouseRelationContext[]
  activeSnapshot: {
    id: string
    objectPrefix: string
    snapshotDate: string
    rowCount: number
    datasetName: string
    relationName: string
    profile: Record<string, unknown>
  }
}

export interface AuthoringQueryResponse {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  sourceSnapshot: AuthoringSourceContext['activeSnapshot']
}

export interface QueryResultSnapshot {
  id: string
  datasetId: string
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  createdAt: string
  summaryObjectPrefix?: string | null
  sourceSnapshot: {
    id: string
    objectPrefix: string
    snapshotDate: string
  }
}

export type GenerationEventType =
  | 'queued'
  | 'inspecting'
  | 'querying'
  | 'composing'
  | 'validating'
  | 'publishing'
  | 'publication_blocked'
  | 'completed'
  | 'failed'

export type GenerationDetailLevel = 'standard' | 'detailed'

export interface GenerationEvent {
  id: number
  type: GenerationEventType
  message: string
  createdAt: string
  payload?: Record<string, unknown>
}

export interface DashboardListItem {
  id: string
  title: string
  summary: string
  prompt: string
  currentRevisionId: string
  revisionNumber: number
  widgetCount: number
  updatedAt: string
  contentPath: string | null
  gitCommitSha: string | null
}

export type RevisionPublicationStatus = 'pending' | 'published' | 'blocked' | 'failed'
export type RevisionSourceKind = 'agent' | 'manual' | 'restore' | 'legacy' | 'bootstrap'

export interface DashboardRevisionSummary {
  id: string
  revisionNumber: number
  prompt: string
  createdAt: string
  restoredFromRevisionId: string | null
  publicationStatus: RevisionPublicationStatus
  sourceKind: RevisionSourceKind
  gitCommitSha: string | null
  gitSourceCommitSha: string | null
  artifactHash: string | null
  publicationError: string | null
}

export interface DashboardDetail {
  id: string
  currentRevisionId: string
  revision: DashboardRevisionSummary
  artifact: DashboardArtifactV1
  results: QueryResultSnapshot[]
  revisions: DashboardRevisionSummary[]
  contentPath: string | null
}

export interface GenerationStatus {
  id: string
  dashboardId: string | null
  revisionId: string | null
  status: 'queued' | 'running' | 'publishing' | 'publication_blocked' | 'completed' | 'failed'
  mode: 'create' | 'refine'
  detailLevel: GenerationDetailLevel
  prompt: string
  error: string | null
  createdAt: string
  completedAt: string | null
  publicationId: string | null
}

export type RepositoryReadiness =
  | 'disabled'
  | 'uninitialized'
  | 'ready'
  | 'dirty'
  | 'unindexed'
  | 'wrong_branch'
  | 'detached'
  | 'diverged'
  | 'unavailable'
  | 'blocked'

export interface RepositoryFileChange {
  path: string
  status: string
  dashboardPath: string | null
}

export interface RepositoryStatus {
  enabled: boolean
  configuredPath: string
  initialized: boolean
  activated: boolean
  branch: string | null
  expectedBranch: string
  head: string | null
  indexedHead: string | null
  clean: boolean
  readiness: RepositoryReadiness
  fingerprint: string | null
  changedFiles: RepositoryFileChange[]
  affectedDashboards: string[]
  unindexedCommits: Array<{ sha: string; subject: string }>
  blockedPublications: ContentPublicationSummary[]
  lastSuccessfulScan: string | null
  error: string | null
  repair: string | null
}

export type ContentPublicationStatus = 'prepared' | 'publishing' | 'committed' | 'published' | 'blocked' | 'failed'

export interface ContentPublicationSummary {
  id: string
  dashboardId: string
  revisionId: string
  revisionNumber: number
  runId: string | null
  status: ContentPublicationStatus
  expectedHead: string | null
  commitSha: string | null
  attemptCount: number
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface ContentLifecycleEvent {
  id: number
  type: string
  message: string
  payload?: Record<string, unknown>
  createdAt: string
}

export type ContentValidationStatus = 'queued' | 'running' | 'valid' | 'invalid' | 'imported' | 'expired'

export interface ContentValidationRun {
  id: string
  status: ContentValidationStatus
  expectedHead: string | null
  fingerprint: string
  affectedDashboards: string[]
  errors: string[]
  expiresAt: string | null
  createdAt: string
  completedAt: string | null
}

export interface HealthResponse {
  status: 'ok' | 'degraded'
  api: true
  postgres: boolean
  warehouse: boolean
  minio: boolean
  minioSnapshot: boolean
  agentMode: 'demo' | 'cline'
  openRouterConfigured: boolean
  repository: {
    enabled: boolean
    initialized: boolean
    activated: boolean
    readiness: RepositoryReadiness
    branch: string | null
    clean: boolean
    head: string | null
    indexedHead: string | null
    error: string | null
  }
  relations?: Array<{
    qualifiedName: string
    datasetName: string
    rowCount: number
    snapshotDate?: string
  }>
  activeSnapshot?: {
    snapshotDate: string
    rowCount: number
    objectPrefix: string
    datasetName: string
    relationName: string
  }
}

export const contentManifestDatasetSchema = z.object({
  id: identifierSchema,
  question: z.string().min(4).max(240),
  sqlFile: z.string().regex(/^queries\/[a-z][a-z0-9_-]{1,63}\.sql$/),
  expectedColumns: z.array(identifierSchema).min(1).max(30),
  maxRows: z.number().int().min(1).max(500),
})

export const contentManifestWidgetSchema = widgetBaseSchema.extend({
  engine: z.enum(['echarts', 'd3']),
  sourceFile: z.string().regex(/^widgets\/[a-z][a-z0-9_-]{1,63}\.(?:echarts\.json|d3\.js)$/),
})

export const fieldboardManifestSchema = z.object({
  schemaVersion: z.literal(1),
  dashboardId: z.string().uuid(),
  title: z.string().min(3).max(120),
  summary: z.string().min(8).max(600),
  datasets: z.array(contentManifestDatasetSchema).min(1).max(8),
  widgets: z.array(contentManifestWidgetSchema).min(1).max(8),
})

export type FieldboardManifestV1 = z.infer<typeof fieldboardManifestSchema>

export const fieldboardProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  parentRevisionId: z.string().uuid().nullable(),
  restoredFromRevisionId: z.string().uuid().nullable(),
  sourceKind: z.enum(['agent', 'manual', 'restore', 'legacy', 'bootstrap']),
  note: z.string().min(1).max(4_000),
  model: z.string().min(1).max(240),
  runId: z.string().uuid().nullable(),
  generatedAt: z.string().datetime(),
  publicationCommit: z.union([z.literal('$GIT_COMMIT'), z.string().regex(/^[0-9a-f]{40,64}$/)]),
  sourceSnapshot: z.object({
    id: z.string().uuid(),
    objectPrefix: z.string().min(1).max(1_024),
    snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).nullable(),
})

export type FieldboardProvenanceV1 = z.infer<typeof fieldboardProvenanceSchema>

export function extractWidgetReferences(markdown: string): string[] {
  const references: string[] = []
  const fence = /```dashboard\s*\n([\s\S]*?)\n```/g
  for (const match of markdown.matchAll(fence)) {
    try {
      const value = JSON.parse(match[1] ?? '') as { widgetId?: unknown }
      if (typeof value.widgetId === 'string') references.push(value.widgetId)
    } catch {
      references.push('__invalid__')
    }
  }
  return references
}

const unsafeOptionKeys = new Set(['__proto__', 'prototype', 'constructor'])
const externalUrl = /(?:https?:|javascript:|data:text\/html)/i

function validateOption(value: unknown, path: string, issues: string[]): void {
  if (typeof value === 'string' && externalUrl.test(value)) {
    issues.push(`${path} contains an external or executable URL`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateOption(item, `${path}[${index}]`, issues))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (unsafeOptionKeys.has(key)) issues.push(`${path}.${key} is not allowed`)
    if (key === 'data' || key === 'source') issues.push(`${path}.${key} must be supplied by the host dataset`)
    validateOption(child, `${path}.${key}`, issues)
  }
}

const unsafeD3Tokens = [
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\b/i,
  /\bEventSource\b/i,
  /\b(?:Worker|SharedWorker|BroadcastChannel|MessageChannel)\b/i,
  /\b(?:localStorage|sessionStorage|indexedDB)\b/i,
  /\b(?:document|window|globalThis|location|navigator|history|parent|top|opener|frames)\b/i,
  /\b(?:ownerDocument|defaultView|postMessage|__proto__|prototype|constructor)\b/i,
  /\b(?:eval|Function|setInterval|setTimeout|queueMicrotask)\s*\(/i,
  /\bimport\s*\(/i,
  /<\/?script/i,
]

export function validateDashboardArtifact(input: unknown): DashboardArtifactV1 {
  const artifact = dashboardArtifactSchema.parse(input)
  const issues: string[] = []
  const datasetIds = new Set<string>()
  const widgetIds = new Set<string>()

  for (const dataset of artifact.datasets) {
    if (datasetIds.has(dataset.id)) issues.push(`Duplicate dataset id: ${dataset.id}`)
    datasetIds.add(dataset.id)
  }

  for (const widget of artifact.widgets) {
    if (widgetIds.has(widget.id)) issues.push(`Duplicate widget id: ${widget.id}`)
    widgetIds.add(widget.id)
    if (!datasetIds.has(widget.datasetId)) issues.push(`Widget ${widget.id} references an unknown dataset`)
    if (widget.engine === 'echarts') validateOption(widget.option, `widget.${widget.id}.option`, issues)
    if (widget.engine === 'd3') {
      for (const pattern of unsafeD3Tokens) {
        if (pattern.test(widget.script)) issues.push(`Widget ${widget.id} uses a blocked D3 capability`)
      }
    }
  }

  if (/<\/?(?:script|iframe|object|embed)|\son[a-z]+\s*=/i.test(artifact.markdown)) {
    issues.push('Markdown contains executable HTML')
  }

  const references = extractWidgetReferences(artifact.markdown)
  if (references.length === 0) issues.push('Markdown must contain at least one dashboard fence')
  for (const reference of references) {
    if (!widgetIds.has(reference)) issues.push(`Markdown references an unknown widget: ${reference}`)
  }
  for (const widgetId of widgetIds) {
    if (!references.includes(widgetId)) issues.push(`Widget ${widgetId} is not referenced by Markdown`)
  }

  if (issues.length > 0) throw new Error(issues.join('; '))
  return artifact
}
