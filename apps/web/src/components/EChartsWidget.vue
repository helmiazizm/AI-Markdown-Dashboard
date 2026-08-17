<script setup lang="ts">
import type { EChartsWidgetSpec, QueryResultSnapshot } from '@fieldboard/contracts'
import type { ECharts, EChartsOption } from 'echarts'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { HOST_PALETTE, HOST_TEXT_STYLE, prepareEChartsOption, withSanctionedPalette } from '../lib/echarts.js'

const props = defineProps<{ widget: EChartsWidgetSpec; result: QueryResultSnapshot }>()
const root = ref<HTMLDivElement>()
let chart: ECharts | undefined
let echarts: typeof import('echarts') | undefined
let observer: ResizeObserver | undefined

async function render(): Promise<void> {
  if (!root.value) return
  echarts ??= await import('echarts')
  chart ??= echarts.init(root.value, undefined, { renderer: 'canvas' })
  // Presentation keys are host defaults the author may override; dataset, aria, and the
  // transparent background stay host-owned so rows and alt text can only come from us.
  chart.setOption({
    color: HOST_PALETTE,
    textStyle: HOST_TEXT_STYLE,
    animationDuration: 500,
    animationEasing: 'cubicOut',
    ...withSanctionedPalette(prepareEChartsOption(props.widget.option)),
    backgroundColor: 'transparent',
    dataset: { dimensions: props.result.columns, source: props.result.rows },
    aria: { enabled: true, description: props.widget.accessibilityText },
  } as EChartsOption, { notMerge: true })
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
