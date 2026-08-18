<script setup lang="ts">
import type { DashboardListItem, GenerationEvent, HealthResponse } from '@fieldboard/contracts'
import { onBeforeUnmount, onMounted, computed, ref } from 'vue'
import AnalysisTrail from '../components/AnalysisTrail.vue'
import ModalDialog from '../components/ModalDialog.vue'
import { api, followGeneration } from '../lib/api.js'

const prompt = ref('')
const dashboards = ref<DashboardListItem[]>([])
const health = ref<HealthResponse | null>(null)
const catalogStamp = computed(() => {
  const names = health.value?.relations?.map((relation) => relation.qualifiedName) ?? []
  if (names.length) return names.join(' · ')
  return `${health.value?.activeSnapshot?.datasetName ?? 'governed catalog'} · ${health.value?.activeSnapshot?.snapshotDate ?? 'no snapshot'}`
})
const events = ref<GenerationEvent[]>([])
const generating = ref(false)
const trailOpen = ref(false)
const completedId = ref('')
const completed = ref<DashboardListItem | null>(null)
const error = ref('')
let stopFollowing: (() => void) | undefined

const latestEvent = computed(() => events.value[events.value.length - 1])
const statusLine = computed(() => latestEvent.value?.message ?? 'Assembling the analysis crew…')
const statusStage = computed(() => latestEvent.value?.type.replace('_', ' ') ?? 'queued')
const runVisible = computed(() => generating.value || events.value.length > 0)

onMounted(async () => {
  const [list, status] = await Promise.allSettled([api.listDashboards(), api.health()])
  if (list.status === 'fulfilled') dashboards.value = list.value.items
  if (status.status === 'fulfilled') health.value = status.value
})

onBeforeUnmount(() => stopFollowing?.())

