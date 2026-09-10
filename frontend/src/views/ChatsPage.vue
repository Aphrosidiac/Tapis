<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { usePolling } from '../composables/usePolling'
import { useToast } from '../composables/useToast'
import { ago } from '../lib/format'
import { useLinkStore } from '../stores/link'
import PageHeader from '../components/base/PageHeader.vue'
import BaseToggle from '../components/base/BaseToggle.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import EmptyState from '../components/base/EmptyState.vue'
import { Users, User, RefreshCw, Search, MessagesSquare, Contact } from 'lucide-vue-next'

interface Chat {
  id: string
  jid: string
  name: string
  isGroup: boolean
  tracked: boolean
  clientName: string | null
  description: string | null
  participantCount: number | null
  lastMessageAt: string | null
  counts: { rules: number; items: number; messages: number }
}

const { ok, bad } = useToast()
const link = useLinkStore()
const chats = ref<Chat[]>([])
/// From the server, not `chats.length`: the list is capped, and a header
/// that counts the page rather than the account said "1 of 500" while the
/// account held 922.
const total = ref(0)
const loading = ref(true)
const q = ref('')
const show = ref<'all' | 'tracked' | 'groups' | 'private'>('all')
const refreshing = ref(false)
const resyncing = ref(false)

async function load() {
  try {
    const { data } = await api.get<{ chats: Chat[]; total: number }>('/chats')
    chats.value = data.chats
    total.value = data.total ?? data.chats.length
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

/// The saved names ride WhatsApp's app-state sync, which only runs at
/// pairing — when none of the chats exist yet. This pulls them again.
async function resyncContacts() {
  resyncing.value = true
  try {
    const { data } = await api.post<{ applied: number; contacts: number }>('/whatsapp/resync-contacts', {})
    ok(`${data.contacts} contacts known${data.applied ? `, ${data.applied} chats renamed` : ''}`)
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    resyncing.value = false
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

const FILTERS = [
  ['all', 'All'],
  ['tracked', 'Reading'],
  ['groups', 'Groups'],
  ['private', 'Private'],
] as const
</script>

<template>
  <div class="rise">
    <PageHeader
      title="Chats & rules"
      :subtitle="`${trackedCount} of ${total} chats are being read. Everything else is ignored completely — not stored, not analysed.`"
    >
      <template #actions>
        <BaseButton variant="secondary" :loading="resyncing" :disabled="!link.link?.ready" @click="resyncContacts">
          <Contact class="size-4" :stroke-width="1.5" /> Resync contact names
        </BaseButton>
        <BaseButton variant="secondary" :loading="refreshing" :disabled="!link.link?.ready" @click="refreshGroups">
          <RefreshCw class="size-4" :stroke-width="1.5" /> Refresh group list
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-3">
      <div class="flex gap-1 rounded-md border border-line-200 bg-surface-0 p-1">
        <button
          v-for="s in FILTERS"
          :key="s[0]"
          class="rounded-sm px-3 py-1.5 text-[14px] leading-5"
          :class="show === s[0] ? 'bg-ink-900 font-medium text-white' : 'text-ink-500 hover:bg-surface-50 hover:text-ink-900'"
          @click="show = s[0]"
        >
          {{ s[1] }}
        </button>
      </div>
      <div class="relative w-64">
        <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" :stroke-width="1.5" />
        <input v-model="q" class="field pl-9" placeholder="Search chats…" aria-label="Search chats" />
      </div>
    </div>

    <EmptyState
      v-if="!loading && !chats.length"
      title="No chats yet"
      hint="Link a WhatsApp account first. Groups appear as soon as it connects; private chats appear when they next say something."
    >
      <template #icon><MessagesSquare class="size-5" :stroke-width="1.5" /></template>
      <RouterLink to="/whatsapp"><BaseButton variant="primary">Link WhatsApp</BaseButton></RouterLink>
    </EmptyState>

    <div v-else class="card overflow-hidden">
      <div class="hidden grid-cols-[64px_minmax(0,1fr)_180px_96px_96px_120px] items-center gap-3 border-b border-line-200 bg-surface-50 px-5 py-2.5 md:grid">
        <span class="eyebrow">Read</span>
        <span class="eyebrow">Chat</span>
        <span class="eyebrow">Client</span>
        <span class="eyebrow text-right">Rules</span>
        <span class="eyebrow text-right">Open</span>
        <span class="eyebrow text-right">Last message</span>
      </div>
      <div class="divide-y divide-line-100">
        <div
          v-for="c in filtered"
          :key="c.id"
          class="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3 px-5 py-3 hover:bg-surface-50 md:grid-cols-[64px_minmax(0,1fr)_180px_96px_96px_120px]"
        >
          <BaseToggle :model-value="c.tracked" :label="`Read ${c.name}`" @update:model-value="(v) => toggle(c, v)" />
          <RouterLink :to="`/chats/${c.id}`" class="min-w-0">
            <!-- The truncate has to sit on the TEXT, not on the flex row. On
                 the row it clips without an ellipsis, because text-overflow
                 does not apply to an anonymous flex item. Long real group
                 subjects were being cut mid-word with no ellipsis. -->
            <p class="flex items-center gap-2 text-[15px] font-medium leading-[22px] text-ink-900">
              <component :is="c.isGroup ? Users : User" class="size-4 shrink-0 text-ink-400" :stroke-width="1.5" />
              <span class="truncate">{{ c.name }}</span>
            </p>
            <p class="truncate text-[13px] leading-[18px] text-ink-500">
              {{ c.isGroup ? `Group${c.participantCount ? ` · ${c.participantCount} members` : ''}` : 'Private chat' }}
              <span class="md:hidden"> · {{ c.clientName || 'no client' }} · {{ c.counts.rules }} rules · {{ c.counts.items }} open</span>
            </p>
          </RouterLink>
          <span class="hidden truncate text-[14px] leading-5 text-ink-600 md:block">{{ c.clientName || '—' }}</span>
          <span class="num hidden text-right text-[14px] leading-5 md:block">
            <BaseBadge v-if="c.tracked && !c.counts.rules" tone="warn">no rules</BaseBadge>
            <template v-else>{{ c.counts.rules }}</template>
          </span>
          <span class="num hidden text-right text-[14px] leading-5 md:block">{{ c.counts.items }}</span>
          <span class="hidden text-right text-[13px] leading-[18px] text-ink-500 md:block">{{ ago(c.lastMessageAt) }}</span>
        </div>
      </div>
      <p v-if="!filtered.length" class="px-5 py-10 text-center text-[14px] leading-5 text-ink-500">No chats match.</p>
    </div>
  </div>
</template>
