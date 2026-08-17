import { artifactSha256, canonicalizeDashboardArtifact } from './codec.js'
import { getCommitTreeSha } from './git-repository.js'
import { getDashboardContentPath, getRestoreSource, prepareRestorePublication } from './persistence.js'
import { assertRepositoryReadyForGeneration, publishPreparedRevision } from './publication-service.js'

export async function restorePublishedRevision(dashboardId: string, sourceRevisionId: string): Promise<{
  revisionId: string
  publicationId: string
  status: string
}> {
  const repository = await assertRepositoryReadyForGeneration()
  if (!repository.head) throw new Error('Content repository has no HEAD')
  const [source, contentPath] = await Promise.all([
    getRestoreSource(dashboardId, sourceRevisionId),
    getDashboardContentPath(dashboardId),
  ])
  if (!contentPath || !source.gitCommitSha || !source.gitTreeSha || !source.artifactHash) {
    throw new Error('The source revision is not pinned to a verified Git bundle')
  }
  const actualTree = await getCommitTreeSha(source.gitCommitSha, contentPath)
  if (actualTree !== source.gitTreeSha) throw new Error('The source revision Git tree no longer matches its recorded provenance')
  const artifact = canonicalizeDashboardArtifact(source.artifact)
  const artifactHash = artifactSha256(artifact)
  if (artifactHash !== source.artifactHash) throw new Error('The source revision artifact hash is invalid')
  const prepared = await prepareRestorePublication({ dashboardId, sourceRevisionId, artifact, artifactHash, expectedHead: repository.head })
  const published = await publishPreparedRevision(prepared.id)
  return { revisionId: published.revisionId, publicationId: published.id, status: published.status }
}
