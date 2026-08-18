<script setup lang="ts">
import type { GenerationEvent } from '@fieldboard/contracts'
import { computed } from 'vue'

const props = defineProps<{ events: GenerationEvent[]; active?: boolean; detailed?: boolean }>()

const roleNames: Record<string, string> = {
  planner: 'Planner',
  analysis: 'Analyst',
  layout: 'Designer',
  reviewer: 'Reviewer',
}

function role(event: GenerationEvent): string {
  return typeof event.payload?.role === 'string' ? event.payload.role : ''
}

function roleName(event: GenerationEvent): string {
  const value = role(event)
  return value ? roleNames[value] ?? value : ''
}

const PHASES = [
  { key: 'intake', label: '' },
  { key: 'planning', label: 'Planning' },
  { key: 'parallel', label: 'Analysing and designing, in parallel' },
  { key: 'review', label: 'Senior review' },
  { key: 'publication', label: 'Validation and publication' },
] as const

function phaseOf(event: GenerationEvent): typeof PHASES[number]['key'] {
  const owner = role(event)
  if (owner === 'planner' || event.type === 'planning') return 'planning'
  if (owner === 'analysis' || owner === 'layout' || event.type === 'designing') return 'parallel'
  if (owner === 'reviewer' || event.type === 'reviewing') return 'review'
  if (['validating', 'publishing', 'publication_blocked', 'completed', 'failed'].includes(event.type)) return 'publication'
  return 'intake'
}

/**
 * Only a crew run carries roles or the crew-only stages, so a single-agent run keeps today's flat
 * chronological trail: one unlabelled group containing every event, in arrival order.
 */
const isCrewRun = computed(() => props.events.some((event) =>
  role(event) !== '' || event.type === 'planning' || event.type === 'designing' || event.type === 'reviewing'))

const groups = computed(() => {
  if (!isCrewRun.value) return [{ key: 'all', label: '', parallel: false, steps: props.events }]
  return PHASES
    .map((phase) => ({
      key: phase.key,
      label: phase.label,
      parallel: phase.key === 'parallel',
      steps: props.events.filter((event) => phaseOf(event) === phase.key),
    }))
    .filter((group) => group.steps.length > 0)
})

const lastEventId = computed(() => props.events[props.events.length - 1]?.id)

const labels: Record<GenerationEvent['type'], string> = {
  queued: 'Queued',
  inspecting: 'Inspecting',
  planning: 'Planning',
  querying: 'Querying',
  designing: 'Designing',
  composing: 'Composing',
  reviewing: 'Reviewing',
  validating: 'Validating',
  publishing: 'Publishing',
  publication_blocked: 'Publication blocked',
  completed: 'Complete',
  failed: 'Failed',
}

const detailKinds = new Set([
  'run_config', 'source_context', 'query_plan', 'query_result', 'query_error',
  'artifact_summary', 'artifact_error', 'final_validation', 'dataset_validation', 'dataset_result',
  'crew_plan', 'crew_analysis', 'crew_layout', 'crew_layout_fallback', 'crew_review_fallback',
  'revision_context', 'crew_change_plan',
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

function briefDatasets(event: GenerationEvent): { id: string; expectedColumns: string[] }[] {
  const value = event.payload?.datasets
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const { id, expectedColumns } = entry as { id?: unknown; expectedColumns?: unknown }
    if (typeof id !== 'string' || !Array.isArray(expectedColumns)) return []
    return [{ id, expectedColumns: expectedColumns.filter((column): column is string => typeof column === 'string') }]
  })
}
</script>

