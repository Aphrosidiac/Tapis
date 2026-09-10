<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { usePolling } from '../composables/usePolling'
import { useToast } from '../composables/useToast'
import { ago, usd, STATUS_LABEL, STATUS_TONE, PRIORITY_TONE } from '../lib/format'
import StatCard from '../components/base/StatCard.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseButton from '../components/base/BaseButton.vue'
import EmptyState from '../components/base/EmptyState.vue'
import { AlertTriangle, MessageSquareText, Send } from 'lucide-vue-next'

interface Item {
  id: string
  title: string
  brief: string
  status: string
  priority: string
  lastActivityAt: string
  firstMessageAt: string
  chat: { id: string; name: string; clientName: string | null; isGroup: boolean }
  rules: { id: string; text: string }[]
  counts: { messages: number; deliveries: number }
}
interface Dash {
  items: Record<string, number>
  trackedChats: number
  pendingMessages: number
  messages7: number
  dismissed7: number
  failedBundles: number
  pendingDeliveries: number
  cost: { d7: number; d30: number; calls7: number; calls30: number }
  link: { state: string; ready: boolean; me: { id: string; name: string | null } | null; action: string | null; lastInboundAt: string | null }
  llmConfigured: boolean
  provider: string
  recentFailed: { id: string; chat: string; error: string | null }[]
}

const { bad } = useToast()
const dash = ref<Dash | null>(null)
const items = ref<Item[]>([])
const total = ref(0)
const loading = ref(true)

const TABS = [
  { key: 'open', label: 'Open', statuses: 'NEW,IN_PROGRESS' },
  { key: 'NEW', label: 'New', statuses: 'NEW' },
  { key: 'IN_PROGRESS', label: 'In progress', statuses: 'IN_PROGRESS' },
  { key: 'DONE', label: 'Done', statuses: 'DONE' },
  { key: 'DISMISSED', label: 'Dismissed', statuses: 'DISMISSED' },
  { key: 'all', label: 'All', statuses: '' },
]
const tab = ref(localStorage.getItem('tapis_dash_tab') || 'open')
const groupBy = ref<'client' | 'chat' | 'rule' | 'none'>((localStorage.getItem('tapis_dash_group') as never) || 'client')
const q = ref('')

async function load() {
  try {
    const t = TABS.find((x) => x.key === tab.value) ?? TABS[0]
    const [d, i] = await Promise.all([
      api.get<Dash>('/dashboard'),
      api.get<{ items: Item[]; total: number }>('/items', { params: { status: t.statuses || undefined, q: q.value || undefined, limit: 300 } }),
    ])
    dash.value = d.data
    items.value = i.data.items
    total.value = i.data.total
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    loading.value = false
  }
}
usePolling(load, 15_000)
watch([tab, groupBy], () => {
  localStorage.setItem('tapis_dash_tab', tab.value)
  localStorage.setItem('tapis_dash_group', groupBy.value)
  void load()
})
let qTimer: number | null = null
watch(q, () => {
  if (qTimer) clearTimeout(qTimer)
  qTimer = window.setTimeout(load, 250)
})

