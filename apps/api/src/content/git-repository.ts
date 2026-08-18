import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RepositoryFileChange, RepositoryReadiness } from '@fieldboard/contracts'
import { getConfig } from '../config.js'
import { isDashboardContentPath, loadBundleFromFiles, type LoadedBundle } from './codec.js'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 2_000_000

export interface GitRepositorySnapshot {
  initialized: boolean
  branch: string | null
  head: string | null
  clean: boolean
  readiness: RepositoryReadiness
  fingerprint: string | null
  changedFiles: RepositoryFileChange[]
  affectedDashboards: string[]
  error: string | null
  repair: string | null
}

function repositoryRoot(): string {
  return path.resolve(getConfig().CONTENT_REPOSITORY_PATH)
}

async function runGit(args: string[], options?: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; trim?: boolean }): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', `safe.directory=${repositoryRoot()}`, ...args], {
      cwd: repositoryRoot(),
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT,
      env: { ...process.env, ...options?.env },
    })
    return options?.trim === false ? stdout : stdout.trimEnd()
  } catch (error) {
    if (options?.allowFailure) return ''
    const detail = error as Error & { stderr?: string }
    throw new Error(detail.stderr?.trim() || detail.message)
  }
}

export function getRepositoryRoot(): string {
  return repositoryRoot()
}

function changedDashboardPath(filePath: string): string | null {
  const match = /^(dashboards\/[^/]+)/.exec(filePath)
  return match?.[1] ?? null
}

function parseStatus(output: string): RepositoryFileChange[] {
  if (!output) return []
  return output.split('\0').filter(Boolean).map((entry) => {
    const status = entry.slice(0, 2).trim() || '??'
    const rawPath = entry.slice(3)
    const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) ?? rawPath : rawPath
    return { path: filePath, status, dashboardPath: changedDashboardPath(filePath) }
  })
}

async function computeFingerprint(head: string | null, statusOutput: string, files: RepositoryFileChange[]): Promise<string> {
  const hash = createHash('sha256').update(head ?? 'NO_HEAD').update('\0').update(statusOutput)
  const diff = await runGit(['--literal-pathspecs', 'diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.'], { allowFailure: true })
  hash.update('\0').update(diff)
  for (const file of files.filter((item) => item.status === '??').sort((a, b) => a.path.localeCompare(b.path))) {
    const absolute = path.resolve(repositoryRoot(), file.path)
    if (!absolute.startsWith(`${repositoryRoot()}${path.sep}`)) continue
    try {
      hash.update('\0').update(file.path).update('\0').update(await readFile(absolute))
    } catch {
      hash.update('\0MISSING')
    }
  }
  return hash.digest('hex')
}

