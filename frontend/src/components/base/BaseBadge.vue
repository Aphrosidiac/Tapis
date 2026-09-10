<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(defineProps<{ tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'dormant' | 'accent' }>(), { tone: 'neutral' })
const classes = computed(() => {
  const tones: Record<string, string> = {
    neutral: 'border-line text-muted bg-surface',
    ok: 'border-ok/40 text-ok bg-ok/12',
    warn: 'border-warn/40 text-warn bg-warn/12',
    bad: 'border-bad/40 text-bad bg-bad/12',
    info: 'border-info/40 text-info bg-info/12',
    accent: 'border-accent/40 text-accent-strong bg-accent-soft',
    dormant: 'border-dormant text-ink bg-dormant/60',
  }
  return `inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide whitespace-nowrap ${tones[props.tone]}`
})
</script>

<template>
  <span :class="classes"><slot /></span>
</template>
