import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDemoArtifact } from '../src/agent/demo.js'
import { resetConfigForTests } from '../src/config.js'
import { loadBundle, serializeBundle, writeBundleAtomically } from '../src/content/codec.js'
import {
  commitDashboardPath,
  findRevisionCommit,
  initializeGitRepository,
  inspectGitRepository,
  listDashboardPathsAt,
  listPathHistory,
  loadBundleAtCommit,
} from '../src/content/git-repository.js'

let root: string | undefined
const previousPath = process.env.CONTENT_REPOSITORY_PATH

afterEach(async () => {
  process.env.CONTENT_REPOSITORY_PATH = previousPath
  resetConfigForTests()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('local-only Git content repository', () => {
  it('initializes main and commits exactly one dashboard path with revision trailers', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldboard-git-'))
    process.env.CONTENT_REPOSITORY_PATH = root
    process.env.CONTENT_GIT_BRANCH = 'main'
    process.env.CONTENT_REPOSITORY_ENABLED = 'true'
    resetConfigForTests()
    await initializeGitRepository()
    const dashboardId = 'ccf25439-1111-4111-8111-111111111111'
    const revisionId = 'ddf25439-1111-4111-8111-111111111111'
    const contentPath = 'dashboards/source-summary--ccf25439'
    const bundle = serializeBundle(createDemoArtifact('Show the source data'), {
      dashboardId, contentPath, revisionId, revisionNumber: 1, parentRevisionId: null,
      restoredFromRevisionId: null, sourceKind: 'agent', note: 'Show the source data',
      model: 'deterministic-demo', runId: null, generatedAt: '2026-08-17T00:00:00.000Z', sourceSnapshot: null,
    })
    await writeBundleAtomically(root, bundle, contentPath, revisionId)
    await loadBundle(root, contentPath)
    const commit = await commitDashboardPath({
      contentPath, message: 'fieldboard(ccf25439): create revision 1', revisionId,
      dashboardId, runId: null, sourceKind: 'agent', artifactHash: bundle.artifactHash,
    })
    expect(commit.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await findRevisionCommit(revisionId)).toBe(commit.commitSha)
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
    expect(await findRevisionCommit(secondRevisionId)).toBe(secondCommit.commitSha)
    expect(await findRevisionCommit(revisionId)).toBe(commit.commitSha)
    const status = await inspectGitRepository()
    expect(status).toMatchObject({ initialized: true, branch: 'main', clean: true, readiness: 'ready' })
    expect(await listDashboardPathsAt(secondCommit.commitSha)).toEqual([contentPath])
    expect(await listPathHistory(contentPath)).toEqual([commit.commitSha, secondCommit.commitSha])
    const loaded = await loadBundleAtCommit(commit.commitSha, contentPath)
    expect(loaded.provenance.revisionId).toBe(revisionId)
    expect(loaded.artifactHash).toBe(bundle.artifactHash)
  })

  it('does not overwrite or dirty an already-initialized content repository', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fieldboard-git-'))
    process.env.CONTENT_REPOSITORY_PATH = root
    process.env.CONTENT_GIT_BRANCH = 'main'
    process.env.CONTENT_REPOSITORY_ENABLED = 'true'
    resetConfigForTests()
    await initializeGitRepository()
    const custom = '# Keep this README\n'
    await writeFile(path.join(root, 'README.md'), custom, 'utf8')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('git', ['-c', `safe.directory=${root}`, 'add', 'README.md'], { cwd: root })
    await promisify(execFile)('git', ['-c', `safe.directory=${root}`, 'commit', '-m', 'keep custom readme'], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fieldboard', GIT_AUTHOR_EMAIL: 'fieldboard@local', GIT_COMMITTER_NAME: 'Fieldboard', GIT_COMMITTER_EMAIL: 'fieldboard@local' },
    })
    const first = await initializeGitRepository()
    const second = await initializeGitRepository()
    expect(second).toBe(first)
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe(custom)
    const status = await inspectGitRepository()
    expect(status).toMatchObject({ initialized: true, clean: true, readiness: 'ready' })
  })
})
