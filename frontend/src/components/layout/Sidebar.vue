<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { LayoutDashboard, MessagesSquare, ListChecks, Smartphone, Settings2, Sparkles, X } from 'lucide-vue-next'

defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()

const auth = useAuthStore()
const route = useRoute()

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/chats', label: 'Chats & rules', icon: MessagesSquare },
  { to: '/review', label: 'Review', icon: ListChecks },
  { to: '/assistant', label: 'Assistant', icon: Sparkles },
  { to: '/whatsapp', label: 'WhatsApp link', icon: Smartphone },
  { to: '/settings', label: 'Settings', icon: Settings2 },
]

// The dashboard owns the item pages, so opening one keeps the nav honest
// about where you are.
const isActive = (to: string, exact?: boolean) =>
  exact ? route.path === to || route.path.startsWith('/items') : route.path === to || route.path.startsWith(to + '/')

const initials = (name?: string) =>
  (name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
</script>

<template>
  <aside
    class="fixed inset-y-0 left-0 z-40 flex w-[248px] shrink-0 flex-col border-r border-line-200 bg-surface-0 transition-transform duration-[180ms] ease-[cubic-bezier(.2,.8,.2,1)] lg:sticky lg:top-0 lg:h-screen lg:translate-x-0"
    :class="open ? 'translate-x-0' : '-translate-x-full'"
  >
    <div class="flex h-16 items-center gap-2.5 border-b border-line-100 px-5">
      <RouterLink to="/" class="flex h-full min-w-0 flex-1 items-center gap-2.5" @click="$emit('close')">
        <span class="grid size-8 shrink-0 place-items-center rounded-md bg-ink-900">
          <svg viewBox="0 0 32 32" class="size-[18px]" aria-hidden="true">
            <path d="M7 9h18M9.5 15.5h13M13 22h6" stroke="#4fb6a9" stroke-width="3" stroke-linecap="round" fill="none" />
          </svg>
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[16px] font-semibold leading-5 tracking-[-0.01em] text-ink-900">Tapis</span>
          <span class="block truncate text-[12px] leading-4 text-ink-500">chatter into items</span>
        </span>
      </RouterLink>
      <!-- Tapping the dimmed page closes the drawer too, but that is a thing
           you have to already know. On a phone the way out should be visible. -->
      <button
        class="-mr-2 grid size-10 shrink-0 place-items-center rounded-sm text-ink-400 hover:text-ink-900 lg:hidden"
        aria-label="Close navigation"
        @click="$emit('close')"
      >
        <X class="size-5" :stroke-width="1.5" />
      </button>
    </div>

    <nav class="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="Main">
      <RouterLink
        v-for="n in NAV"
        :key="n.to"
        :to="n.to"
        :aria-current="isActive(n.to, n.exact) ? 'page' : undefined"
        class="flex items-center gap-3 rounded-sm px-3 py-2.5 text-[15px] leading-[22px] lg:py-2"
        :class="isActive(n.to, n.exact) ? 'bg-primary-50 font-medium text-primary-700' : 'text-ink-500 hover:bg-surface-50 hover:text-ink-900'"
        @click="$emit('close')"
      >
        <component :is="n.icon" class="size-5 shrink-0" :stroke-width="1.5" aria-hidden="true" />
        {{ n.label }}
      </RouterLink>
    </nav>

    <div class="flex items-center gap-3 border-t border-line-100 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <span class="grid size-8 shrink-0 place-items-center rounded-full bg-primary-600 text-[13px] font-semibold text-white">
        {{ initials(auth.user?.name) }}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[14px] font-medium leading-5 text-ink-900">{{ auth.user?.name }}</span>
        <span class="block truncate text-[13px] leading-[18px] text-ink-500">{{ auth.user?.email }}</span>
      </span>
    </div>
  </aside>
</template>
