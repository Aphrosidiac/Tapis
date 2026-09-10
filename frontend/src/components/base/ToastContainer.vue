<script setup lang="ts">
import { useToast } from '../../composables/useToast'
import { X } from 'lucide-vue-next'

const { toasts, dismiss } = useToast()
const bar: Record<string, string> = { ok: 'bg-success-600', bad: 'bg-danger-600', info: 'bg-info-600' }
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4" aria-live="polite">
      <TransitionGroup
        enter-from-class="translate-y-2 opacity-0"
        leave-to-class="translate-y-1 opacity-0"
        enter-active-class="transition duration-[180ms] ease-[cubic-bezier(.2,.8,.2,1)]"
        leave-active-class="transition duration-[120ms]"
      >
        <div
          v-for="t in toasts"
          :key="t.id"
          class="card pointer-events-auto flex w-full max-w-md overflow-hidden shadow-md"
          :role="t.kind === 'bad' ? 'alert' : 'status'"
        >
          <span class="w-1 shrink-0" :class="bar[t.kind]" />
          <div class="flex min-w-0 flex-1 gap-3 px-4 py-3">
            <p class="min-w-0 flex-1 text-[14px] leading-5 text-ink-800">{{ t.message }}</p>
            <button class="-m-1 h-fit rounded-sm p-1 text-ink-400 hover:text-ink-900" aria-label="Dismiss" @click="dismiss(t.id)">
              <X class="size-4" :stroke-width="1.75" />
            </button>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
