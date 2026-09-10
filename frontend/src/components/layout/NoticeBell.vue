<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { Bell, AlertTriangle, CircleAlert, Info, CheckCircle2 } from 'lucide-vue-next'
import { useNoticesStore } from '../../stores/notices'

const store = useNoticesStore()
const route = useRoute()
const open = ref(false)
const root = ref<HTMLElement>()
const panel = ref<HTMLElement>()

const TONE = {
  danger: { icon: CircleAlert, text: 'text-danger-600', dot: 'bg-danger-600' },
  warning: { icon: AlertTriangle, text: 'text-warning-600', dot: 'bg-warning-600' },
  info: { icon: Info, text: 'text-info-600', dot: 'bg-info-600' },
} as const

const badge = computed(() => (store.worst === 'danger' ? 'bg-danger-600' : store.worst === 'warning' ? 'bg-warning-600' : 'bg-info-600'))
const label = computed(() => (store.count ? `${store.count} thing${store.count === 1 ? '' : 's'} need attention` : 'Nothing needs attention'))

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}
function onPointer(e: PointerEvent) {
  if (!open.value) return
  const t = e.target as Node
  // The panel is teleported out of this component, so "outside" has to mean
  // outside BOTH the trigger and the panel.
  if (root.value?.contains(t) || panel.value?.contains(t)) return
  open.value = false
}
onMounted(() => {
  document.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onPointer)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onPointer)
})
// Following a notice navigates; the panel must not stay open over the page
// it just sent you to.
watch(() => route.fullPath, () => { open.value = false })
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="relative grid size-10 shrink-0 place-items-center rounded-sm text-ink-500 hover:bg-surface-0 hover:text-ink-900"
      :aria-label="label"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="open = !open"
    >
      <Bell class="size-5" :stroke-width="1.5" />
      <!-- The count, not just a dot: "3 things" and "1 thing" are different
           decisions about whether to stop what you are doing. -->
      <span
        v-if="store.count"
        class="num absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold leading-none text-white"
        :class="badge"
      >
        {{ store.count }}
      </span>
    </button>

    <!-- Teleported to the body on purpose. Anchored to the bell it ran off
         the left edge of a 390px screen, and it cannot simply be `fixed`
         where it was: the header carries a backdrop-blur, and a filtered
         ancestor becomes the containing block for fixed descendants, so the
         panel would still be trapped inside a 64px-tall bar. -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-[180ms] ease-[cubic-bezier(.2,.8,.2,1)]"
        leave-active-class="transition duration-[120ms]"
        enter-from-class="opacity-0 -translate-y-1"
        leave-to-class="opacity-0 -translate-y-1"
      >
        <div
          v-if="open"
          ref="panel"
          class="card fixed inset-x-4 top-[4.5rem] z-50 overflow-hidden shadow-md sm:inset-x-auto sm:right-6 sm:w-[380px] lg:right-8"
          role="dialog"
          :aria-label="label"
        >
          <div class="flex items-center justify-between border-b border-line-100 px-4 py-3">
            <h2 class="text-[14px] font-semibold leading-5">Needs you</h2>
            <span v-if="store.count" class="num text-[13px] leading-[18px] text-ink-500">{{ store.count }}</span>
          </div>

          <div v-if="!store.count" class="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <CheckCircle2 class="size-6 text-success-600" :stroke-width="1.5" />
            <p class="text-[14px] leading-5 text-ink-600">
              {{ store.loaded ? 'Nothing needs you right now.' : 'Checking…' }}
            </p>
          </div>

          <ul v-else class="max-h-[min(70dvh,32rem)] divide-y divide-line-100 overflow-y-auto">
            <li v-for="n in store.notices" :key="n.id" class="flex gap-3 px-4 py-3.5">
              <component :is="TONE[n.tone].icon" class="mt-0.5 size-4 shrink-0" :class="TONE[n.tone].text" :stroke-width="1.75" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="text-[14px] font-semibold leading-5" :class="TONE[n.tone].text">{{ n.title }}</p>
                <p class="mt-0.5 text-[14px] leading-5 text-ink-600">{{ n.body }}</p>
                <RouterLink
                  v-if="n.to"
                  :to="n.to"
                  class="mt-1.5 inline-block py-1 text-[13px] font-medium leading-[18px] text-primary-700 hover:underline"
                >
                  {{ n.action ?? 'Open' }} →
                </RouterLink>
              </div>
            </li>
          </ul>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
