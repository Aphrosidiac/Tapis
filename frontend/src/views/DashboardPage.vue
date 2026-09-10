<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { usePolling } from '../composables/usePolling'
import { useToast } from '../composables/useToast'
import { ago, usd, STATUS_LABEL, STATUS_TONE, PRIORITY_TONE } from '../lib/format'
import StatCard from '../components/base/StatCard.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseButton from '../components/base/BaseButton.vue'
import EmptyState from '../components/base/EmptyState.vue'
import { MessageSquareText, Send, Search } from 'lucide-vue-next'

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
  pendingDeliveries: number
  cost: { d7: number; d30: number; calls7: number; calls30: number }
  link: { state: string; ready: boolean; me: { id: string; name: string | null } | null; action: string | null; lastInboundAt: string | null }
  llmConfigured: boolean
  provider: string
}

const { bad } = useToast()
const dash = ref<Dash | null>(null)
const items = ref<Item[]>([])
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
    if (groupBy.value === 'client')
      keys.push({ key: it.chat.clientName || `chat:${it.chat.id}`, label: it.chat.clientName || it.chat.name, sub: it.chat.clientName ? '' : 'No client name set' })
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
const noiseShare = computed(() =>
  dash.value?.messages7 ? `${Math.round((dash.value.dismissed7 / Math.max(1, dash.value.messages7)) * 100)}% of the week's traffic` : 'nothing yet this week',
)
</script>

<template>
  <div class="rise">
    <div class="mb-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Open items" :value="openCount" :hint="`${dash?.items.NEW ?? 0} new · ${dash?.items.IN_PROGRESS ?? 0} in progress`" tone="accent" />
      <StatCard label="Done" :value="dash?.items.DONE ?? 0" :hint="`${dash?.items.DISMISSED ?? 0} dismissed`" />
      <StatCard label="Tracked chats" :value="dash?.trackedChats ?? 0" :hint="`${dash?.messages7 ?? 0} messages this week`" />
      <StatCard
        label="Waiting to be read"
        :value="dash?.pendingMessages ?? 0"
        hint="stored, not yet bundled"
        :tone="(dash?.pendingMessages ?? 0) > 50 ? 'warn' : 'neutral'"
      />
      <StatCard label="Dismissed as noise" :value="dash?.dismissed7 ?? 0" :hint="noiseShare" />
      <StatCard label="Model cost, 7 days" :value="usd(dash?.cost.d7 ?? 0)" :hint="`${dash?.cost.calls7 ?? 0} calls · ${usd(dash?.cost.d30 ?? 0)} over 30 days`" />
    </div>

    <div class="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-nowrap lg:items-center">
      <div class="no-bar flex gap-1 overflow-x-auto rounded-md border border-line-200 bg-surface-0 p-1 lg:min-w-0">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="shrink-0 rounded-sm px-3 py-1.5 text-[14px] leading-5 whitespace-nowrap"
          :class="tab === t.key ? 'bg-ink-900 font-medium text-white' : 'text-ink-500 hover:bg-surface-50 hover:text-ink-900'"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span class="num ml-1 opacity-70">{{ t.key === 'open' ? openCount : t.key === 'all' ? '' : (dash?.items[t.key] ?? 0) }}</span>
        </button>
      </div>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center lg:ml-auto">
        <div class="flex items-center gap-2">
          <span class="shrink-0 text-[13px] leading-[18px] text-ink-500">Group by</span>
          <!-- flex-1 only while stacked. Left on at desktop it grew to fill
               the row and pushed the whole control group onto a second line. -->
          <div class="no-bar flex flex-1 gap-1 overflow-x-auto rounded-md border border-line-200 bg-surface-0 p-1 sm:flex-none">
            <button
              v-for="g in ['client', 'chat', 'rule', 'none']"
              :key="g"
              class="shrink-0 rounded-sm px-2.5 py-1 text-[13px] capitalize"
              :class="groupBy === g ? 'bg-ink-900 font-medium text-white' : 'text-ink-500 hover:bg-surface-50 hover:text-ink-900'"
              @click="groupBy = g as never"
            >
              {{ g }}
            </button>
          </div>
        </div>
        <div class="relative w-full sm:w-56">
          <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" :stroke-width="1.5" />
          <input v-model="q" class="field pl-9" placeholder="Search items…" aria-label="Search items" />
        </div>
      </div>
    </div>

    <EmptyState
      v-if="!loading && !items.length"
      title="Nothing here yet"
      :hint="
        tab === 'open'
          ? 'Items appear once a tracked chat says something that matches one of its rules. Start by choosing chats to read and writing a rule.'
          : 'No items with this status.'
      "
    >
      <RouterLink to="/chats"><BaseButton variant="primary">Choose chats &amp; rules</BaseButton></RouterLink>
    </EmptyState>

    <div v-for="g in groups" :key="g.key" class="mb-6">
      <div class="mb-2 flex items-baseline gap-2 px-0.5">
        <h3 class="text-[15px] font-semibold leading-[22px]">{{ g.label }}</h3>
        <span v-if="g.sub" class="text-[13px] leading-[18px] text-ink-500">{{ g.sub }}</span>
        <span class="num ml-auto text-[13px] leading-[18px] text-ink-500">{{ g.items.length }}</span>
      </div>
      <div class="card divide-y divide-line-100 overflow-hidden">
        <RouterLink v-for="it in g.items" :key="it.id" :to="`/items/${it.id}`" class="flex items-start gap-3 px-5 py-4 hover:bg-surface-50">
          <span
            class="mt-1.5 size-2 shrink-0 rounded-full"
            :class="
              it.priority === 'URGENT'
                ? 'bg-danger-600'
                : it.priority === 'HIGH'
                  ? 'bg-warning-600'
                  : it.status === 'DONE'
                    ? 'bg-success-600'
                    : it.status === 'DISMISSED'
                      ? 'bg-ink-300'
                      : 'bg-primary-600'
            "
          />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p class="text-[15px] font-semibold leading-[22px] text-ink-900">{{ it.title }}</p>
              <BaseBadge :tone="STATUS_TONE[it.status]">{{ STATUS_LABEL[it.status] }}</BaseBadge>
              <BaseBadge v-if="it.priority === 'HIGH' || it.priority === 'URGENT'" :tone="PRIORITY_TONE[it.priority]">{{ it.priority }}</BaseBadge>
            </div>
            <p class="mt-1 line-clamp-2 text-[14px] leading-5 text-ink-600">{{ it.brief }}</p>
            <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-[18px] text-ink-500">
              <span v-if="groupBy !== 'chat'">{{ it.chat.name }}</span>
              <span v-for="r in it.rules" :key="r.id" class="rounded-full bg-line-100 px-2 py-0.5 text-ink-600">{{ r.text }}</span>
              <span class="inline-flex items-center gap-1"><MessageSquareText class="size-3.5" :stroke-width="1.5" /> {{ it.counts.messages }}</span>
              <span v-if="it.counts.deliveries" class="inline-flex items-center gap-1"><Send class="size-3.5" :stroke-width="1.5" /> {{ it.counts.deliveries }}</span>
              <span class="ml-auto">{{ ago(it.lastActivityAt) }}</span>
            </div>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>
</template>
