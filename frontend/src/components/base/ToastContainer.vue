<script setup lang="ts">
import { useToast } from '../../composables/useToast'
import { X } from 'lucide-vue-next'
const { toasts, dismiss } = useToast()
const tone: Record<string, string> = { ok: 'border-l-ok', bad: 'border-l-bad', info: 'border-l-accent' }
</script>

<template>
  <Teleport to="body">
    <div class="fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      <TransitionGroup name="toast">
        <div v-for="t in toasts" :key="t.id" :class="['flex items-start gap-2 rounded border border-line border-l-[3px] bg-surface px-3 py-2 text-[12.5px] text-ink shadow-md', tone[t.kind]]">
          <span class="flex-1">{{ t.message }}</span>
          <button class="text-faint hover:text-ink" @click="dismiss(t.id)"><X class="w-3.5 h-3.5" /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active, .toast-leave-active { transition: all 0.2s ease-in-out; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(12px); }
</style>