export async function inspectGitRepository(): Promise<GitRepositorySnapshot> {
  const config = getConfig()
  if (!config.CONTENT_REPOSITORY_ENABLED) {
    return { initialized: false, branch: null, head: null, clean: true, readiness: 'disabled', fingerprint: null, changedFiles: [], affectedDashboards: [], error: null, repair: null }
  }
  try {
    await access(repositoryRoot())
  } catch {
    return {
      initialized: false, branch: null, head: null, clean: false, readiness: 'uninitialized', fingerprint: null,
      changedFiles: [], affectedDashboards: [], error: 'The content repository directory does not exist.',
      repair: 'Run make setup for a first-time checkout, or make content-init to initialize an empty content repository.',
    }
  }
  const gitDir = await runGit(['rev-parse', '--git-dir'], { allowFailure: true })
  if (!gitDir) {
    return {
      initialized: false, branch: null, head: null, clean: false, readiness: 'uninitialized', fingerprint: null,
      changedFiles: [], affectedDashboards: [], error: 'The configured directory is not a Git repository.',
      repair: 'Run make setup if this is a first-time checkout, or make content-init if this is the intended empty content directory.',
    }
  }
  try {
    const branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }) || null
    const head = await runGit(['rev-parse', 'HEAD'], { allowFailure: true }) || null
    const statusOutput = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
    const changedFiles = parseStatus(`${statusOutput}${statusOutput ? '\0' : ''}`)
    const affectedDashboards = [...new Set(changedFiles.map((file) => file.dashboardPath).filter((value): value is string => Boolean(value)))]
    const fingerprint = await computeFingerprint(head, statusOutput, changedFiles)
    if (!branch) {
      return { initialized: true, branch, head, clean: false, readiness: 'detached', fingerprint, changedFiles, affectedDashboards, error: 'HEAD is detached.', repair: `Check out ${config.CONTENT_GIT_BRANCH} manually, then validate the repository again.` }
    }
    if (branch !== config.CONTENT_GIT_BRANCH) {
      return { initialized: true, branch, head, clean: false, readiness: 'wrong_branch', fingerprint, changedFiles, affectedDashboards, error: `Expected branch ${config.CONTENT_GIT_BRANCH}, found ${branch}.`, repair: `Check out ${config.CONTENT_GIT_BRANCH} manually; Fieldboard never switches branches.` }
    }
    return {
      initialized: true,
      branch,
      head,
      clean: changedFiles.length === 0,
      readiness: changedFiles.length === 0 ? 'ready' : 'dirty',
      fingerprint,
      changedFiles,
      affectedDashboards,
      error: changedFiles.length ? 'The content worktree has uncommitted changes.' : null,
      repair: changedFiles.length ? 'Review, validate, and import these changes from the repository sync center.' : null,
    }
  } catch (error) {
    return { initialized: true, branch: null, head: null, clean: false, readiness: 'unavailable', fingerprint: null, changedFiles: [], affectedDashboards: [], error: error instanceof Error ? error.message : String(error), repair: 'Restore local filesystem and Git access, then retry.' }
  }
}

