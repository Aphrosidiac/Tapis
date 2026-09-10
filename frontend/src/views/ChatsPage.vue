<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { usePolling } from '../composables/usePolling'
import { useToast } from '../composables/useToast'
import { ago } from '../lib/format'
import { useLinkStore } from '../stores/link'
import PageHeader from '../components/base/PageHeader.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseToggle from '../components/base/BaseToggle.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import EmptyState from '../components/base/EmptyState.vue'
import { Users, User, RefreshCw } from 'lucide-vue-next'

interface Chat { id: string; jid: string; name: string; isGroup: boolean; tracked: boolean; clientName: string | null; description: string | null; participantCount: number | null; lastMessageAt: string | null; counts: { rules: number; items: number; messages: number } }

const { ok, bad } = useToast()
const link = useLinkStore()
const chats = ref<Chat[]>([])
const loading = ref(true)
const q = ref('')
const show = ref<'all' | 'tracked' | 'groups' | 'private'>('all')
const refreshing = ref(false)

async function load() {
  try {
    const { data } = await api.get<{ chats: Chat[] }>('/chats')
    chats.value = data.chats
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    loading.value = false
  }
}
usePolling(load, 20_000)

const filtered = computed(() =>
  chats.value.filter((c) => {
    if (show.value === 'tracked' && !c.tracked) return false
    if (show.value === 'groups' && !c.isGroup) return false
    if (show.value === 'private' && c.isGroup) return false
    if (q.value && !`${c.name} ${c.clientName ?? ''}`.toLowerCase().includes(q.value.toLowerCase())) return false
    return true
  }),
)
const trackedCount = computed(() => chats.value.filter((c) => c.tracked).length)

async function toggle(c: Chat, tracked: boolean) {
  try {
    await api.put(`/chats/${c.id}`, { tracked })
    c.tracked = tracked
    ok(tracked ? `Reading "${c.name}" from now on` : `Stopped reading "${c.name}"`)
  } catch (e) {
    bad(errorMessage(e))
  }
}

async function refreshGroups() {
  refreshing.value = true
  try {
    const { data } = await api.post<{ count: number }>('/whatsapp/refresh-groups', {})
    ok(`${data.count} groups found`)
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <div class="animate-page-in">
    <PageHeader title="Chats & rules" :subtitle="`${trackedCount} of ${chats.length} chats are being read. Everything else is ignored completely — not even stored.`">
      <template #actions>
        <BaseButton variant="secondary" :loading="refreshing" :disabled="!link.link?.ready" @click="refreshGroups"><RefreshCw class="h-3.5 w-3.5" /> Refresh group list</BaseButton>
      </template>
    </PageHeader>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="flex rounded border border-line bg-surface p-0.5">
        <button v-for="s in [['all', 'All'], ['tracked', 'Reading'], ['groups', 'Groups'], ['private', 'Private']]" :key="s[0]" :class="['rounded px-2.5 py-1 text-[11.5px]', show === s[0] ? 'bg-ink text-white' : 'text-muted hover:text-ink']" @click="show = s[0] as never">{{ s[1] }}</button>
      </div>
      <div class="w-56"><BaseInput v-model="q" placeholder="Search chats…" /></div>
    </div>

    <EmptyState v-if="!loading && !chats.length" title="No chats yet" hint="Link a WhatsApp account first. Groups appear as soon as it connects; private chats appear when they next say something.">
      <RouterLink to="/whatsapp"><BaseButton>Link WhatsApp</BaseButton></RouterLink>
    </EmptyState>

    <div v-else class="overflow-hidden rounded-md border border-line bg-surface">
      <div class="hidden grid-cols-[auto_1fr_180px_90px_90px_110px] items-center gap-3 border-b border-line bg-inert px-4 py-2 md:grid">
        <span class="eyebrow w-10">Read</span><span class="eyebrow">Chat</span><span class="eyebrow">Client</span><span class="eyebrow text-right">Rules</span><span class="eyebrow text-right">Open items</span><span class="eyebrow text-right">Last message</span>
      </div>
      <div v-for="c in filtered" :key="c.id" class="grid grid-cols-[auto_1fr] items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-tint md:grid-cols-[auto_1fr_180px_90px_90px_110px]">
        <div class="w-10"><BaseToggle :model-value="c.tracked" :label="`Read ${c.name}`" @update:model-value="(v) => toggle(c, v)" /></div>
        <RouterLink :to="`/chats/${c.id}`" class="min-w-0">
          <p class="flex items-center gap-1.5 truncate text-[13px] font-semibold text-ink">
            <component :is="c.isGroup ? Users : User" class="h-3.5 w-3.5 shrink-0 text-faint" />{{ c.name }}
          </p>
          <p class="truncate text-[11.5px] text-faint">{{ c.isGroup ? `Group${c.participantCount ? ` · ${c.participantCount} members` : ''}` : 'Private chat' }}<span class="md:hidden"> · {{ c.clientName || 'no client' }} · {{ c.counts.rules }} rules · {{ c.counts.items }} open</span></p>
        </RouterLink>
        <span class="hidden truncate text-[12.5px] text-muted md:block">{{ c.clientName || '—' }}</span>
        <span class="hidden text-right text-[12.5px] tabular md:block">
          <BaseBadge v-if="c.tracked && !c.counts.rules" tone="warn">no rules</BaseBadge>
          <template v-else>{{ c.counts.rules }}</template>
        </span>
        <span class="hidden text-right text-[12.5px] tabular md:block">{{ c.counts.items }}</span>
        <span class="hidden text-right text-[11.5px] text-faint md:block">{{ ago(c.lastMessageAt) }}</span>
      </div>
      <p v-if="!filtered.length" class="px-4 py-8 text-center text-[12.5px] text-muted">No chats match.</p>
    </div>
  </div>
</template>
