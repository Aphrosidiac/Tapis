<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    value: string | number
    hint?: string
    tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'
  }>(),
  { tone: 'neutral' },
)
const color: Record<string, string> = {
  neutral: 'text-ink-900',
  ok: 'text-success-600',
  warn: 'text-warning-600',
  bad: 'text-danger-600',
  accent: 'text-primary-700',
}
</script>

<template>
  <div class="card p-5">
    <!-- `.eyebrow` is nowrap because a wrapped TABLE header misaligns its
         column. A stat label has no column to misalign and a long one is
         clipped at the card edge on a phone, so it wraps here. -->
    <p class="eyebrow whitespace-normal">{{ label }}</p>
    <p class="num mt-2 text-[26px] font-semibold leading-8 tracking-[-0.01em]" :class="color[tone]">{{ value }}</p>
    <p v-if="hint" class="mt-1.5 text-[13px] leading-[18px] text-ink-500">{{ hint }}</p>
  </div>
</template>
