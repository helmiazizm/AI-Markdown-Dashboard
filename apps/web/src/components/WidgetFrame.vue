<script setup lang="ts">
import type { DatasetSpec, QueryResultSnapshot, WidgetSpec } from '@fieldboard/contracts'
import { ref } from 'vue'
import D3Widget from './D3Widget.vue'
import EChartsWidget from './EChartsWidget.vue'

defineProps<{ widget: WidgetSpec; dataset: DatasetSpec; result?: QueryResultSnapshot }>()
defineEmits<{ refresh: [datasetId: string] }>()
const inspecting = ref(false)

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
</script>

<template>
  <figure class="widget-frame">
    <figcaption class="widget-heading">
      <div>
        <h3>{{ widget.title }}</h3>
        <p>{{ widget.description }}</p>
      </div>
      <button class="quiet-button" :aria-expanded="inspecting" @click="inspecting = !inspecting">
        {{ inspecting ? 'Close evidence' : 'Inspect evidence' }}
      </button>
    </figcaption>

    <div v-if="result" class="widget-visual">
      <EChartsWidget v-if="widget.engine === 'echarts'" :widget="widget" :result="result" />
      <D3Widget v-else :widget="widget" :result="result" />
    </div>
    <div v-else class="widget-missing"><span>NO CACHED RESULT</span><p>Refresh this dataset to render the chart.</p></div>

    <div v-if="inspecting" class="evidence-drawer">
      <div class="evidence-meta">
        <div><span>Question</span><strong>{{ dataset.question }}</strong></div>
        <div><span>Dataset</span><strong>{{ dataset.id }}</strong></div>
        <div><span>Renderer</span><strong>{{ widget.engine.toUpperCase() }}</strong></div>
        <div><span>Rows</span><strong>{{ result?.rowCount ?? 0 }}{{ result?.truncated ? '+' : '' }}</strong></div>
        <div><span>Snapshot</span><strong>{{ result?.sourceSnapshot.snapshotDate ?? '—' }}</strong></div>
        <div><span>Refreshed</span><strong>{{ result ? formatTime(result.createdAt) : '—' }}</strong></div>
      </div>
      <div class="sql-block">
        <div><span>DUCKDB SQL</span><button class="text-button" @click="$emit('refresh', dataset.id)">Refresh dataset ↻</button></div>
        <pre><code>{{ dataset.sql }}</code></pre>
      </div>
      <div v-if="result?.rows.length" class="fallback-table" tabindex="0" aria-label="Accessible chart data table">
        <table>
          <thead><tr><th v-for="column in result.columns" :key="column">{{ column }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, rowIndex) in result.rows.slice(0, 12)" :key="rowIndex">
              <td v-for="column in result.columns" :key="column">{{ row[column] ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </figure>
</template>
