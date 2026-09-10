<script setup lang="ts">
import { watch, onUnmounted } from 'vue'
import { X } from 'lucide-vue-next'
const props = defineProps<{ show: boolean; title?: string; size?: 'sm' | 'md' | 'lg' | 'xl' }>()
const emit = defineEmits<{ close: [] }>()
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
watch(() => props.show, (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
  if (open) document.addEventListener('keydown', onKeydown)
  else document.removeEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKeydown)
})
const sizeClass: Record<string, string> = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="show" class="fixed inset-0 z-50 flex items-stretch justify-center p-0 sm:items-center sm:p-8">
        <div class="fixed inset-0 bg-ink/40" @click="emit('close')" />
        <div :class="['relative flex max-h-full w-full flex-col rounded-md border-line bg-surface shadow-xl sm:border', sizeClass[size || 'md']]">
          <div v-if="title" class="flex shrink-0 items-center justify-between border-b border-hair px-4 py-3 sm:px-5">
            <h3 class="text-[13px] font-bold text-ink">{{ title }}</h3>
            <button class="-mr-2 inline-flex h-9 w-9 items-center justify-center rounded text-faint hover:text-ink" aria-label="Close" @click="emit('close')"><X class="w-4 h-4" /></button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5"><slot /></div>
          <div v-if="$slots.footer" class="flex shrink-0 justify-end gap-2 rounded-b-md border-t border-hair bg-inert px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-3"><slot name="footer" /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease-in-out; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
