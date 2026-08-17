<script setup lang="ts">
import type { DashboardDetail, GenerationEvent } from '@fieldboard/contracts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AnalysisTrail from '../components/AnalysisTrail.vue'
import DashboardDocument from '../components/DashboardDocument.vue'
import { api, followGeneration } from '../lib/api.js'

const route = useRoute()
const router = useRouter()
const detail = ref<DashboardDetail | null>(null)
const loading = ref(true)
const working = ref(false)
const historyOpen = ref(false)
const prompt = ref('')
const events = ref<GenerationEvent[]>([])
const detailedTrail = ref(false)
const error = ref('')
let stopFollowing: (() => void) | undefined

const dashboardId = computed(() => String(route.params.id))
const isHistorical = computed(() => detail.value && detail.value.revision.id !== detail.value.currentRevisionId)

onMounted(load)
watch(() => [route.params.id, route.query.revision], load)
onBeforeUnmount(() => stopFollowing?.())

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    detail.value = await api.dashboard(dashboardId.value, typeof route.query.revision === 'string' ? route.query.revision : undefined)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

async function refine(): Promise<void> {
  if (!detail.value || working.value || prompt.value.trim().length < 5 || isHistorical.value) return
  working.value = true
  events.value = []
  error.value = ''
  try {
    const run = await api.refine(dashboardId.value, prompt.value.trim(), detail.value.currentRevisionId, detailedTrail.value ? 'detailed' : 'standard')
    stopFollowing = followGeneration(run.id, (event) => {
      if (!events.value.some((existing) => existing.id === event.id)) events.value.push(event)
    }, async (status) => {
      working.value = false
      if (status.status === 'completed') {
        prompt.value = ''
        await router.replace({ name: 'dashboard', params: { id: dashboardId.value } })
        await load()
      } else error.value = status.error ?? 'Refinement failed.'
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

async function refresh(datasetIds?: string[]): Promise<void> {
  if (!detail.value || working.value || isHistorical.value) return
  working.value = true
  error.value = ''
  try {
    await api.refresh(dashboardId.value, datasetIds)
    await load()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    working.value = false
  }
}

async function restore(revisionId: string): Promise<void> {
  if (working.value) return
  working.value = true
  try {
    const restored = await api.restore(dashboardId.value, revisionId)
    if (restored.status !== 'published') {
      error.value = 'Restore is validated but publication is blocked. Open Repository sync to recover it.'
      return
    }
    historyOpen.value = false
    await router.replace({ name: 'dashboard', params: { id: dashboardId.value } })
    await load()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    working.value = false
  }
}

function viewRevision(revisionId?: string): void {
  historyOpen.value = false
  void router.push({ name: 'dashboard', params: { id: dashboardId.value }, query: revisionId ? { revision: revisionId } : {} })
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
</script>

<template>
  <div class="dashboard-page">
    <div v-if="loading" class="page-state"><span class="loading-mark"></span><p>Opening cached fieldboard…</p></div>
    <div v-else-if="error && !detail" class="page-state error-message"><p>{{ error }}</p><RouterLink to="/">Return to library</RouterLink></div>
    <template v-else-if="detail">
      <header class="dashboard-toolbar">
        <RouterLink to="/" class="back-link">← Library</RouterLink>
        <div class="toolbar-title">
          <span class="eyebrow">Fieldboard / {{ detail.id.slice(0, 8) }}</span>
          <strong>{{ detail.artifact.title }}</strong>
          <code v-if="detail.revision.gitCommitSha" class="toolbar-commit">{{ detail.revision.gitCommitSha.slice(0, 10) }}</code>
        </div>
        <div class="toolbar-actions">
          <button class="quiet-button" @click="historyOpen = !historyOpen">Revision {{ detail.revision.revisionNumber }} / {{ detail.revisions.length }}</button>
          <button class="signal-button compact" :disabled="working || Boolean(isHistorical)" @click="refresh()">{{ working ? 'Working…' : 'Refresh all ↻' }}</button>
        </div>
      </header>

      <aside v-if="historyOpen" class="history-panel" aria-label="Revision history">
        <div class="history-heading"><span>IMMUTABLE REVISION LOG</span><button class="text-button" @click="historyOpen = false">Close ×</button></div>
        <div v-for="revision in detail.revisions" :key="revision.id" class="history-row" :class="{ current: revision.id === detail.currentRevisionId }">
          <span>R{{ String(revision.revisionNumber).padStart(2, '0') }}</span>
          <div>
            <strong>{{ revision.prompt }}</strong>
            <time :datetime="revision.createdAt">{{ formatDate(revision.createdAt) }}</time>
            <div class="revision-provenance">
              <span>{{ revision.sourceKind }}</span>
              <code>{{ revision.gitCommitSha?.slice(0, 10) ?? 'unmapped' }}</code>
              <span :data-status="revision.publicationStatus">{{ revision.publicationStatus }}</span>
            </div>
          </div>
          <div class="history-actions">
            <button class="text-button" @click="viewRevision(revision.id === detail.currentRevisionId ? undefined : revision.id)">View</button>
            <button v-if="revision.id !== detail.currentRevisionId" class="text-button" :disabled="working" @click="restore(revision.id)">Restore as new</button>
          </div>
        </div>
      </aside>

      <div v-if="isHistorical" class="historical-banner">
        <span>Viewing revision {{ detail.revision.revisionNumber }}</span>
        <p>This is an immutable historical artifact. Restore it to create a new current revision.</p>
        <button class="signal-button compact" :disabled="working" @click="restore(detail.revision.id)">Restore as new ↗</button>
      </div>

      <section class="document-intro">
        <div class="document-kicker">
          <span>ANALYTICAL DOCUMENT</span><span>REV {{ detail.revision.revisionNumber }}</span>
          <span v-if="detail.contentPath">{{ detail.contentPath }}</span>
        </div>
        <p>{{ detail.artifact.summary }}</p>
      </section>

      <DashboardDocument :artifact="detail.artifact" :results="detail.results" @refresh="refresh([$event])" />

      <section v-if="!isHistorical" class="refinement-panel">
        <div class="refinement-label"><span class="eyebrow signal-text">Continue the analysis</span><h2>What should change?</h2></div>
        <div>
          <textarea v-model="prompt" rows="3" maxlength="4000" placeholder="Add a market-level view, focus the narrative on running products, or replace the price chart…" @keydown.meta.enter="refine" @keydown.ctrl.enter="refine"></textarea>
          <label class="analysis-option">
            <input v-model="detailedTrail" type="checkbox" :disabled="working" />
            <span>
              <strong>Show detailed analysis trail</strong>
              <small>Each role's questions, DuckDB SQL, result shape, and validation checks—not private reasoning.</small>
            </span>
          </label>
          <div class="composer-actions"><span>Creates immutable revision {{ detail.revision.revisionNumber + 1 }}</span><button class="signal-button" :disabled="working || prompt.trim().length < 5" @click="refine">Refine fieldboard ↗</button></div>
          <p v-if="error" class="error-message" role="alert">{{ error }}</p>
          <AnalysisTrail v-if="events.length" :events="events" :active="working" :detailed="detailedTrail" />
        </div>
      </section>
    </template>
  </div>
</template>
