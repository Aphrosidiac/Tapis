<script setup lang="ts">
defineProps<{ title?: string; sub?: string; flush?: boolean }>()
</script>

<template>
  <section class="card overflow-hidden">
    <header
      v-if="title || $slots.actions"
      class="flex flex-wrap items-center justify-between gap-3 border-b border-line-100 px-6 py-4"
    >
      <div class="min-w-0">
        <h3 v-if="title" class="text-[16px] leading-6 font-semibold">{{ title }}</h3>
        <p v-if="sub" class="mt-0.5 text-[13px] leading-[18px] text-ink-500">{{ sub }}</p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2"><slot name="actions" /></div>
    </header>
    <div :class="flush ? '' : 'p-6'"><slot /></div>
    <footer v-if="$slots.footer" class="border-t border-line-100 bg-surface-50 px-6 py-3.5">
      <slot name="footer" />
    </footer>
  </section>
</template>