const groups = computed(() => {
  const map = new Map<string, { key: string; label: string; sub: string; items: Item[] }>()
  for (const it of items.value) {
    const keys: { key: string; label: string; sub: string }[] = []
    if (groupBy.value === 'client') keys.push({ key: it.chat.clientName || `chat:${it.chat.id}`, label: it.chat.clientName || it.chat.name, sub: it.chat.clientName ? '' : 'No client name set' })
    else if (groupBy.value === 'chat') keys.push({ key: it.chat.id, label: it.chat.name, sub: it.chat.clientName || '' })
    else if (groupBy.value === 'rule') {
      if (!it.rules.length) keys.push({ key: 'none', label: 'No rule matched', sub: '' })
      for (const r of it.rules) keys.push({ key: r.id, label: r.text, sub: it.chat.clientName || it.chat.name })
    } else keys.push({ key: 'all', label: 'All items', sub: '' })
    for (const k of keys) {
      if (!map.has(k.key)) map.set(k.key, { ...k, items: [] })
      map.get(k.key)!.items.push(it)
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
})

const openCount = computed(() => (dash.value?.items.NEW ?? 0) + (dash.value?.items.IN_PROGRESS ?? 0))
</script>

<template>
  <div class="animate-page-in">
    <!-- Things that need a person, before anything else. -->
    <div v-if="dash && !dash.llmConfigured" class="mb-4 flex items-start gap-2 rounded-md border border-bad/40 bg-bad/8 px-4 py-3 text-[12.5px] text-ink">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-bad" />
      <div>No model key is configured, so nothing is being analysed. Messages are still being stored. <RouterLink to="/settings" class="font-semibold underline">Add a key in Settings</RouterLink>.</div>
    </div>
    <div v-else-if="dash && dash.provider === 'mock'" class="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/8 px-4 py-3 text-[12.5px] text-ink">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      <div>The <strong>mock</strong> provider is selected: no model is called and every brief says MOCK. <RouterLink to="/settings" class="font-semibold underline">Choose a real provider in Settings</RouterLink> before trusting anything here.</div>
    </div>
    <div v-if="dash && !dash.link.ready" class="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/8 px-4 py-3 text-[12.5px] text-ink">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      <div>WhatsApp is <strong>{{ dash.link.state.replace('-', ' ') }}</strong>{{ dash.link.action ? ` — ${dash.link.action}` : '' }} <RouterLink to="/whatsapp" class="font-semibold underline">Open the link page</RouterLink>.</div>
    </div>
    <div v-if="dash?.recentFailed.length" class="mb-4 rounded-md border border-bad/40 bg-bad/8 px-4 py-3 text-[12.5px]">
      <p class="font-semibold text-bad">{{ dash.failedBundles }} pipeline run{{ dash.failedBundles === 1 ? '' : 's' }} failed</p>
      <p v-for="b in dash.recentFailed" :key="b.id" class="mt-1 text-muted"><span class="font-semibold text-ink">{{ b.chat }}:</span> {{ b.error }}</p>
      <RouterLink to="/review" class="mt-1 inline-block font-semibold underline">Review and retry</RouterLink>
    </div>

    <div class="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Open items" :value="openCount" :hint="`${dash?.items.NEW ?? 0} new · ${dash?.items.IN_PROGRESS ?? 0} in progress`" tone="accent" />
      <StatCard label="Done" :value="dash?.items.DONE ?? 0" :hint="`${dash?.items.DISMISSED ?? 0} dismissed`" />
      <StatCard label="Tracked chats" :value="dash?.trackedChats ?? 0" :hint="`${dash?.messages7 ?? 0} messages this week`" />
      <StatCard label="Waiting to be read" :value="dash?.pendingMessages ?? 0" hint="messages not yet bundled" :tone="(dash?.pendingMessages ?? 0) > 50 ? 'warn' : 'neutral'" />
      <StatCard label="Dismissed this week" :value="dash?.dismissed7 ?? 0" :hint="dash?.messages7 ? `${Math.round((dash.dismissed7 / Math.max(1, dash.messages7)) * 100)}% of traffic was noise` : ''" />
      <StatCard label="Model cost, 7 days" :value="usd(dash?.cost.d7 ?? 0)" :hint="`${dash?.cost.calls7 ?? 0} calls · ${usd(dash?.cost.d30 ?? 0)} over 30 days`" />
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="flex overflow-x-auto">
        <button v-for="t in TABS" :key="t.key" :class="['tab px-3 py-1.5 text-[12.5px]', tab === t.key && 'tab-on']" @click="tab = t.key">
          {{ t.label }}<span v-if="dash && t.key !== 'open' && t.key !== 'all'" class="ml-1 text-faint tabular">{{ dash.items[t.key] ?? 0 }}</span><span v-else-if="dash && t.key === 'open'" class="ml-1 text-faint tabular">{{ openCount }}</span>
        </button>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <span class="text-[11.5px] text-muted">Group by</span>
        <div class="flex rounded border border-line bg-surface p-0.5">
          <button v-for="g in ['client', 'chat', 'rule', 'none']" :key="g" :class="['rounded px-2 py-1 text-[11.5px] capitalize', groupBy === g ? 'bg-ink text-white' : 'text-muted hover:text-ink']" @click="groupBy = g as never">{{ g }}</button>
        </div>
        <div class="w-44"><BaseInput v-model="q" placeholder="Search items…" /></div>
      </div>
    </div>

    <EmptyState v-if="!loading && !items.length" title="Nothing here yet" :hint="tab === 'open' ? 'Items appear once a tracked chat says something that matches one of its rules. Start by choosing chats to read and writing a rule.' : 'No items with this status.'">
      <RouterLink to="/chats"><BaseButton>Choose chats & rules</BaseButton></RouterLink>
    </EmptyState>

    <div v-for="g in groups" :key="g.key" class="mb-5">
      <div class="mb-1.5 flex items-baseline gap-2 px-1">
        <h3 class="text-[13px] font-bold text-ink">{{ g.label }}</h3>
        <span v-if="g.sub" class="text-[11.5px] text-faint">{{ g.sub }}</span>
        <span class="ml-auto text-[11.5px] text-faint tabular">{{ g.items.length }}</span>
      </div>
      <div class="overflow-hidden rounded-md border border-line bg-surface">
        <RouterLink v-for="it in g.items" :key="it.id" :to="`/items/${it.id}`" class="flex items-start gap-3 border-b border-hair px-4 py-3 last:border-b-0 hover:bg-tint">
          <span :class="['mt-1.5 h-2 w-2 shrink-0 rounded-full', it.priority === 'URGENT' ? 'bg-bad' : it.priority === 'HIGH' ? 'bg-warn' : it.status === 'DONE' ? 'bg-ok' : it.status === 'DISMISSED' ? 'bg-dormant' : 'bg-accent']" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p class="text-[13px] font-semibold text-ink">{{ it.title }}</p>
              <BaseBadge :tone="STATUS_TONE[it.status]">{{ STATUS_LABEL[it.status] }}</BaseBadge>
              <BaseBadge v-if="it.priority === 'HIGH' || it.priority === 'URGENT'" :tone="PRIORITY_TONE[it.priority]">{{ it.priority }}</BaseBadge>
            </div>
            <p class="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{{ it.brief }}</p>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
              <span v-if="groupBy !== 'chat'">{{ it.chat.name }}</span>
              <span v-for="r in it.rules" :key="r.id" class="rounded-sm bg-inert px-1.5 py-0.5 text-muted">{{ r.text }}</span>
              <span class="inline-flex items-center gap-1"><MessageSquareText class="h-3 w-3" /> {{ it.counts.messages }}</span>
              <span v-if="it.counts.deliveries" class="inline-flex items-center gap-1"><Send class="h-3 w-3" /> {{ it.counts.deliveries }}</span>
              <span class="ml-auto">{{ ago(it.lastActivityAt) }}</span>
            </div>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>
</template>