<template>
  <section class="analysis-trail" aria-live="polite" aria-label="Generation progress">
    <div v-for="group in groups" :key="group.key" class="trail-phase" :class="{ 'is-parallel': group.parallel }">
      <h3 v-if="group.label" class="trail-phase-label">{{ group.label }}</h3>
      <div v-for="event in group.steps" :key="event.id" class="trail-step" :class="{ 'is-latest': event.id === lastEventId && active }">
      <span class="trail-node" aria-hidden="true"></span>
      <div class="trail-copy">
        <span class="eyebrow">
          <span v-if="roleName(event)" class="trail-role">{{ roleName(event) }}</span>{{ labels[event.type] }}
        </span>
        <p class="trail-message">{{ event.message }}</p>

        <div v-if="detailed && hasDetail(event)" class="trail-detail">
          <p v-if="kind(event) === 'run_config'" class="trail-boundary">
            <template v-if="textValue(event, 'pipeline')">
              Pipeline <strong>{{ textValue(event, 'pipeline') }}</strong><template v-if="textValue(event, 'model')"> · {{ textValue(event, 'model') }}</template>.
            </template>
            Detailed mode reports each role’s tool activity and evidence checks. No role’s private reasoning is streamed or stored.
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

          <template v-else-if="kind(event) === 'revision_context'">
            <div class="trail-tags">
              <span>revision {{ formatCount(numberValue(event, 'baseRevisionNumber')) }} is the base</span>
              <span>{{ formatCount(numberValue(event, 'datasetCount')) }} datasets</span>
              <span>{{ formatCount(numberValue(event, 'widgetCount')) }} widgets</span>
            </div>
            <p v-if="textValue(event, 'priorPrompts')" class="trail-prompt-trail">{{ textValue(event, 'priorPrompts') }}</p>
          </template>

          <template v-else-if="kind(event) === 'crew_change_plan'">
            <div class="trail-tags">
              <span v-if="textList(event, 'kept').length">keeping {{ textList(event, 'kept').join(', ') }}</span>
              <span v-if="textList(event, 'modified').length">changing {{ textList(event, 'modified').join(', ') }}</span>
              <span v-if="textList(event, 'added').length">adding {{ textList(event, 'added').join(', ') }}</span>
              <span v-if="textList(event, 'removed').length">removing {{ textList(event, 'removed').join(', ') }}</span>
            </div>
            <p v-if="textValue(event, 'narrativeChanges')" class="trail-note">{{ textValue(event, 'narrativeChanges') }}</p>
            <p v-else class="trail-note">Anything kept is carried over from the published revision unchanged.</p>
          </template>

          <template v-else-if="kind(event) === 'crew_plan'">
            <p class="trail-question">{{ textValue(event, 'decisionQuestion') }}</p>
            <div class="trail-tags">
              <span v-for="dataset in briefDatasets(event)" :key="dataset.id">{{ dataset.id }} · {{ dataset.expectedColumns.join(', ') }}</span>
            </div>
            <p class="trail-note">The analyst and the designer are both bound to these column contracts.</p>
          </template>

          <template v-else-if="kind(event) === 'crew_analysis'">
            <p class="trail-question">{{ textValue(event, 'headline') }}</p>
            <ul v-if="textList(event, 'cannotEstablish').length" class="trail-cautions">
              <li v-for="limit in textList(event, 'cannotEstablish')" :key="limit">Not established: {{ limit }}</li>
            </ul>
          </template>

          <template v-else-if="kind(event) === 'crew_layout'">
            <div class="trail-tags">
              <span>{{ formatCount(numberValue(event, 'widgetCount')) }} widgets</span>
              <span>{{ formatCount(numberValue(event, 'outlineBlocks')) }} outline blocks</span>
            </div>
            <p v-if="textValue(event, 'designNotes')" class="trail-note">{{ textValue(event, 'designNotes') }}</p>
          </template>

          <p v-else-if="kind(event) === 'query_error' || kind(event) === 'artifact_error' || kind(event) === 'crew_layout_fallback' || kind(event) === 'crew_review_fallback'" class="trail-error-detail">
            {{ textValue(event, 'error') }}
          </p>
        </div>
      </div>
      </div>
    </div>
  </section>
</template>
