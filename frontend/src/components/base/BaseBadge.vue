<script setup lang="ts">
import { computed } from 'vue'

/// A pill. Text always carries the meaning; colour only reinforces it.
const props = withDefaults(
  defineProps<{ tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'violet' | 'dormant' }>(),
  { tone: 'neutral' },
)

const tones: Record<string, string> = {
  neutral: 'bg-line-100 text-ink-600',
  dormant: 'bg-line-100 text-ink-500',
  ok: 'bg-success-50 text-success-600',
  warn: 'bg-warning-50 text-warning-600',
  bad: 'bg-danger-50 text-danger-600',
  info: 'bg-info-50 text-info-600',
  violet: 'bg-violet-50 text-violet-600',
  accent: 'bg-primary-50 text-primary-700',
}
const cls = computed(() => tones[props.tone])
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full px-2.5 py-[3px] text-[12px] font-semibold leading-4 whitespace-nowrap"
    :class="cls"
  >
    <slot />
  </span>
</template>
