<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>()
</script>

<template>
  <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-[18px] font-bold tracking-tight text-ink">{{ title }}</h1>
      <p v-if="subtitle" class="mt-0.5 text-[12.5px] text-muted">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2"><slot name="actions" /></div>
  </div>
</template>
