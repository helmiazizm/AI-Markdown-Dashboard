import { cors } from 'hono/cors'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { streamSSE } from 'hono/streaming'
import { authoringQueryRequestSchema } from '@fieldboard/contracts'
import { z } from 'zod'
import { queueGeneration } from './agent/generation-service.js'
import { getConfig } from './config.js'
import { getGovernedSourceContext } from './data/source-context.js'
import { normalizeReadonlySql } from './data/query-guard.js'
import { executeDatasetQuery, getActiveSnapshot } from './data/query-service.js'
import { boundedDiff } from './content/git-repository.js'
import {
  getRepositoryStatus,
  publishPreparedRevision,
  retryBlockedPublication,
} from './content/publication-service.js'
import { restorePublishedRevision } from './content/restore-service.js'
import { importValidatedRepositoryChanges, startRepositoryValidation } from './content/repository-sync-service.js'
import {
  getPublication,
  getValidationRun,
  listPublicationEvents,
  listValidationEvents,
} from './content/persistence.js'
import { pool } from './db/pool.js'
import { pingWarehouse } from './data/warehouse.js'
import { listWarehouseRelations } from './data/warehouse-relations.js'
import {
  appendQueryResult,
  getDashboardDetail,
  getGenerationRun,
  listDashboards,
  listGenerationEvents,
  listRevisions,
} from './db/repository.js'

const promptSchema = z.object({
  prompt: z.string().trim().min(5).max(4_000),
  detailLevel: z.enum(['standard', 'detailed']).default('standard'),
})
const refineSchema = promptSchema.extend({ baseRevisionId: z.string().uuid() })
const refreshSchema = z.object({ datasetIds: z.array(z.string()).max(8).optional() })
const repositoryValidationSchema = z.object({
  expectedHead: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})
const repositoryImportSchema = z.object({
  validationId: z.string().uuid(),
  changeNote: z.string().trim().min(5).max(240),
})

