import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDemoArtifact } from '../src/agent/demo.js'
import {
  artifactSha256,
  canonicalizeDashboardArtifact,
  loadBundle,
  serializeBundle,
  writeBundleAtomically,
} from '../src/content/codec.js'

const roots: string[] = []
const dashboardId = 'ccf25439-1111-4111-8111-111111111111'
const revisionId = 'ddf25439-1111-4111-8111-111111111111'
const contentPath = 'dashboards/source-summary--ccf25439'

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repositoryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fieldboard-codec-'))
  roots.push(root)
  return root
}

function bundle() {
  return serializeBundle(createDemoArtifact('Show the source data'), {
    dashboardId,
    contentPath,
    revisionId,
    revisionNumber: 1,
    parentRevisionId: null,
    restoredFromRevisionId: null,
    sourceKind: 'agent',
    note: 'Show the source data',
    model: 'deterministic-demo',
    runId: 'eef25439-1111-4111-8111-111111111111',
    generatedAt: '2026-08-17T00:00:00.000Z',
    sourceSnapshot: {
      id: 'fff25439-1111-4111-8111-111111111111',
      objectPrefix: 'warehouse:catalog@fff25439-1111-4111-8111-111111111111',
      snapshotDate: '2026-03-19',
    },
  })
}

describe('Git-canonical dashboard bundle codec', () => {
  it('round-trips Markdown and native sidecars to the same canonical artifact hash', async () => {
    const root = await repositoryRoot()
    const serialized = bundle()
    await writeBundleAtomically(root, serialized, contentPath, revisionId)
    const loaded = await loadBundle(root, contentPath)
    expect(loaded.artifact).toEqual(serialized.artifact)
    expect(loaded.artifactHash).toBe(artifactSha256(canonicalizeDashboardArtifact(createDemoArtifact('Show the source data'))))
    expect(loaded.manifest.datasets[0]?.sqlFile).toBe('queries/catalog-volume.sql')
    expect(loaded.manifest.widgets[0]?.sourceFile).toBe('widgets/catalog-volume.echarts.json')
  })

  it('rejects unknown files and symlinked authored content', async () => {
    const root = await repositoryRoot()
    await writeBundleAtomically(root, bundle(), contentPath, revisionId)
    await writeFile(path.join(root, contentPath, 'notes.txt'), 'untracked\n', 'utf8')
    await expect(loadBundle(root, contentPath)).rejects.toThrow('Unsupported bundle files')
    await rm(path.join(root, contentPath, 'notes.txt'))
    await rm(path.join(root, contentPath, 'dashboard.md'))
    await symlink('/etc/hosts', path.join(root, contentPath, 'dashboard.md'))
    await expect(loadBundle(root, contentPath)).rejects.toThrow('Symlinks are not allowed')
  })

  it('rejects manifest paths that do not match their IDs', async () => {
    const root = await repositoryRoot()
    await writeBundleAtomically(root, bundle(), contentPath, revisionId)
    const manifestPath = path.join(root, contentPath, 'fieldboard.json')
    const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(manifestPath, 'utf8'))) as { datasets: Array<{ sqlFile: string }> }
    manifest.datasets[0]!.sqlFile = 'queries/other.sql'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await expect(loadBundle(root, contentPath)).rejects.toThrow()
  })

  it('rejects invalid UTF-8 instead of accepting replacement characters', async () => {
    const root = await repositoryRoot()
    await writeBundleAtomically(root, bundle(), contentPath, revisionId)
    await writeFile(path.join(root, contentPath, 'dashboard.md'), Buffer.from([0xff, 0x0a]))
    await expect(loadBundle(root, contentPath)).rejects.toThrow('Invalid UTF-8')
  })
})
