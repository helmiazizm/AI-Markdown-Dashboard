import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRepositoryRoot, initializeGitRepository, inspectGitRepository } from './git-repository.js'

export interface ContentInitReport {
  schemaVersion: 1
  created: boolean
  head: string
}

export async function initContentRepository(): Promise<ContentInitReport> {
  const before = await inspectGitRepository()
  if (!before.initialized) {
    const entries = await readdir(getRepositoryRoot()).catch(() => [])
    if (entries.length > 0) throw new Error('Content init requires an absent or empty directory, or an already-initialized Git repository')
  }
  const head = await initializeGitRepository()
  return { schemaVersion: 1, created: !before.initialized || !before.head, head }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initContentRepository()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
