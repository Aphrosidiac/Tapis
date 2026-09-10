<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { LayoutDashboard, MessagesSquare, ListChecks, Smartphone, Settings } from 'lucide-vue-next'

defineEmits<{ close: [] }>()
const auth = useAuthStore()
const route = useRoute()

const ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/chats', label: 'Chats & rules', icon: MessagesSquare },
  { to: '/review', label: 'Review', icon: ListChecks },
  { to: '/whatsapp', label: 'WhatsApp link', icon: Smartphone },
  { to: '/settings', label: 'Settings', icon: Settings },
]
const isActive = (to: string, exact?: boolean) => (exact ? route.path === to || route.path.startsWith('/items') : route.path === to || route.path.startsWith(to + '/'))
</script>

<template>
  <aside class="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-line bg-surface transition-transform lg:translate-x-0">
    <div class="flex items-center gap-2.5 border-b border-hair px-4 py-4">
      <span class="inline-flex h-7 w-7 items-center justify-center rounded bg-ink">
        <svg viewBox="0 0 32 32" class="h-4 w-4"><path d="M7 9h18M9 15h14M12 21h8" stroke="#2dd4bf" stroke-width="3.5" stroke-linecap="square" fill="none" /></svg>
      </span>
      <div>
        <p class="text-[14px] font-bold leading-none tracking-tight text-ink">Tapis</p>
        <p class="mt-0.5 text-[10.5px] text-faint">chatter → items</p>
      </div>
    </div>
    <nav class="flex-1 overflow-y-auto py-3">
      <RouterLink
        v-for="item in ITEMS"
        :key="item.to"
        :to="item.to"
        :class="['mx-2 mb-0.5 flex items-center gap-2.5 rounded px-2.5 py-2 text-[13px] lg:py-1.5 lg:text-[12.5px]', isActive(item.to, item.exact) ? 'bg-accent-soft font-semibold text-accent-strong' : 'text-muted hover:bg-tint hover:text-ink']"
        @click="$emit('close')"
      >
        <component :is="item.icon" class="h-4 w-4 shrink-0" />
        {{ item.label }}
      </RouterLink>
    </nav>
    <div class="border-t border-hair px-4 py-3">
      <p class="truncate text-[12px] font-semibold text-ink">{{ auth.user?.name }}</p>
      <p class="truncate text-[11px] text-muted">{{ auth.user?.email }}</p>
    </div>
  </aside>
</template>
