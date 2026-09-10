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

const pill = computed(() => {
  const l = linkStore.link
  if (!l) return { label: 'WhatsApp …', cls: 'text-faint border-line' }
  if (l.ready) return { label: `WhatsApp · ${l.me?.name || l.me?.id || 'linked'}`, cls: 'text-ok border-ok/40 bg-ok/10' }
  if (l.state === 'pairing' || l.state === 'starting' || l.state === 'reconnecting') return { label: `WhatsApp · ${l.state}`, cls: 'text-warn border-warn/40 bg-warn/10' }
  return { label: 'WhatsApp · not linked', cls: 'text-bad border-bad/40 bg-bad/10' }
})

function logout() {
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <header class="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur sm:px-6">
    <button class="-ml-2 inline-flex h-10 w-10 items-center justify-center text-muted hover:text-ink lg:hidden" aria-label="Open navigation" @click="$emit('toggleSidebar')"><Menu class="h-5 w-5" /></button>
    <h2 class="flex-1 text-[13px] font-bold text-ink">{{ title }}</h2>
    <RouterLink to="/whatsapp" :class="['hidden rounded-full border px-2.5 py-0.5 text-[11px] font-semibold sm:inline-flex', pill.cls]">{{ pill.label }}</RouterLink>
    <button class="inline-flex items-center gap-1.5 px-2 py-1 text-[11.5px] text-muted hover:text-ink" @click="logout"><LogOut class="h-3.5 w-3.5" /> Sign out</button>
  </header>
</template>
