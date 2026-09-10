<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useLinkStore } from '../../stores/link'
import { Menu, LogOut } from 'lucide-vue-next'

defineProps<{ title: string }>()
defineEmits<{ toggleSidebar: [] }>()

const auth = useAuthStore()
const router = useRouter()
const linkStore = useLinkStore()

/// One pill, three states. A dot plus a word, because colour alone is not a
/// status anyone can read.
const pill = computed(() => {
  const l = linkStore.link
  if (!l) return { label: 'WhatsApp', dot: 'bg-ink-300', cls: 'text-ink-500 bg-line-100' }
  if (l.ready) return { label: l.me?.name || `+${l.me?.id}` || 'Linked', dot: 'bg-success-600', cls: 'text-success-600 bg-success-50' }
  if (['pairing', 'starting', 'reconnecting'].includes(l.state))
    return { label: l.state, dot: 'bg-warning-600', cls: 'text-warning-600 bg-warning-50' }
  return { label: 'Not linked', dot: 'bg-danger-600', cls: 'text-danger-600 bg-danger-50' }
})

function logout() {
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <header class="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line-200 bg-surface-50/90 px-4 backdrop-blur-md lg:px-8">
    <button
      class="-ml-2 grid size-10 shrink-0 place-items-center rounded-sm text-ink-500 hover:text-ink-900 lg:hidden"
      aria-label="Open menu"
      @click="$emit('toggleSidebar')"
    >
      <Menu class="size-5" :stroke-width="1.5" />
    </button>
    <h2 class="min-w-0 flex-1 truncate text-[15px] font-medium leading-[22px] text-ink-900">{{ title }}</h2>
    <RouterLink
      to="/whatsapp"
      class="tap-target inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium leading-4"
      :class="pill.cls"
    >
      <span class="size-1.5 rounded-full" :class="pill.dot" aria-hidden="true" />
      <span class="max-w-[14ch] truncate">{{ pill.label }}</span>
    </RouterLink>
    <!-- Icon-only below sm, so it needs a square of its own rather than the
         width its (hidden) label would have given it. -->
    <button
      class="-mr-2 inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-sm px-2 text-[14px] text-ink-500 hover:text-ink-900"
      aria-label="Sign out"
      @click="logout"
    >
      <LogOut class="size-4" :stroke-width="1.5" /> <span class="hidden sm:inline">Sign out</span>
    </button>
  </header>
</template>
