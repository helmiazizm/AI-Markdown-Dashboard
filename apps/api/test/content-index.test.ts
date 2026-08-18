import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoArtifact } from '../src/agent/demo.js'
import { resetConfigForTests } from '../src/config.js'
import { serializeBundle, writeBundleAtomically } from '../src/content/codec.js'
import { commitDashboardPath, initializeGitRepository, listDashboardPathsAt, listPathHistory } from '../src/content/git-repository.js'
import { chooseReindexMode, scanCommittedDashboards } from '../src/content/indexer.js'

/**
 * Lets a test make the history walk fail or come back empty. A path that exists at HEAD always
 * has at least one commit behind it, so neither state is reachable through a real repository --
 * which is exactly why the indexer must not treat them as "this dashboard has one revision".
 */
const gitControl = vi.hoisted(() => ({ history: null as null | 'empty' | 'fail' }))

vi.mock('../src/content/git-repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/content/git-repository.js')>()
  return {
    ...actual,
    listPathHistory: async (contentPath: string, options?: { afterCommit?: string | null; untilCommit?: string }) => {
      if (gitControl.history === 'empty') return []
      if (gitControl.history === 'fail') throw new Error('fatal: unable to read commit history')
      return actual.listPathHistory(contentPath, options)
    },
  }
})

let root: string | undefined
const previousPath = process.env.CONTENT_REPOSITORY_PATH

