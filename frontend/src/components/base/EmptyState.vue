<script setup lang="ts">
defineProps<{ title: string; hint?: string }>()
</script>

<template>
  <div class="rounded-md border border-dashed border-line bg-surface px-6 py-12 text-center">
    <p class="text-[13px] font-semibold text-ink">{{ title }}</p>
    <p v-if="hint" class="mx-auto mt-1 max-w-md text-[12.5px] text-muted">{{ hint }}</p>
    <div v-if="$slots.default" class="mt-4 flex justify-center gap-2"><slot /></div>
  </div>
</template>