async function writeSeedFileIfMissing(relativePath: string, value: string): Promise<boolean> {
  try {
    await writeFile(path.join(repositoryRoot(), relativePath), value, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

export async function initializeGitRepository(): Promise<string> {
  const config = getConfig()
  await mkdir(repositoryRoot(), { recursive: true })
  const existing = await inspectGitRepository()
  if (existing.initialized && existing.head) return existing.head
  if (!existing.initialized) {
    const entries = await readdir(repositoryRoot()).catch(() => [])
    if (entries.length > 0) throw new Error('Content init requires an absent or empty directory, or an already-initialized Git repository')
    await execFileAsync('git', ['init', '-b', config.CONTENT_GIT_BRANCH, repositoryRoot()], { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT })
  }
  const rootFiles: Record<string, string> = {
    'fieldboard.repository.json': `${JSON.stringify({ schemaVersion: 1, branch: config.CONTENT_GIT_BRANCH, contentRoot: 'dashboards' }, null, 2)}\n`,
    'README.md': '# Fieldboard content\n\nGit-canonical analytical documents published by Fieldboard. Edit dashboard bundles, then validate and import them in the repository sync center.\n',
    '.gitattributes': '* text=auto eol=lf\n*.md text eol=lf\n*.sql text eol=lf\n*.json text eol=lf\n*.js text eol=lf\n',
    '.gitignore': '.fieldboard-tmp/\n.DS_Store\n',
  }
  const created: string[] = []
  for (const [file, value] of Object.entries(rootFiles)) {
    if (await writeSeedFileIfMissing(file, value)) created.push(file)
  }
  const head = await runGit(['rev-parse', 'HEAD'], { allowFailure: true })
  if (!head) {
    const toCommit = created.length ? created : Object.keys(rootFiles)
    await runGit(['add', '--', ...toCommit])
    await runGit(['commit', '-m', 'fieldboard: initialize content repository'], { env: authorEnvironment() })
  }
  return await runGit(['rev-parse', 'HEAD'])
}

function authorEnvironment(date?: string): NodeJS.ProcessEnv {
  const config = getConfig()
  return {
    GIT_AUTHOR_NAME: config.CONTENT_GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: config.CONTENT_GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: config.CONTENT_GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: config.CONTENT_GIT_AUTHOR_EMAIL,
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  }
}

export async function commitDashboardPath(input: {
  contentPath: string
  message: string
  revisionId: string
  dashboardId: string
  runId: string | null
  sourceKind: string
  artifactHash: string
  date?: string
}): Promise<{ commitSha: string; treeSha: string }> {
  const trailers = [
    `Fieldboard-Dashboard: ${input.dashboardId}`,
    `Fieldboard-Revision: ${input.revisionId}`,
    ...(input.runId ? [`Fieldboard-Run: ${input.runId}`] : []),
    `Fieldboard-Source: ${input.sourceKind}`,
    `Fieldboard-Artifact-SHA256: ${input.artifactHash}`,
  ]
  await runGit(['--literal-pathspecs', 'add', '--', input.contentPath])
  await runGit(['--literal-pathspecs', 'commit', '--only', '-m', `${input.message}\n\n${trailers.join('\n')}`, '--', input.contentPath], { env: authorEnvironment(input.date) })
  const commitSha = await runGit(['rev-parse', 'HEAD'])
  const treeSha = await runGit(['rev-parse', `${commitSha}:${input.contentPath}`])
  return { commitSha, treeSha }
}

export async function commitRepositoryFiles(paths: string[], message: string, date?: string): Promise<string> {
  if (!paths.length || paths.some((file) => path.posix.normalize(file) !== file || path.isAbsolute(file) || file.includes('..'))) {
    throw new Error('Invalid repository metadata path')
  }
  await runGit(['--literal-pathspecs', 'add', '--', ...paths])
  await runGit(['--literal-pathspecs', 'commit', '--only', '-m', message, '--', ...paths], { env: authorEnvironment(date) })
  return runGit(['rev-parse', 'HEAD'])
}

export async function getRepositoryHead(): Promise<string | null> {
  return (await runGit(['rev-parse', 'HEAD'], { allowFailure: true })) || null
}

export async function findRevisionCommit(revisionId: string): Promise<string | null> {
  const output = await runGit(['log', '--all', '--format=%H%x00%B%x00'], { allowFailure: true })
  const values = output.split('\0')
  for (let index = 0; index < values.length - 1; index += 2) {
    if (values[index + 1]?.includes(`Fieldboard-Revision: ${revisionId}`)) return values[index]?.trim() || null
  }
  return null
}

export async function readBundleFileAtCommit(commitSha: string, contentPath: string, relativeFile: string): Promise<string> {
  return runGit(['show', `${commitSha}:${contentPath}/${relativeFile}`])
}

export async function getCommitTreeSha(commitSha: string, contentPath: string): Promise<string> {
  return runGit(['rev-parse', `${commitSha}:${contentPath}`])
}

export async function listCommitsAfter(indexedHead: string | null): Promise<Array<{ sha: string; subject: string }>> {
  if (!indexedHead) return []
  const output = await runGit(['log', '--format=%H%x09%s', `${indexedHead}..HEAD`], { allowFailure: true })
  return output ? output.split('\n').map((line) => {
    const [sha = '', ...subject] = line.split('\t')
    return { sha, subject: subject.join('\t') }
  }) : []
}

export async function listChangedFilesBetween(base: string, target = 'HEAD'): Promise<RepositoryFileChange[]> {
  const output = await runGit(['diff', '--name-status', '-z', '--no-renames', `${base}..${target}`], { allowFailure: true })
  if (!output) return []
  const parts = output.split('\0').filter(Boolean)
  const changes: RepositoryFileChange[] = []
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index] ?? ''
    const filePath = parts[index + 1] ?? ''
    if (filePath) changes.push({ path: filePath, status, dashboardPath: changedDashboardPath(filePath) })
  }
  return changes
}

export async function isAncestor(ancestor: string, descendant = 'HEAD'): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

export async function commitExists(sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) return false
  try {
    await runGit(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * The caller prunes every projected dashboard absent from this list, so an unreadable tree must
 * never look like an empty one. Listing the commit root first makes "this commit has no
 * dashboards/ directory yet" a positive observation: the root listing succeeded and simply does
 * not carry the entry. Both calls throw on failure, so a transient Git error propagates instead
 * of being silently reported as a repository with no dashboards.
 */
export async function listDashboardPathsAt(commitSha: string): Promise<string[]> {
  const root = await runGit(['ls-tree', '--name-only', commitSha])
  if (!root.split('\n').includes('dashboards')) return []
  const output = await runGit(['ls-tree', '--name-only', `${commitSha}:dashboards`])
  if (!output) return []
  return output.split('\n').map((name) => `dashboards/${name}`).filter((contentPath) => isDashboardContentPath(contentPath)).sort()
}

export async function listPathHistory(contentPath: string, options?: { afterCommit?: string | null; untilCommit?: string }): Promise<string[]> {
  if (!isDashboardContentPath(contentPath)) throw new Error(`Invalid dashboard content path: ${contentPath}`)
  const until = options?.untilCommit ?? 'HEAD'
  const range = options?.afterCommit ? [`${options.afterCommit}..${until}`] : [until]
  // Deliberately not allowFailure: an empty result has to mean "no commits touched this path",
  // because a full reindex deletes every revision this walk does not return.
  const output = await runGit(['log', '--reverse', '--format=%H', ...range, '--', contentPath])
  return output ? output.split('\n').filter(Boolean) : []
}

function parseLsTree(output: string): Array<{ mode: string; type: string; path: string }> {
  if (!output) return []
  const entries: Array<{ mode: string; type: string; path: string }> = []
  for (const entry of output.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [mode, type] = entry.slice(0, tab).split(' ')
    const filePath = entry.slice(tab + 1)
    if (mode && type && filePath) entries.push({ mode, type, path: filePath })
  }
  return entries
}

export async function readBundleFilesAtCommit(commitSha: string, contentPath: string): Promise<Map<string, string>> {
  if (!isDashboardContentPath(contentPath)) throw new Error(`Invalid dashboard content path: ${contentPath}`)
  const tree = await runGit(['ls-tree', '-r', '-z', `${commitSha}:${contentPath}`], { allowFailure: true, trim: false })
  const entries = parseLsTree(tree)
  if (!entries.length) throw new Error(`Dashboard bundle is missing at ${commitSha}:${contentPath}`)
  const files = new Map<string, string>()
  for (const entry of entries) {
    if (entry.mode === '120000' || entry.type !== 'blob') throw new Error(`Symlinks are not allowed in bundles: ${entry.path}`)
    const body = await runGit(['show', `${commitSha}:${contentPath}/${entry.path}`], { trim: false })
    files.set(entry.path, body)
  }
  return files
}

export async function loadBundleAtCommit(commitSha: string, contentPath: string): Promise<LoadedBundle> {
  return loadBundleFromFiles(contentPath, await readBundleFilesAtCommit(commitSha, contentPath))
}

export async function boundedDiff(filePath: string, base?: string | null): Promise<string> {
  if (path.posix.normalize(filePath) !== filePath || filePath.includes('..') || path.isAbsolute(filePath)) throw new Error('Invalid diff path')
  let output = await runGit(['--literal-pathspecs', 'diff', '--no-ext-diff', '--unified=4', ...(base ? [base] : ['HEAD']), '--', filePath], { allowFailure: true })
  if (!output) {
    try {
      const content = await readFile(path.join(repositoryRoot(), filePath), 'utf8')
      output = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split('\n').length} @@\n${content.split('\n').map((line) => `+${line}`).join('\n')}`
    } catch {
      // A deleted path is represented by the tracked diff above.
    }
  }
  if (Buffer.byteLength(output) > 200_000) return `${output.slice(0, 200_000)}\n\n[diff truncated at 200 KB]`
  return output
}
