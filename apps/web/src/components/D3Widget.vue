<script setup lang="ts">
import type { D3WidgetSpec, QueryResultSnapshot } from '@fieldboard/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { parseD3BridgeMessage } from '../lib/d3-bridge.js'

const props = defineProps<{ widget: D3WidgetSpec; result: QueryResultSnapshot }>()
const iframe = ref<HTMLIFrameElement>()
const channel = crypto.randomUUID()
let observer: ResizeObserver | undefined

function escapedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

const source = computed(() => {
  const origin = location.origin
  const script = escapedJson(props.widget.script)
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${origin}/vendor/d3.min.js; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<style>html,body,#chart{width:100%;height:100%;margin:0;overflow:hidden;background:#15140f}*{box-sizing:border-box}</style>
<script src="${origin}/vendor/d3.min.js"><\/script></head><body><div id="chart"></div>
<script>'use strict';
const CHANNEL=${escapedJson(channel)}; const EXPECTED_ORIGIN=${escapedJson(origin)}; const USER_SCRIPT=${script};
let resizeHandler=null; let lastPayload=null;
const tooltip={show:(payload)=>send('tooltip',payload),hide:()=>send('tooltip',null)};
const emit=(name,payload)=>send('interaction',{name,payload});
const onResize=(handler)=>{if(typeof handler==='function') resizeHandler=handler};
function send(type,payload){parent.postMessage({channel:CHANNEL,type,payload},'*')}
function render(payload){
  lastPayload=payload;
  const container=document.getElementById('chart');
  try {
    const run=new Function('data','container','width','height','theme','tooltip','emit','onResize','d3','"use strict";\\n'+USER_SCRIPT);
    run(payload.data,container,payload.width,payload.height,payload.theme,tooltip,emit,onResize,d3);
    send('ready',{height:payload.height});
  } catch(error){send('error',{message:error instanceof Error?error.message:String(error)})}
}
addEventListener('message',(event)=>{
  if(event.source!==parent || event.origin!==EXPECTED_ORIGIN) return;
  const message=event.data;
  if(!message || message.channel!==CHANNEL) return;
  if(message.type==='render') render(message.payload);
  if(message.type==='resize' && lastPayload){
    lastPayload={...lastPayload,...message.payload};
    if(resizeHandler) resizeHandler(lastPayload.width,lastPayload.height); else render(lastPayload);
  }
});
send('boot',null);
<\/script></body></html>`
})

const error = ref('')

function payload(): Record<string, unknown> {
  const width = Math.max(320, iframe.value?.clientWidth ?? 640)
  return {
    // Vue wraps result rows in reactive proxies, which postMessage cannot clone.
    data: JSON.parse(JSON.stringify(props.result.rows)) as Record<string, unknown>[],
    width,
    height: props.widget.height,
    theme: { background: '#15140f', text: '#f3eee3', muted: '#969083', signal: '#f5a300', rule: '#312e26', mono: 'Sometype Mono, monospace' },
  }
}

function post(type: string): void {
  iframe.value?.contentWindow?.postMessage({ channel, type, payload: payload() }, '*')
}

function onMessage(event: MessageEvent): void {
  const message = parseD3BridgeMessage(event, iframe.value?.contentWindow, channel)
  if (!message) return
  if (message.type === 'boot') post('render')
  if (message.type === 'error') {
    const candidate = message.payload as { message?: unknown }
    error.value = typeof candidate?.message === 'string' ? candidate.message.slice(0, 240) : 'D3 renderer failed.'
  }
}

onMounted(async () => {
  window.addEventListener('message', onMessage)
  await nextTick()
  if (iframe.value) {
    observer = new ResizeObserver(() => post('resize'))
    observer.observe(iframe.value)
  }
})

watch(() => [props.widget, props.result], () => post('render'), { deep: true })
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  observer?.disconnect()
})
</script>

<template>
  <div class="d3-host">
    <iframe
      ref="iframe"
      title="Sandboxed D3 visualization"
      sandbox="allow-scripts"
      :srcdoc="source"
      :style="{ height: `${widget.height}px` }"
    ></iframe>
    <p v-if="error" class="chart-error" role="alert">{{ error }}</p>
  </div>
</template>