afterEach(async () => {
  process.env.CONTENT_REPOSITORY_PATH = previousPath
  gitControl.history = null
  resetConfigForTests()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Two committed revisions of one dashboard, matching what the publisher would have written. */
async function seedTwoRevisions(): Promise<{ contentPath: string; head: string; revisionIds: [string, string] }> {
  root = await mkdtemp(path.join(tmpdir(), 'fieldboard-index-'))
  process.env.CONTENT_REPOSITORY_PATH = root
  process.env.CONTENT_GIT_BRANCH = 'main'
  process.env.CONTENT_REPOSITORY_ENABLED = 'true'
  resetConfigForTests()
  await initializeGitRepository()
  const dashboardId = 'ccf25439-1111-4111-8111-111111111111'
  const contentPath = 'dashboards/source-summary--ccf25439'
  const revisionIds: [string, string] = [
    'ddf25439-1111-4111-8111-111111111111',
    'eef25439-1111-4111-8111-111111111111',
  ]
  let head = ''
  for (const [index, revisionId] of revisionIds.entries()) {
    const revisionNumber = index + 1
    const bundle = serializeBundle(createDemoArtifact(`Revision ${revisionNumber}`, revisionNumber), {
      dashboardId, contentPath, revisionId, revisionNumber,
      parentRevisionId: index === 0 ? null : revisionIds[index - 1],
      restoredFromRevisionId: null, sourceKind: 'agent', note: `Revision ${revisionNumber}`,
      model: 'deterministic-demo', runId: null,
      generatedAt: `2026-08-17T00:0${index}:00.000Z`, sourceSnapshot: null,
    })
    await writeBundleAtomically(root, bundle, contentPath, revisionId)
    const commit = await commitDashboardPath({
      contentPath, message: `fieldboard(ccf25439): revision ${revisionNumber}`, revisionId,
      dashboardId, runId: null, sourceKind: 'agent', artifactHash: bundle.artifactHash,
    })
    head = commit.commitSha
  }
  return { contentPath, head, revisionIds }
}

describe('content reindex mode', () => {
  it('rebuilds when Postgres has no indexed head or the head is from another repository', () => {
    expect(chooseReindexMode({
      indexedHead: null, head: 'a'.repeat(40), indexedHeadInRepo: false, indexedIsAncestor: false,
    })).toBe('full')
    expect(chooseReindexMode({
      indexedHead: 'b'.repeat(40), head: 'a'.repeat(40), indexedHeadInRepo: false, indexedIsAncestor: false,
    })).toBe('full')
  })

  it('walks new commits when the indexed head is an ancestor, and skips when it already matches', () => {
    const head = 'a'.repeat(40)
    expect(chooseReindexMode({
      indexedHead: 'b'.repeat(40), head, indexedHeadInRepo: true, indexedIsAncestor: true,
    })).toBe('incremental')
    expect(chooseReindexMode({
      indexedHead: head, head, indexedHeadInRepo: true, indexedIsAncestor: true,
    })).toBe('skip')
  })

  it('rebuilds from Git when indexed history is unrelated even if the SHA exists elsewhere', () => {
    expect(chooseReindexMode({
      indexedHead: 'b'.repeat(40), head: 'a'.repeat(40), indexedHeadInRepo: true, indexedIsAncestor: false,
    })).toBe('full')
  })
})

describe('committed dashboard scan', () => {
  it('adopts provenance IDs from an existing Git history without writing Git', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldboard-index-'))
    process.env.CONTENT_REPOSITORY_PATH = root
    process.env.CONTENT_GIT_BRANCH = 'main'
    process.env.CONTENT_REPOSITORY_ENABLED = 'true'
    resetConfigForTests()
    const initHead = await initializeGitRepository()
    const dashboardId = 'ccf25439-1111-4111-8111-111111111111'
    const revisionId = 'ddf25439-1111-4111-8111-111111111111'
    const contentPath = 'dashboards/source-summary--ccf25439'
    const first = serializeBundle(createDemoArtifact('Show the source data'), {
      dashboardId, contentPath, revisionId, revisionNumber: 1, parentRevisionId: null,
      restoredFromRevisionId: null, sourceKind: 'agent', note: 'Show the source data',
      model: 'deterministic-demo', runId: null, generatedAt: '2026-08-17T00:00:00.000Z', sourceSnapshot: null,
    })
    await writeBundleAtomically(root, first, contentPath, revisionId)
    await commitDashboardPath({
      contentPath, message: 'fieldboard(ccf25439): create revision 1', revisionId,
      dashboardId, runId: null, sourceKind: 'agent', artifactHash: first.artifactHash,
    })
    const secondRevisionId = 'eef25439-1111-4111-8111-111111111111'
    const second = serializeBundle(createDemoArtifact('Refine the source summary', 2), {
      dashboardId, contentPath, revisionId: secondRevisionId, revisionNumber: 2, parentRevisionId: revisionId,
      restoredFromRevisionId: null, sourceKind: 'agent', note: 'Refine the source summary',
      model: 'deterministic-demo', runId: null, generatedAt: '2026-08-17T00:01:00.000Z', sourceSnapshot: null,
    })
    await writeBundleAtomically(root, second, contentPath, secondRevisionId)
    const secondCommit = await commitDashboardPath({
      contentPath, message: 'fieldboard(ccf25439): refine revision 2', revisionId: secondRevisionId,
      dashboardId, runId: null, sourceKind: 'agent', artifactHash: second.artifactHash,
    })

    const scanned = await scanCommittedDashboards({
      head: secondCommit.commitSha, mode: 'full', indexedHead: null,
    })
    expect(scanned.headPaths).toEqual([contentPath])
    expect(scanned.errors).toEqual([])
    expect(scanned.revisions.map((item) => item.revisionId)).toEqual([revisionId, secondRevisionId])
    expect(scanned.revisions.map((item) => item.isHead)).toEqual([false, true])
    expect(scanned.revisions[1]?.dashboardId).toBe(dashboardId)
    expect(scanned.revisions[1]?.artifactHash).toBe(second.artifactHash)

    const again = await scanCommittedDashboards({
      head: secondCommit.commitSha, mode: 'full', indexedHead: initHead,
    })
    expect(again.revisions.map((item) => item.revisionId)).toEqual([revisionId, secondRevisionId])
  })
})

describe('unreadable Git state is never mistaken for an empty repository', () => {
  it('raises rather than reporting no dashboards when a commit cannot be read', async () => {
    const { contentPath } = await seedTwoRevisions()
    const missing = 'f'.repeat(40)
    await expect(listDashboardPathsAt(missing)).rejects.toThrow()
    await expect(listPathHistory(contentPath, { untilCommit: missing })).rejects.toThrow()
  })

  it('reports no dashboards for a commit that genuinely has no dashboards tree', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldboard-index-'))
    process.env.CONTENT_REPOSITORY_PATH = root
    process.env.CONTENT_GIT_BRANCH = 'main'
    process.env.CONTENT_REPOSITORY_ENABLED = 'true'
    resetConfigForTests()
    const initHead = await initializeGitRepository()
    expect(await listDashboardPathsAt(initHead)).toEqual([])
  })

  it('reports an unreadable history instead of collapsing the dashboard to its HEAD revision', async () => {
    const { contentPath, head } = await seedTwoRevisions()
    for (const mode of ['empty', 'fail'] as const) {
      gitControl.history = mode
      const scanned = await scanCommittedDashboards({ head, mode: 'full', indexedHead: null })
      // headPaths still names the dashboard, so pruneMissingDashboards leaves it alone, and no
      // revision is offered, so the full-mode delete has no dashboard id to truncate.
      expect(scanned.headPaths).toEqual([contentPath])
      expect(scanned.revisions).toEqual([])
      expect(scanned.errors).toHaveLength(1)
      expect(scanned.errors[0]?.contentPath).toBe(contentPath)
    }
  })

  it('still skips a dashboard with no new commits during an incremental walk', async () => {
    const { head } = await seedTwoRevisions()
    gitControl.history = 'empty'
    const scanned = await scanCommittedDashboards({ head, mode: 'incremental', indexedHead: head })
    expect(scanned.revisions).toEqual([])
    expect(scanned.errors).toEqual([])
  })
})
