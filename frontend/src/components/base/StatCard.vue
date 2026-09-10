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
  <!-- Tighter below sm. At full size, six of these fill an entire phone
       screen and push the actual items — the reason anyone opened the app —
       below two full scrolls. -->
  <div class="card p-4 sm:p-5">
    <!-- `.eyebrow` is nowrap because a wrapped TABLE header misaligns its
         column. A stat label has no column to misalign and a long one is
         clipped at the card edge on a phone, so it wraps here. -->
    <p class="eyebrow whitespace-normal">{{ label }}</p>
    <p class="num mt-1 text-[22px] font-semibold leading-7 tracking-[-0.01em] sm:mt-2 sm:text-[26px] sm:leading-8" :class="color[tone]">
      {{ value }}
    </p>
    <p v-if="hint" class="mt-1 text-[12.5px] leading-[17px] text-ink-500 sm:mt-1.5 sm:text-[13px] sm:leading-[18px]">{{ hint }}</p>
  </div>
</template>
