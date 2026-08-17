<script setup lang="ts">
import type { ContentLifecycleEvent, ContentValidationRun, RepositoryStatus } from '@fieldboard/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, followRepositoryValidation } from '../lib/api.js'

const repository = ref<RepositoryStatus | null>(null)
const loading = ref(true)
const working = ref(false)
const error = ref('')
const selectedPath = ref('')
const diff = ref('')
const diffLoading = ref(false)
const validation = ref<ContentValidationRun | null>(null)
const validationEvents = ref<ContentLifecycleEvent[]>([])
const changeNote = ref('')
let stopFollowing: (() => void) | undefined

const canValidate = computed(() => Boolean(
  repository.value?.fingerprint
  && repository.value.head
  && ['dirty', 'unindexed'].includes(repository.value.readiness)
  && !working.value,
))
const canImport = computed(() => validation.value?.status === 'valid' && changeNote.value.trim().length >= 5 && !working.value)

onMounted(load)
onBeforeUnmount(() => stopFollowing?.())

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    repository.value = await api.repository()
    if (!selectedPath.value && repository.value.changedFiles[0]) await showDiff(repository.value.changedFiles[0].path)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

async function showDiff(path: string): Promise<void> {
  selectedPath.value = path
  diffLoading.value = true
  try {
    diff.value = (await api.repositoryDiff(path)).diff
  } catch (reason) {
    diff.value = ''
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    diffLoading.value = false
  }
}

async function validateChanges(): Promise<void> {
  if (!repository.value?.fingerprint || !canValidate.value) return
  working.value = true
  error.value = ''
  validation.value = null
  validationEvents.value = []
  try {
    const started = await api.startRepositoryValidation(repository.value.head, repository.value.fingerprint)
    stopFollowing = followRepositoryValidation(started.id, (event) => {
      if (!validationEvents.value.some((existing) => existing.id === event.id)) validationEvents.value.push(event)
    }, (status) => {
      validation.value = status
      working.value = false
    }, (reason) => {
      working.value = false
      error.value = reason.message
    })
  } catch (reason) {
    working.value = false
    error.value = reason instanceof Error ? reason.message : String(reason)
    if ((reason as { status?: number }).status === 409) await load()
  }
}

async function importChanges(): Promise<void> {
  if (!validation.value || !canImport.value) return
  working.value = true
  error.value = ''
  try {
    await api.importRepositoryChanges(validation.value.id, changeNote.value.trim())
    changeNote.value = ''
    validation.value = null
    validationEvents.value = []
    selectedPath.value = ''
    diff.value = ''
    await load()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    if ((reason as { status?: number }).status === 409) validation.value = null
  } finally {
    working.value = false
  }
}

async function retryPublication(id: string): Promise<void> {
  if (working.value) return
  working.value = true
  error.value = ''
  try {
    await api.retryPublication(id)
    await load()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    working.value = false
  }
}

function shortSha(value: string | null): string {
  return value?.slice(0, 10) ?? '—'
}

function eventTime(value: string): string {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}
</script>

