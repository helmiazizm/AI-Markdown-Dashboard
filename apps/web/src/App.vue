<script setup lang="ts">
import type { HealthResponse } from '@fieldboard/contracts'
import { computed, onMounted, ref } from 'vue'
import { api } from './lib/api.js'

const health = ref<HealthResponse | null>(null)

// The footer used to name a single hardcoded adapter, which went stale the moment a second
// pipeline existed. Report whatever the API is actually configured to run.
const PIPELINE_LABELS: Record<string, string> = {
  crew: 'Crew ↗ OpenRouter',
  cline: 'Single agent ↗ OpenRouter',
  demo: 'Deterministic demo',
}

const pipelineLabel = computed(() => {
  const mode = health.value?.agentMode
  return mode ? PIPELINE_LABELS[mode] ?? mode : 'Agent ↗ OpenRouter'
})

const snapshotLabel = computed(() => {
  const date = health.value?.activeSnapshot?.snapshotDate
  return date ? `Snapshot ${date}` : 'Snapshot —'
})

onMounted(async () => {
  try {
    health.value = await api.health()
  } catch {
    // The footer is decorative; a failed probe leaves the neutral fallbacks in place.
  }
})
</script>

<template>
  <div class="app-shell">
    <header class="site-header">
      <RouterLink class="wordmark" to="/" aria-label="Fieldboard home">
        <span class="wordmark-mark" aria-hidden="true">F/B</span>
        <span>Fieldboard</span>
      </RouterLink>
      <nav class="system-navigation" aria-label="System navigation">
        <RouterLink to="/repository">Repository sync</RouterLink>
        <div class="system-readout"><span class="pulse-dot" aria-hidden="true"></span>Local analytical instrument</div>
      </nav>
    </header>
    <main><RouterView /></main>
    <footer class="site-footer">
      <span>DuckDB ↗ MinIO</span><span>{{ pipelineLabel }}</span><span>{{ snapshotLabel }}</span>
    </footer>
  </div>
</template>
