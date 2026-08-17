<script setup lang="ts">
import type { EChartsWidgetSpec, QueryResultSnapshot } from '@fieldboard/contracts'
import type { ECharts, EChartsOption } from 'echarts'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { prepareEChartsOption } from '../lib/echarts.js'

const props = defineProps<{ widget: EChartsWidgetSpec; result: QueryResultSnapshot }>()
const root = ref<HTMLDivElement>()
let chart: ECharts | undefined
let echarts: typeof import('echarts') | undefined
let observer: ResizeObserver | undefined

async function render(): Promise<void> {
  if (!root.value) return
  echarts ??= await import('echarts')
  chart ??= echarts.init(root.value, undefined, { renderer: 'canvas' })
  const hostOption: EChartsOption = {
    backgroundColor: 'transparent',
    color: ['#f5a300', '#f3eee3', '#8f6c2c', '#777166', '#cfc5b1'],
    textStyle: { color: '#969083', fontFamily: 'Sometype Mono, monospace' },
    dataset: { dimensions: props.result.columns, source: props.result.rows },
    aria: { enabled: true, description: props.widget.accessibilityText },
    animationDuration: 500,
    animationEasing: 'cubicOut',
  }
  chart.setOption({ ...prepareEChartsOption(props.widget.option), ...hostOption } as EChartsOption, { notMerge: true })
}

onMounted(async () => {
  await nextTick()
  await render()
  if (root.value) {
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(root.value)
  }
})

watch(() => [props.widget, props.result], () => void render(), { deep: true })
onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
})
</script>

<template>
  <div ref="root" class="chart-canvas" :style="{ height: `${widget.height}px` }" role="img" :aria-label="widget.accessibilityText"></div>
</template>
