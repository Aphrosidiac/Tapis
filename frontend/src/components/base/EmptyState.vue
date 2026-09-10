<script setup lang="ts">
import { Inbox } from 'lucide-vue-next'
withDefaults(defineProps<{ title: string; hint?: string; compact?: boolean }>(), {})
</script>

<template>
  <div class="card flex flex-col items-center justify-center px-6 text-center" :class="compact ? 'py-10' : 'py-16'">
    <div class="mb-4 grid size-11 place-items-center rounded-md border border-line-200 bg-surface-50 text-ink-400">
      <slot name="icon"><Inbox class="size-5" :stroke-width="1.5" /></slot>
    </div>
    <h3 class="text-[16px] leading-6 font-semibold">{{ title }}</h3>
    <p v-if="hint" class="mt-2 max-w-md text-[14px] leading-5 text-ink-500">{{ hint }}</p>
    <div v-if="$slots.default" class="mt-5 flex justify-center gap-2"><slot /></div>
  </div>
</template>