<template>
  <div class="repository-page">
    <header class="repository-masthead">
      <div>
        <RouterLink class="back-link" to="/">← Library</RouterLink>
        <p class="eyebrow signal-text">Git-canonical authored content</p>
        <h1>Repository<br />sync center</h1>
      </div>
      <div v-if="repository" class="repository-state" :data-state="repository.readiness" role="status">
        <span class="state-beacon" aria-hidden="true"></span>
        <div><small>AUTHORING STATE</small><strong>{{ repository.readiness.replace('_', ' ') }}</strong></div>
      </div>
    </header>

    <div v-if="loading" class="repository-skeleton" aria-label="Loading repository status"><span></span><span></span><span></span></div>
    <p v-else-if="error && !repository" class="repository-fatal error-message" role="alert">{{ error }}</p>

    <template v-else-if="repository">
      <section class="repository-readout" aria-label="Repository coordinates">
        <div><span>PATH</span><strong>{{ repository.configuredPath }}</strong></div>
        <div><span>BRANCH</span><strong>{{ repository.branch ?? 'unavailable' }} / {{ repository.expectedBranch }}</strong></div>
        <div><span>HEAD</span><code>{{ shortSha(repository.head) }}</code></div>
        <div><span>INDEXED</span><code>{{ shortSha(repository.indexedHead) }}</code></div>
        <button class="text-button" :disabled="loading" @click="load">Rescan ↻</button>
      </section>

      <section v-if="repository.error" class="repository-advisory" role="alert">
        <span>BLOCKED</span>
        <div><strong>{{ repository.error }}</strong><p>{{ repository.repair }}</p></div>
      </section>

      <section class="repository-workbench">
        <div class="change-ledger">
          <div class="repository-section-heading">
            <div><span class="eyebrow">Worktree ledger</span><h2>Changed files</h2></div>
            <strong>{{ repository.changedFiles.length }}</strong>
          </div>
          <button
            v-for="file in repository.changedFiles"
            :key="`${file.status}-${file.path}`"
            class="change-row"
            :class="{ selected: selectedPath === file.path }"
            @click="showDiff(file.path)"
          >
            <span>{{ file.status }}</span><code>{{ file.path }}</code><small>{{ file.dashboardPath ? 'BUNDLE' : 'ROOT' }}</small>
          </button>
          <p v-if="!repository.changedFiles.length" class="repository-empty">No working-tree or unindexed content changes. The projection is aligned with HEAD.</p>

          <div v-if="repository.unindexedCommits.length" class="commit-ledger">
            <span class="eyebrow">Unindexed commits</span>
            <div v-for="commit in repository.unindexedCommits" :key="commit.sha"><code>{{ commit.sha.slice(0, 10) }}</code><span>{{ commit.subject }}</span></div>
          </div>
        </div>

        <div class="diff-reader">
          <div class="diff-heading"><span>{{ selectedPath || 'Select a changed file' }}</span><small>UNIFIED DIFF · BOUNDED</small></div>
          <pre v-if="diffLoading" aria-live="polite">Loading diff…</pre>
          <pre v-else-if="diff"><code>{{ diff }}</code></pre>
          <div v-else class="diff-empty">A syntax-preserving diff appears here when a changed path is selected.</div>
        </div>
      </section>

      <section class="repository-validation">
        <div class="validation-intro">
          <span class="eyebrow signal-text">Validation gate</span>
          <h2>Prove the bundle before publication.</h2>
          <p>Fieldboard fingerprints the complete repository state, loads every affected bundle, applies runtime security checks, and reruns every final DuckDB query.</p>
          <button class="signal-button" :disabled="!canValidate" @click="validateChanges">{{ working ? 'Validating…' : 'Validate changes' }} <span>↗</span></button>
        </div>
        <div class="validation-trail" aria-live="polite">
          <div v-for="event in validationEvents" :key="event.id" class="validation-event">
            <span>{{ eventTime(event.createdAt) }}</span><strong>{{ event.type }}</strong><p>{{ event.message }}</p>
          </div>
          <div v-if="validation?.status === 'valid'" class="import-gate">
            <label for="change-note">Human change note</label>
            <textarea id="change-note" v-model="changeNote" rows="2" maxlength="240" placeholder="Explain the analytical change and why it is being published…"></textarea>
            <div><small>{{ changeNote.trim().length }}/240 · minimum 5</small><button class="signal-button compact" :disabled="!canImport" @click="importChanges">Import changes ↗</button></div>
          </div>
          <div v-else-if="!validationEvents.length" class="validation-empty">No active validation. Tokens expire after 20 minutes and are invalidated by any repository change.</div>
        </div>
      </section>

      <section v-if="repository.blockedPublications.length" class="blocked-publications">
        <div class="repository-section-heading"><div><span class="eyebrow">Recovery queue</span><h2>Blocked publications</h2></div><strong>{{ repository.blockedPublications.length }}</strong></div>
        <div v-for="publication in repository.blockedPublications" :key="publication.id" class="publication-row">
          <span>R{{ publication.revisionNumber }}</span>
          <div><code>{{ publication.dashboardId.slice(0, 8) }} / {{ publication.id.slice(0, 8) }}</code><p>{{ publication.error ?? publication.status }}</p></div>
          <button v-if="publication.status === 'blocked'" class="quiet-button" :disabled="working || repository.readiness !== 'ready'" @click="retryPublication(publication.id)">Retry publication</button>
        </div>
      </section>

      <p v-if="error" class="repository-inline-error error-message" role="alert">{{ error }}</p>
    </template>
  </div>
</template>