export function createApp(): Hono {
  const app = new Hono()
  app.use('*', logger())
  app.use('/api/*', cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))

  app.get('/api/health', async (c) => {
    const config = getConfig()
    let postgres = false
    let warehouse = false
    let minio = false
    let snapshot: Awaited<ReturnType<typeof getActiveSnapshot>> = null
    let relations: Array<{ qualifiedName: string; datasetName: string; rowCount: number; snapshotDate?: string }> = []
    let repository: Awaited<ReturnType<typeof getRepositoryStatus>> | null = null
    try {
      await pool.query('SELECT 1')
      postgres = true
      snapshot = await getActiveSnapshot()
      const registered = await listWarehouseRelations()
      const profileRelations = Array.isArray(snapshot?.profile.relations) ? snapshot.profile.relations as Array<Record<string, unknown>> : []
      relations = registered.map((relation) => {
        const profile = profileRelations.find((item) => item.qualifiedName === relation.qualifiedName)
        return {
          qualifiedName: relation.qualifiedName,
          datasetName: relation.datasetName,
          rowCount: typeof profile?.rowCount === 'number' ? profile.rowCount : 0,
          snapshotDate: typeof profile?.snapshotDate === 'string' ? profile.snapshotDate : snapshot?.snapshotDate,
        }
      })
    } catch {
      // Health stays available while infrastructure is still starting.
    }
    try {
      warehouse = await pingWarehouse()
    } catch {
      warehouse = false
    }
    try {
      const protocol = config.MINIO_USE_SSL ? 'https' : 'http'
      const response = await fetch(`${protocol}://${config.MINIO_ENDPOINT}/minio/health/live`, {
        signal: AbortSignal.timeout(1_500),
      })
      minio = response.ok
    } catch {
      // Report the individual dependency instead of failing the health route.
    }
    try {
      repository = await getRepositoryStatus()
    } catch {
      // Published projections remain readable even when canonical authoring is unavailable.
    }
    return c.json({
      status: postgres && warehouse && minio && snapshot && repository?.readiness === 'ready' ? 'ok' : 'degraded',
      api: true,
      postgres,
      warehouse,
      minio,
      minioSnapshot: minio,
      agentMode: config.AGENT_MODE,
      openRouterConfigured: Boolean(config.OPENROUTER_API_KEY),
      repository: repository ? {
        enabled: repository.enabled,
        initialized: repository.initialized,
        activated: repository.activated,
        readiness: repository.readiness,
        branch: repository.branch,
        clean: repository.clean,
        head: repository.head,
        indexedHead: repository.indexedHead,
        error: repository.error,
      } : {
        enabled: config.CONTENT_REPOSITORY_ENABLED,
        initialized: false,
        activated: false,
        readiness: 'unavailable',
        branch: null,
        clean: false,
        head: null,
        indexedHead: null,
        error: 'Repository status is unavailable.',
      },
      ...(relations.length ? { relations } : {}),
      ...(snapshot ? {
        activeSnapshot: {
          snapshotDate: snapshot.snapshotDate,
          rowCount: snapshot.rowCount,
          objectPrefix: snapshot.objectPrefix,
          datasetName: snapshot.datasetName,
          relationName: snapshot.relationName,
        },
      } : {}),
    })
  })

  app.get('/api/authoring/context', async (c) => {
    try {
      return c.json(await getGovernedSourceContext())
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 503)
    }
  })

  app.post('/api/authoring/queries', async (c) => {
    const body = authoringQueryRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'question, one read-only SQL statement, expectedColumns, and maxRows are required.' }, 400)
    }
    try {
      const result = await executeDatasetQuery({
        id: 'authoring-query',
        ...body.data,
        sql: normalizeReadonlySql(body.data.sql),
      })
      return c.json({
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        sourceSnapshot: result.snapshot,
      })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.post('/api/generations', async (c) => {
    const body = promptSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'A prompt between 5 and 4,000 characters is required.' }, 400)
    try {
      const id = await queueGeneration({ prompt: body.data.prompt, detailLevel: body.data.detailLevel })
      return c.json({ id }, 202)
    } catch (error) {
      if (error instanceof Error && error.name === 'RepositoryPreflightError') return c.json({ error: error.message, repository: '/repository' }, 409)
      throw error
    }
  })

  app.get('/api/generations/:id', async (c) => {
    const run = await getGenerationRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Generation not found.' }, 404)
    const events = await listGenerationEvents(run.id)
    return c.json({ ...run, events })
  })

  app.get('/api/generations/:id/events', async (c) => {
    const run = await getGenerationRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Generation not found.' }, 404)
    const lastEventId = c.req.header('Last-Event-ID')
    const headerId = lastEventId ? Number.parseInt(lastEventId, 10) : Number.NaN
    const queryId = Number.parseInt(c.req.query('after') ?? '0', 10)
    let cursor = Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0
    return streamSSE(c, async (stream) => {
      for (;;) {
        const events = await listGenerationEvents(run.id, cursor)
        for (const event of events) {
          cursor = event.id
          await stream.writeSSE({ event: event.type, id: String(event.id), data: JSON.stringify(event) })
        }
        const current = await getGenerationRun(run.id)
        if (!current || current.status === 'completed' || current.status === 'failed' || current.status === 'publication_blocked') break
        await stream.sleep(700)
      }
    })
  })

  app.get('/api/dashboards', async (c) => {
    const cursor = c.req.query('cursor')
    const result = await listDashboards(cursor)
    return c.json(result)
  })

  app.get('/api/dashboards/:id', async (c) => {
    const detail = await getDashboardDetail(c.req.param('id'), c.req.query('revision'))
    return detail ? c.json(detail) : c.json({ error: 'Dashboard or revision not found.' }, 404)
  })

  app.post('/api/dashboards/:id/refinements', async (c) => {
    const body = refineSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Prompt and baseRevisionId are required.' }, 400)
    try {
      const id = await queueGeneration({
        prompt: body.data.prompt,
        detailLevel: body.data.detailLevel,
        dashboardId: c.req.param('id'),
        baseRevisionId: body.data.baseRevisionId,
      })
      return c.json({ id }, 202)
    } catch (error) {
      if (error instanceof Error && error.name === 'StaleRevisionError') return c.json({ error: error.message }, 409)
      if (error instanceof Error && error.name === 'RepositoryPreflightError') return c.json({ error: error.message, repository: '/repository' }, 409)
      if (error instanceof Error && error.message === 'Dashboard not found') return c.json({ error: error.message }, 404)
      throw error
    }
  })

  app.get('/api/dashboards/:id/revisions', async (c) => {
    return c.json({ items: await listRevisions(c.req.param('id')) })
  })

  app.post('/api/dashboards/:id/revisions/:revisionId/restore', async (c) => {
    try {
      const restored = await restorePublishedRevision(c.req.param('id'), c.req.param('revisionId'))
      return c.json(restored, restored.status === 'published' ? 201 : 202)
    } catch (error) {
      if (error instanceof Error && error.message === 'Dashboard revision not found') {
        return c.json({ error: error.message }, 404)
      }
      if (error instanceof Error && (error.name === 'RepositoryPreflightError' || error.name === 'StaleRevisionError')) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  app.get('/api/repository', async (c) => c.json(await getRepositoryStatus()))

  app.get('/api/repository/diff', async (c) => {
    const filePath = c.req.query('path')
    if (!filePath) return c.json({ error: 'A changed path is required.' }, 400)
    const repository = await getRepositoryStatus()
    if (!repository.changedFiles.some((file) => file.path === filePath)) return c.json({ error: 'The path is not part of the reported repository changes.' }, 404)
    return c.json({ path: filePath, diff: await boundedDiff(filePath, repository.indexedHead) })
  })

  app.post('/api/repository/validations', async (c) => {
    const body = repositoryValidationSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'expectedHead and the current repository fingerprint are required.' }, 400)
    try {
      const id = await startRepositoryValidation(body.data)
      return c.json({ id }, 202)
    } catch (error) {
      if (error instanceof Error && error.name === 'StaleRepositoryError') return c.json({ error: error.message }, 409)
      if (error instanceof Error) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  app.get('/api/repository/validations/:id', async (c) => {
    const validation = await getValidationRun(c.req.param('id'))
    if (!validation) return c.json({ error: 'Repository validation not found.' }, 404)
    return c.json({ ...validation, events: await listValidationEvents(validation.id) })
  })

  app.get('/api/repository/validations/:id/events', async (c) => {
    const validation = await getValidationRun(c.req.param('id'))
    if (!validation) return c.json({ error: 'Repository validation not found.' }, 404)
    const headerId = Number.parseInt(c.req.header('Last-Event-ID') ?? '', 10)
    const queryId = Number.parseInt(c.req.query('after') ?? '0', 10)
    let cursor = Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0
    return streamSSE(c, async (stream) => {
      for (;;) {
        for (const event of await listValidationEvents(validation.id, cursor)) {
          cursor = event.id
          await stream.writeSSE({ event: event.type, id: String(event.id), data: JSON.stringify(event) })
        }
        const current = await getValidationRun(validation.id)
        if (!current || ['valid', 'invalid', 'imported', 'expired'].includes(current.status)) break
        await stream.sleep(700)
      }
    })
  })

  app.post('/api/repository/imports', async (c) => {
    const body = repositoryImportSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'A valid validationId and a 5–240 character change note are required.' }, 400)
    try {
      return c.json(await importValidatedRepositoryChanges(body.data.validationId, body.data.changeNote), 201)
    } catch (error) {
      if (error instanceof Error && (error.name === 'StaleRepositoryError' || error.name === 'StaleRevisionError')) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  app.get('/api/publications/:id', async (c) => {
    const publication = await getPublication(c.req.param('id'))
    if (!publication) return c.json({ error: 'Publication not found.' }, 404)
    return c.json({ ...publication, events: await listPublicationEvents(publication.id) })
  })

  app.get('/api/publications/:id/events', async (c) => {
    const publication = await getPublication(c.req.param('id'))
    if (!publication) return c.json({ error: 'Publication not found.' }, 404)
    const headerId = Number.parseInt(c.req.header('Last-Event-ID') ?? '', 10)
    const queryId = Number.parseInt(c.req.query('after') ?? '0', 10)
    let cursor = Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0
    return streamSSE(c, async (stream) => {
      for (;;) {
        for (const event of await listPublicationEvents(publication.id, cursor)) {
          cursor = event.id
          await stream.writeSSE({ event: event.type, id: String(event.id), data: JSON.stringify(event) })
        }
        const current = await getPublication(publication.id)
        if (!current || ['published', 'blocked', 'failed'].includes(current.status)) break
        await stream.sleep(700)
      }
    })
  })

  app.post('/api/publications/:id/retry', async (c) => {
    try {
      const publication = await retryBlockedPublication(c.req.param('id'))
      return c.json(publication, publication.status === 'published' ? 200 : 202)
    } catch (error) {
      if (error instanceof Error && ['RepositoryPreflightError', 'StaleRevisionError'].includes(error.name)) return c.json({ error: error.message }, 409)
      if (error instanceof Error && error.message === 'Publication not found') return c.json({ error: error.message }, 404)
      throw error
    }
  })

  app.post('/api/dashboards/:id/refresh', async (c) => {
    const body = refreshSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: 'datasetIds must contain at most eight dataset IDs.' }, 400)
    const detail = await getDashboardDetail(c.req.param('id'))
    if (!detail) return c.json({ error: 'Dashboard not found.' }, 404)
    const requested = body.data.datasetIds ? new Set(body.data.datasetIds) : null
    const datasets = requested
      ? detail.artifact.datasets.filter((dataset) => requested.has(dataset.id))
      : detail.artifact.datasets
    if (requested && datasets.length !== requested.size) return c.json({ error: 'Unknown dataset ID.' }, 400)
    for (const dataset of datasets) {
      const result = await executeDatasetQuery(dataset)
      await appendQueryResult(detail.currentRevisionId, dataset.id, result)
    }
    return c.json({ refreshed: datasets.map((dataset) => dataset.id) })
  })

  app.notFound((c) => c.json({ error: 'Not found.' }, 404))
  app.onError((error, c) => {
    console.error(error)
    return c.json({ error: 'Internal server error.' }, 500)
  })
  return app
}

export const app = createApp()
