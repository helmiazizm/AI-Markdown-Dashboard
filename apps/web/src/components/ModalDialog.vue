<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = defineProps<{ open: boolean; title: string; description?: string }>()
const emit = defineEmits<{ close: [] }>()

const titleId = useId()
const descriptionId = useId()
const shell = ref<HTMLElement | null>(null)
let restoreTo: HTMLElement | null = null
let previousOverflow = ''

// `summary` belongs in the trap: the analysis trail ships <details> SQL disclosures, and Tab would
// otherwise walk straight out of the dialog through an open one.
const FOCUSABLE = 'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const host = shell.value
  if (!host) return
  const nodes = [...host.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (!first || !last) {
    event.preventDefault()
    host.focus()
    return
  }
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === host)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function release(): void {
  document.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = previousOverflow
}

watch(() => props.open, async (open) => {
  if (open) {
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Capture phase so the dialog wins Escape over any ancestor handler.
    document.addEventListener('keydown', onKeydown, true)
    await nextTick()
    shell.value?.focus()
    return
  }
  release()
  restoreTo?.focus()
  restoreTo = null
})

onBeforeUnmount(release)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-scrim" @click.self="emit('close')">
      <div
        ref="shell"
        class="modal-shell"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        tabindex="-1"
      >
        <header class="modal-heading">
          <div>
            <h2 :id="titleId">{{ title }}</h2>
            <p v-if="description" :id="descriptionId">{{ description }}</p>
          </div>
          <button class="text-button" @click="emit('close')">Close ×</button>
        </header>
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.actions" class="modal-actions"><slot name="actions" /></footer>
      </div>
    </div>
  </Teleport>
</template>