async function generate(): Promise<void> {
  if (generating.value || prompt.value.trim().length < 5) return
  stopFollowing?.()
  error.value = ''
  events.value = []
  completed.value = null
  completedId.value = ''
  generating.value = true
  try {
    // The trail is always captured now: the server only attaches structured payloads at the
    // detailed level, and the trail is reviewed after the fact rather than opted into up front.
    const run = await api.createGeneration(prompt.value.trim(), 'detailed')
    stopFollowing = followGeneration(
      run.id,
      (event) => {
        if (!events.value.some((existing) => existing.id === event.id)) events.value.push(event)
      },
      async (status) => {
        generating.value = false
        if (status.status !== 'completed' || !status.dashboardId) {
          error.value = status.error ?? 'Generation failed.'
          return
        }
        completedId.value = status.dashboardId
        // One list refresh both republishes the archive below and supplies the finished
        // fieldboard's identity for the success panel, which the run status does not carry.
        const list = await api.listDashboards().catch(() => null)
        if (list) dashboards.value = list.items
        completed.value = list?.items.find((item) => item.id === status.dashboardId) ?? null
      },
      (reason) => {
        generating.value = false
        error.value = reason.message
      },
    )
  } catch (reason) {
    generating.value = false
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

function startAnother(): void {
  completed.value = null
  completedId.value = ''
  events.value = []
  prompt.value = ''
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
</script>

<template>
  <div class="landing-page">
    <section class="hero content-grid">
      <div class="hero-index" aria-hidden="true">01<br />PROMPT</div>
      <div class="hero-copy">
        <p class="eyebrow signal-text">Agentic dashboard studio</p>
        <h1>Ask your data.<br /><em>Keep the evidence.</em></h1>
        <p class="hero-deck">Turn a plain-language business question into a durable analytical fieldbook—planned, analysed, and designed by a crew working in parallel over governed DuckDB catalogs, reviewed before it ships, and saved with its provenance intact.</p>
      </div>
      <div class="snapshot-stamp" :class="{ 'is-ready': health?.status === 'ok' }">
        <span>{{ health?.status === 'ok' ? 'DATA READY' : 'CHECKING DATA' }}</span>
        <strong>{{ health?.activeSnapshot?.rowCount.toLocaleString() ?? '—' }}</strong>
        <small>{{ catalogStamp }}</small>
      </div>
    </section>

    <RouterLink
      class="repository-strip"
      to="/repository"
      :data-state="health?.repository?.readiness ?? 'checking'"
      aria-label="Open repository sync center"
    >
      <span class="repository-strip-mark" aria-hidden="true"></span>
      <strong>Canonical content</strong>
      <span>{{ health?.repository?.readiness?.replace('_', ' ') ?? 'checking' }}</span>
      <code>{{ health?.repository?.head?.slice(0, 10) ?? 'no commit' }}</code>
      <span class="repository-strip-action">Review repository ↗</span>
    </RouterLink>

    <section class="composer-panel content-grid" aria-label="New dashboard generation">
      <div class="section-index" aria-hidden="true">A/01</div>
      <div class="composer-main">
        <label id="new-dashboard-heading" for="dashboard-prompt">What should we investigate?</label>
        <textarea
          id="dashboard-prompt"
          v-model="prompt"
          rows="3"
          maxlength="4000"
          placeholder="Summarize the most important patterns, compare the relevant segments, and call out unusual changes…"
          :disabled="generating"
          @keydown.meta.enter="generate"
          @keydown.ctrl.enter="generate"
        ></textarea>
        <div class="composer-actions">
          <span>⌘ ↵ to generate · governed queries only · full trail captured</span>
          <button class="signal-button" :disabled="generating || prompt.trim().length < 5" @click="generate">
            <span>{{ generating ? 'Running analysis' : 'Generate fieldboard' }}</span><span aria-hidden="true">↗</span>
          </button>
        </div>

        <div v-if="runVisible" class="run-status" :class="{ 'is-live': generating }">
          <span class="run-status-mark" aria-hidden="true"></span>
          <p class="run-status-line" role="status">
            <span class="run-status-stage">{{ statusStage }}</span>{{ statusLine }}
          </p>
          <button class="text-button" :disabled="!events.length" @click="trailOpen = true">
            View analysis trail · {{ events.length }}
          </button>
        </div>

        <p v-if="error" class="error-message" role="alert">{{ error }}</p>

        <div v-if="completedId" class="run-complete">
          <div class="run-complete-copy">
            <span class="eyebrow signal-text">Fieldboard ready</span>
            <strong>{{ completed?.title ?? 'Your fieldboard' }}</strong>
            <p>{{ completed?.summary ?? prompt }}</p>
            <div class="run-complete-meta">
              <span>REV {{ completed?.revisionNumber ?? 1 }}</span>
              <span>{{ completed?.widgetCount ?? 0 }} WIDGETS</span>
              <span>{{ completed?.gitCommitSha?.slice(0, 8) ?? 'UNCOMMITTED' }}</span>
            </div>
          </div>
          <div class="run-complete-actions">
            <RouterLink class="signal-button" :to="`/dashboards/${completedId}`">
              <span>Open dashboard</span><span aria-hidden="true">↗</span>
            </RouterLink>
            <button class="text-button" @click="startAnother">Start another</button>
          </div>
        </div>
      </div>
      <aside class="composer-note">
        <span class="eyebrow">Bounded crew</span>
        <p>Planner<br />Analyst ∥ Designer<br />Senior review</p>
        <small>The analyst and designer work in parallel against one column contract. No shell, filesystem, or web tools.</small>
      </aside>
    </section>

    <ModalDialog
      :open="trailOpen"
      title="Analysis trail"
      description="Each role's questions, DuckDB SQL, result shape, and validation checks—not private reasoning."
      @close="trailOpen = false"
    >
      <AnalysisTrail v-if="events.length" :events="events" :active="generating" :detailed="true" />
    </ModalDialog>

    <section class="library-section">
      <div class="section-heading content-grid">
        <div class="section-index" aria-hidden="true">02</div>
        <div>
          <p class="eyebrow">Saved work</p>
          <h2>Dashboard library</h2>
        </div>
        <p>{{ dashboards.length }} analytical document{{ dashboards.length === 1 ? '' : 's' }}</p>
      </div>

      <div v-if="dashboards.length" class="dashboard-list">
        <RouterLink v-for="(dashboard, index) in dashboards" :key="dashboard.id" :to="`/dashboards/${dashboard.id}`" class="dashboard-row">
          <span class="row-number">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="dashboard-row-copy">
            <h3>{{ dashboard.title }}</h3>
            <p>“{{ dashboard.prompt }}”</p>
          </div>
          <div class="dashboard-row-meta">
            <span>REV {{ dashboard.revisionNumber }}</span>
            <span>{{ dashboard.widgetCount }} WIDGETS</span>
            <span>{{ dashboard.gitCommitSha?.slice(0, 8) ?? 'LEGACY' }}</span>
            <time :datetime="dashboard.updatedAt">{{ formatDate(dashboard.updatedAt) }}</time>
          </div>
          <span class="row-arrow" aria-hidden="true">↗</span>
        </RouterLink>
      </div>
      <div v-else class="empty-library">
        <span class="empty-cross" aria-hidden="true">＋</span>
        <p>No fieldboards yet. Your first prompt will establish the archive.</p>
      </div>
    </section>
  </div>
</template>
