<script setup lang="ts">
import type { GenerationEvent } from '@fieldboard/contracts'

defineProps<{ events: GenerationEvent[]; active?: boolean; detailed?: boolean }>()

const labels: Record<GenerationEvent['type'], string> = {
  queued: 'Queued',
  inspecting: 'Inspecting',
  querying: 'Querying',
  composing: 'Composing',
  validating: 'Validating',
  publishing: 'Publishing',
  publication_blocked: 'Publication blocked',
  completed: 'Complete',
  failed: 'Failed',
}

const detailKinds = new Set([
  'run_config', 'source_context', 'query_plan', 'query_result', 'query_error',
  'artifact_summary', 'artifact_error', 'final_validation', 'dataset_validation', 'dataset_result',
])

function kind(event: GenerationEvent): string {
  return typeof event.payload?.kind === 'string' ? event.payload.kind : ''
}

function hasDetail(event: GenerationEvent): boolean {
  return detailKinds.has(kind(event))
}

function textValue(event: GenerationEvent, key: string): string {
  const value = event.payload?.[key]
  return typeof value === 'string' ? value : ''
}

function numberValue(event: GenerationEvent, key: string): number | undefined {
  const value = event.payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textList(event: GenerationEvent, key: string): string[] {
  const value = event.payload?.[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function formatCount(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString()
}
</script>

<template>
  <section class="analysis-trail" aria-live="polite" aria-label="Generation progress">
    <div v-for="(event, index) in events" :key="event.id" class="trail-step" :class="{ 'is-latest': index === events.length - 1 && active }">
      <span class="trail-node" aria-hidden="true"></span>
      <div class="trail-copy">
        <span class="eyebrow">{{ labels[event.type] }}</span>
        <p class="trail-message">{{ event.message }}</p>

        <div v-if="detailed && hasDetail(event)" class="trail-detail">
          <p v-if="kind(event) === 'run_config'" class="trail-boundary">
            Detailed mode reports tool activity and evidence checks. The model’s private reasoning is never streamed or stored.
          </p>

          <template v-else-if="kind(event) === 'source_context'">
            <dl class="trail-stats">
              <div><dt>Catalog</dt><dd>{{ textList(event, 'relations').join(' · ') || textValue(event, 'datasetName') || 'Warehouse catalog' }}</dd></div>
              <div><dt>Snapshot</dt><dd>{{ textValue(event, 'snapshotDate') || 'Active' }}</dd></div>
              <div><dt>Rows</dt><dd>{{ formatCount(numberValue(event, 'rowCount')) }}</dd></div>
              <div><dt>Relations</dt><dd>{{ formatCount(numberValue(event, 'relationCount')) }}</dd></div>
            </dl>
            <p class="trail-note">{{ textValue(event, 'grain') }}</p>
            <ul v-if="textList(event, 'cautions').length" class="trail-cautions">
              <li v-for="caution in textList(event, 'cautions')" :key="caution">{{ caution }}</li>
            </ul>
          </template>

          <template v-else-if="kind(event) === 'query_plan' || kind(event) === 'dataset_validation'">
            <div class="trail-tags">
              <span v-if="numberValue(event, 'queryNumber')">Query {{ numberValue(event, 'queryNumber') }}</span>
              <span v-if="textValue(event, 'datasetId')">{{ textValue(event, 'datasetId') }}</span>
              <span>Limit {{ formatCount(numberValue(event, 'maxRows')) }}</span>
            </div>
            <p v-if="textValue(event, 'question')" class="trail-question">{{ textValue(event, 'question') }}</p>
            <details class="trail-sql" open>
              <summary>DuckDB SQL</summary>
              <pre><code>{{ textValue(event, 'sql') }}</code></pre>
            </details>
            <p class="trail-columns">Expected · {{ textList(event, 'expectedColumns').join(' · ') }}</p>
          </template>

          <template v-else-if="kind(event) === 'query_result' || kind(event) === 'dataset_result'">
            <div class="trail-tags">
              <span v-if="numberValue(event, 'queryNumber')">Query {{ numberValue(event, 'queryNumber') }}</span>
              <span v-if="textValue(event, 'datasetId')">{{ textValue(event, 'datasetId') }}</span>
              <span>{{ formatCount(numberValue(event, 'rowCount')) }} rows</span>
              <span>{{ textList(event, 'columns').length }} columns</span>
              <span v-if="event.payload?.truncated === true">Truncated</span>
              <span v-else>Complete result</span>
            </div>
            <p class="trail-columns">Returned · {{ textList(event, 'columns').join(' · ') }}</p>
          </template>

          <template v-else-if="kind(event) === 'artifact_summary' || kind(event) === 'final_validation'">
            <p v-if="textValue(event, 'title')" class="trail-question">{{ textValue(event, 'title') }}</p>
            <div class="trail-tags">
              <span>{{ formatCount(numberValue(event, 'datasetCount')) }} datasets</span>
              <span>{{ formatCount(numberValue(event, 'widgetCount')) }} widgets</span>
              <span v-for="renderer in textList(event, 'renderers')" :key="renderer">{{ renderer }}</span>
            </div>
          </template>

          <p v-else-if="kind(event) === 'query_error' || kind(event) === 'artifact_error'" class="trail-error-detail">
            {{ textValue(event, 'error') }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
