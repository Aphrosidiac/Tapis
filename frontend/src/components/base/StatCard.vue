<script setup lang="ts">
defineProps<{ label: string; value: string | number; hint?: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' }>()
const color: Record<string, string> = { neutral: 'text-ink', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', accent: 'text-accent-strong' }
</script>

<template>
  <div class="rounded-md border border-line bg-surface px-4 py-3">
    <p class="eyebrow">{{ label }}</p>
    <p :class="['mt-1 text-[22px] font-bold leading-none tabular', color[tone || 'neutral']]">{{ value }}</p>
    <p v-if="hint" class="mt-1.5 text-[11.5px] text-faint">{{ hint }}</p>
  </div>
</template>
