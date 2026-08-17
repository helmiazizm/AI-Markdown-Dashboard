<script setup lang="ts">
import type { DashboardArtifactV1, QueryResultSnapshot } from '@fieldboard/contracts'
import { computed } from 'vue'
import { renderDashboardMarkdown } from '../lib/markdown.js'
import WidgetFrame from './WidgetFrame.vue'

const props = defineProps<{ artifact: DashboardArtifactV1; results: QueryResultSnapshot[] }>()
defineEmits<{ refresh: [datasetId: string] }>()

const segments = computed(() => renderDashboardMarkdown(props.artifact.markdown))
const widgets = computed(() => new Map(props.artifact.widgets.map((widget) => [widget.id, widget])))
const datasets = computed(() => new Map(props.artifact.datasets.map((dataset) => [dataset.id, dataset])))
const results = computed(() => new Map(props.results.map((result) => [result.datasetId, result])))
</script>

<template>
  <article class="dashboard-document">
    <template v-for="(segment, index) in segments" :key="`${segment.type}-${index}`">
      <div v-if="segment.type === 'html'" class="markdown-prose" v-html="segment.html"></div>
      <WidgetFrame
        v-else-if="widgets.get(segment.widgetId) && datasets.get(widgets.get(segment.widgetId)!.datasetId)"
        :widget="widgets.get(segment.widgetId)!"
        :dataset="datasets.get(widgets.get(segment.widgetId)!.datasetId)!"
        :result="results.get(widgets.get(segment.widgetId)!.datasetId)"
        @refresh="$emit('refresh', $event)"
      />
    </template>
  </article>
</template>
