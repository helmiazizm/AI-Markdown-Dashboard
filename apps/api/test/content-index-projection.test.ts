import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDemoArtifact } from '../src/agent/demo.js'
import { artifactSha256, canonicalizeDashboardArtifact } from '../src/content/codec.js'
import type { IndexedRevisionRecord } from '../src/content/persistence.js'

/**
 * Exercises the Postgres half of the Git projection, which the pure scan tests cannot reach.
 *
 * A full-mode apply asserts "the projection is exactly this set of dashboards", and no headPaths
 * value spares unrelated rows: a path absent from the list is pruned, and a path present under a
 * different dashboard id is replaced. So this suite creates and drops its own database rather
 * than rewriting a development projection. Everything that touches the connection pool is
 * imported dynamically, after DATABASE_URL has been pointed at that scratch database.
 */
const live = Boolean(process.env.DATABASE_URL) && process.env.RUN_PROJECTION_TESTS === '1'
const SCRATCH_DATABASE = 'fieldboard_projection_test'

const DASHBOARD_ID = 'aaaaaaaa-2222-4222-8222-222222222222'
const CONTENT_PATH = 'dashboards/projection-probe--aaaaaaaa'
const REVISION_IDS = [
  'bbbbbbbb-2222-4222-8222-222222222221',
  'bbbbbbbb-2222-4222-8222-222222222222',
  'bbbbbbbb-2222-4222-8222-222222222223',
]

function record(index: number, commitSha: string): IndexedRevisionRecord {
  const revisionNumber = index + 1
  const artifact = canonicalizeDashboardArtifact(createDemoArtifact(`Revision ${revisionNumber}`, revisionNumber))
  return {
    dashboardId: DASHBOARD_ID,
    contentPath: CONTENT_PATH,
    revisionId: REVISION_IDS[index]!,
    revisionNumber,
    parentRevisionId: index === 0 ? null : REVISION_IDS[index - 1]!,
    restoredFromRevisionId: null,
    sourceKind: 'agent',
    note: `Revision ${revisionNumber}`,
    model: 'deterministic-demo',
    generatedAt: `2026-08-17T00:0${index}:00.000Z`,
    artifact,
    artifactHash: artifactSha256(artifact),
    commitSha,
    treeSha: `${'c'.repeat(39)}${index}`,
    isHead: index === REVISION_IDS.length - 1,
  }
}

function scratchUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${SCRATCH_DATABASE}`
  return url.toString()
}

function maintenanceUrl(base: string): string {
  const url = new URL(base)
  url.pathname = '/postgres'
  return url.toString()
}

async function withMaintenance(base: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl(base) })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

describe.runIf(live)('Git projection in Postgres', () => {
  const originalUrl = process.env.DATABASE_URL!
  let applyContentIndex: typeof import('../src/content/persistence.js')['applyContentIndex']
  let getRepositoryDatabaseState: typeof import('../src/content/persistence.js')['getRepositoryDatabaseState']
  let pool: typeof import('../src/db/pool.js')['pool']
  let closePools: typeof import('../src/db/pool.js')['closePools']

  beforeAll(async () => {
    await withMaintenance(originalUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`)
    await withMaintenance(originalUrl, `CREATE DATABASE ${SCRATCH_DATABASE}`)
    process.env.DATABASE_URL = scratchUrl(originalUrl)
    const [persistence, poolModule, migrations] = await Promise.all([
      import('../src/content/persistence.js'),
      import('../src/db/pool.js'),
      import('../src/db/migrate-all.js'),
    ])
    applyContentIndex = persistence.applyContentIndex
    getRepositoryDatabaseState = persistence.getRepositoryDatabaseState
    pool = poolModule.pool
    closePools = poolModule.closePools
    await migrations.migrateAll()
  })

  afterAll(async () => {
    await closePools?.()
    process.env.DATABASE_URL = originalUrl
    await withMaintenance(originalUrl, `DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`)
  })

  it('rebuilds over a strict subset of its own revisions without violating the lineage keys', async () => {
    const head = 'd'.repeat(40)
    await applyContentIndex({
      head,
      indexedHead: head,
      mode: 'full',
      headPaths: [CONTENT_PATH],
      revisions: [record(0, `${'e'.repeat(39)}0`), record(1, `${'e'.repeat(39)}1`), record(2, `${'e'.repeat(39)}2`)],
      readiness: 'ready',
      error: null,
    })
    const seeded = await pool.query('SELECT id FROM dashboard_revisions WHERE dashboard_id = $1', [DASHBOARD_ID])
    expect(seeded.rows).toHaveLength(3)

    // Revision 1 is now missing from the scan while revision 2 still points at it as its parent.
    // Before migration 010 that delete raised 23503 and aborted every reindex from then on.
    const later = 'f'.repeat(40)
    await applyContentIndex({
      head: later,
      indexedHead: later,
      mode: 'full',
      headPaths: [CONTENT_PATH],
      revisions: [record(1, `${'e'.repeat(39)}1`), record(2, `${'e'.repeat(39)}2`)],
      readiness: 'ready',
      error: null,
    })
    const remaining = await pool.query<{ id: string; parent_revision_id: string | null; revision_number: number }>(
      'SELECT id, parent_revision_id, revision_number FROM dashboard_revisions WHERE dashboard_id = $1 ORDER BY revision_number',
      [DASHBOARD_ID],
    )
    expect(remaining.rows.map((row) => row.id)).toEqual([REVISION_IDS[1], REVISION_IDS[2]])
    // The severed link is reported as absent rather than left dangling.
    expect(remaining.rows[0]?.parent_revision_id).toBeNull()
    expect(remaining.rows[1]?.parent_revision_id).toBe(REVISION_IDS[1])
  })

  it('holds last_indexed_head back when the scan could not read part of the repository', async () => {
    const before = await getRepositoryDatabaseState()
    const head = `${'a'.repeat(39)}9`
    await applyContentIndex({
      head,
      indexedHead: null,
      mode: 'full',
      headPaths: [CONTENT_PATH],
      revisions: [record(0, `${'e'.repeat(39)}0`)],
      readiness: 'ready',
      error: 'dashboards/projection-probe--aaaaaaaa@abcdef0123: history unreadable',
    })
    const after = await getRepositoryDatabaseState()
    expect(after.indexedHead).toBe(before.indexedHead)
    expect(after.error).toContain('history unreadable')
    // current_head still advances: the repository moved, the projection just did not catch up.
    const state = await pool.query<{ current_head: string }>('SELECT current_head FROM content_repository_state WHERE singleton')
    expect(state.rows[0]?.current_head).toBe(head)
    expect(after.lastSuccessfulScan).toBe(before.lastSuccessfulScan)
  })
})
