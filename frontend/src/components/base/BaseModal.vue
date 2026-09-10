<script setup lang="ts">
import { watch, onBeforeUnmount, ref, nextTick, useId } from 'vue'
import { X } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{ show: boolean; title?: string; subtitle?: string; size?: 'sm' | 'md' | 'lg' | 'xl' }>(),
  { size: 'md' },
)
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement>()
const titleId = useId()
let restore: HTMLElement | null = null

/// Escape closes, Tab cycles inside. A dialog that lets focus wander behind
/// it is a dialog a keyboard user cannot get out of.
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  if (e.key !== 'Tab' || !panel.value) return
  const focusable = panel.value.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(
  () => props.show,
  async (open) => {
    document.documentElement.style.overflow = open ? 'hidden' : ''
    if (open) {
      restore = document.activeElement as HTMLElement
      addEventListener('keydown', onKey)
      await nextTick()
      panel.value?.querySelector<HTMLElement>('input,button,select,textarea')?.focus()
    } else {
      removeEventListener('keydown', onKey)
      restore?.focus()
      restore = null
    }
  },
)
// Unmounting while open would otherwise leave the page permanently locked.
onBeforeUnmount(() => {
  removeEventListener('keydown', onKey)
  document.documentElement.style.overflow = ''
})

const sizes: Record<string, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[720px]',
  xl: 'max-w-[960px]',
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-[260ms] ease-[cubic-bezier(.2,.8,.2,1)]"
      leave-active-class="transition duration-[150ms]"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <!-- A sheet on a phone, a centred dialog from sm up. Centred-with-a-
           margin on a 390px screen wastes the edges and puts the footer
           buttons in the middle of the thumb's reach. -->
      <div v-if="show" class="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
        <div class="absolute inset-0 bg-ink-900/45" @click="emit('close')" />
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          class="card relative flex max-h-[92dvh] w-full flex-col rounded-b-none shadow-lg sm:max-h-[88vh] sm:rounded-b-[10px]"
          :class="sizes[size]"
        >
          <header v-if="title" class="flex items-start justify-between gap-4 border-b border-line-100 px-6 py-4">
            <div class="min-w-0">
              <h2 :id="titleId" class="text-[18px] leading-7 font-semibold">{{ title }}</h2>
              <p v-if="subtitle" class="mt-1 text-[14px] leading-5 text-ink-500">{{ subtitle }}</p>
            </div>
            <button class="-m-1.5 rounded-sm p-1.5 text-ink-400 hover:text-ink-900" aria-label="Close" @click="emit('close')">
              <X class="size-[18px]" :stroke-width="1.75" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5"><slot /></div>
          <!-- The inset keeps the primary action clear of the iPhone home bar. -->
          <footer
            v-if="$slots.footer"
            class="flex justify-end gap-2 border-t border-line-100 bg-surface-50 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4"
          >
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
