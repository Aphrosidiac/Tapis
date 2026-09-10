<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>()
</script>

<template>
  <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="text-[20px] font-semibold leading-7 tracking-[-0.01em]">{{ title }}</h1>
      <p v-if="subtitle" class="mt-1 max-w-3xl text-[14px] leading-5 text-ink-500">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2"><slot name="actions" /></div>
  </div>
</template>
