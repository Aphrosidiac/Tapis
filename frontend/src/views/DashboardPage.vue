<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { usePolling } from '../composables/usePolling'
import { useToast } from '../composables/useToast'
import { ago, usd, STATUS_LABEL, STATUS_TONE, PRIORITY_TONE } from '../lib/format'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseButton from '../components/base/BaseButton.vue'
import EmptyState from '../components/base/EmptyState.vue'
import { MessageSquareText, Send, Search, MessageCircleQuestion, Hourglass, Flame, CheckCircle2, CircleCheckBig, X, Circle } from 'lucide-vue-next'

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
  /// When the client last came back to ask whether this was done.
  chasedAt: string | null
  teamStatus?: 'NONE' | 'IN_PROGRESS' | 'RESOLVED'
  teamBy?: string | null
}

interface Bucket { count: number; clients: string[]; moreClients: number }
interface Triage {
  chased: Bucket
  stale: Bucket & { oldestHours: number }
  urgent: Bucket & { urgentCount: number }
  ready: Bucket & { by: string[] }
}
interface Dash {
  setup: { link: boolean; key: boolean; chats: boolean; team: boolean; operator: boolean }
  items: Record<string, number>
  triage: Triage
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
/// A triage view is a filter over open work. It overrides the status tab,
/// because "urgent, but only the ones marked done" is not a question.
const view = ref<'chased' | 'stale' | 'urgent' | 'ready' | ''>('')
const groupBy = ref<'client' | 'chat' | 'rule' | 'none'>((localStorage.getItem('tapis_dash_group') as never) || 'client')
const q = ref('')

async function load() {
  try {
    const t = TABS.find((x) => x.key === tab.value) ?? TABS[0]
    const [d, i] = await Promise.all([
      api.get<Dash>('/dashboard'),
      api.get<{ items: Item[]; total: number }>('/items', {
        params: { status: view.value ? undefined : t.statuses || undefined, view: view.value || undefined, q: q.value || undefined, limit: 300 },
      }),
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
watch(view, load)
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

/// Five things that make the product work, in the order to do them. The
/// list disappears once they are all done.
const STEPS = [
  { key: 'link' as const, label: 'Link WhatsApp', hint: 'Scan the code on the WhatsApp link screen', to: '/whatsapp' },
  { key: 'key' as const, label: 'Add a model key', hint: 'OpenRouter or Anthropic, on Settings', to: '/settings' },
  { key: 'chats' as const, label: 'Set up a chat', hint: 'Switch a client group on — it drafts the context and rules for you', to: '/chats' },
  { key: 'team' as const, label: 'Mark your team', hint: 'So their replies count as your side, not as requests', to: '/settings' },
  { key: 'operator' as const, label: 'Your own number', hint: 'For the morning brief and talking to the assistant from your phone', to: '/settings' },
]
const setupLeft = computed(() => (dash.value ? STEPS.filter((s) => !dash.value!.setup[s.key]) : []))
const setupDone = computed(() => (dash.value ? STEPS.filter((s) => dash.value!.setup[s.key]).length : 0))

const openCount = computed(() => (dash.value?.items.NEW ?? 0) + (dash.value?.items.IN_PROGRESS ?? 0))

const CARDS = [
  {
    key: 'chased' as const,
    label: 'Chasing you',
    icon: MessageCircleQuestion,
    tone: 'danger',
    /// Nothing else in the product tells you a client is already unhappy.
    blurb: 'Asked again whether it is done',
  },
  { key: 'stale' as const, label: 'Left sitting', icon: Hourglass, tone: 'warning', blurb: 'Open, untouched over 48 hours' },
  { key: 'urgent' as const, label: 'Urgent & high', icon: Flame, tone: 'warning', blurb: 'Open, marked high or urgent' },
  /// The one bucket that is good news: your side said it is done, the
  /// item just has not been closed.
  { key: 'ready' as const, label: 'Ready to close', icon: CircleCheckBig, tone: 'success', blurb: 'Your side said it is done' },
]

const triage = computed(() => dash.value?.triage)
/// Only a check with something in it earns a card. Three boxes where two say
/// "Nothing" fill a phone screen with the absence of news.
const liveCards = computed(() => CARDS.filter((c) => bucket(c.key).count || view.value === c.key))
const clearCards = computed(() => CARDS.filter((c) => !bucket(c.key).count && view.value !== c.key))
const allClear = computed(() => !!triage.value && !triage.value.chased.count && !triage.value.stale.count && !triage.value.urgent.count && !triage.value.ready.count)

function bucket(key: 'chased' | 'stale' | 'urgent' | 'ready'): Bucket & { oldestHours?: number; urgentCount?: number } {
  return triage.value?.[key] ?? { count: 0, clients: [], moreClients: 0 }
}

/// The line under each card: who it is, and for age, how bad the worst is.
function detail(key: 'chased' | 'stale' | 'urgent' | 'ready'): string {
  const b = bucket(key)
  if (!b.count) return 'Nothing'
  const names = b.clients.join(', ') + (b.moreClients ? ` +${b.moreClients} more` : '')
  if (key === 'stale') {
    const h = triage.value?.stale.oldestHours ?? 0
    const age = h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hours`
    return `oldest ${age} · ${names}`
  }
  if (key === 'urgent' && triage.value?.urgent.urgentCount) return `${triage.value.urgent.urgentCount} urgent · ${names}`
  if (key === 'ready' && triage.value?.ready.by.length) return `says ${triage.value.ready.by.map((b) => (b === 'us' ? 'you' : b)).join(', ')} · ${names}`
  return names
}

function toggleView(key: 'chased' | 'stale' | 'urgent' | 'ready') {
  if (!bucket(key).count && view.value !== key) return
  view.value = view.value === key ? '' : key
}

const activeLabel = computed(() => CARDS.find((c) => c.key === view.value)?.label ?? '')

/// Ages a group's oldest open item, so a client being quietly ignored shows
/// up in the group header rather than only inside it.
function groupAge(items: Item[]): string {
  const open = items.filter((i) => i.status === 'NEW' || i.status === 'IN_PROGRESS')
  if (!open.length) return ''
  const oldest = open.reduce((a, b) => (new Date(a.lastActivityAt) < new Date(b.lastActivityAt) ? a : b))
  const h = Math.floor((Date.now() - new Date(oldest.lastActivityAt).getTime()) / 3_600_000)
  if (h < 24) return h < 1 ? '' : `oldest ${h}h`
  return `oldest ${Math.floor(h / 24)}d`
}
</script>

<template>
  <div class="rise">
    <section v-if="dash && setupLeft.length" class="card mb-5 overflow-hidden">
      <div class="flex items-center justify-between gap-3 border-b border-line-100 px-5 py-3">
        <p class="text-[14px] font-medium leading-5 text-ink-900">Getting started</p>
        <p class="text-[13px] leading-[18px] text-ink-500"><span class="num">{{ setupDone }}</span> of {{ STEPS.length }} done</p>
      </div>
      <div class="divide-y divide-line-100">
        <RouterLink v-for="s in STEPS" :key="s.key" :to="s.to" class="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-50" :class="dash.setup[s.key] && 'opacity-60'">
          <CheckCircle2 v-if="dash.setup[s.key]" class="size-4 shrink-0 text-success-600" :stroke-width="1.75" />
          <Circle v-else class="size-4 shrink-0 text-ink-300" :stroke-width="1.75" />
          <span class="min-w-0 flex-1">
            <span class="block text-[14px] leading-5" :class="dash.setup[s.key] ? 'text-ink-500 line-through' : 'text-ink-900'">{{ s.label }}</span>
            <span v-if="!dash.setup[s.key]" class="block truncate text-[13px] leading-[18px] text-ink-500">{{ s.hint }}</span>
          </span>
        </RouterLink>
      </div>
    </section>

    <!-- Triage, not statistics. Each card is a question an owner actually
         has, and each one is a filter you can click. The counts that used to
         live up here (tracked chats, model cost, how much was dismissed) are
         real but they are not decisions, so they sit in one quiet line at
         the bottom instead of six boxes at the top. -->
    <div v-if="allClear" class="card mb-5 flex items-center gap-3 px-5 py-4">
      <CheckCircle2 class="size-5 shrink-0 text-success-600" :stroke-width="1.75" />
      <div>
        <p class="text-[15px] font-semibold leading-[22px]">Nothing is waiting on you</p>
        <p class="text-[13px] leading-[18px] text-ink-500">
          {{ openCount }} open item{{ openCount === 1 ? '' : 's' }}, none chased, none older than 48 hours, none urgent.
        </p>
      </div>
    </div>

    <div v-else class="mb-5 flex flex-wrap gap-3 sm:gap-4">
      <button
        v-for="c in liveCards"
        :key="c.key"
        type="button"
        :disabled="!bucket(c.key).count && view !== c.key"
        :aria-pressed="view === c.key"
        class="card flex min-w-[240px] flex-1 items-start gap-3 p-4 text-left transition-colors disabled:cursor-default disabled:opacity-60 sm:p-5"
        :class="
          view === c.key
            ? 'border-ink-900 ring-1 ring-ink-900'
            : bucket(c.key).count
              ? 'hover:border-line-200 hover:bg-surface-50'
              : ''
        "
        @click="toggleView(c.key)"
      >
        <component
          :is="c.icon"
          class="mt-0.5 size-5 shrink-0"
          :class="bucket(c.key).count ? (c.tone === 'danger' ? 'text-danger-600' : c.tone === 'success' ? 'text-success-600' : 'text-warning-600') : 'text-ink-400'"
          :stroke-width="1.75"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1">
          <span class="flex items-baseline gap-2">
            <span class="num text-[24px] font-semibold leading-7 tracking-[-0.01em]" :class="bucket(c.key).count ? 'text-ink-900' : 'text-ink-400'">
              {{ bucket(c.key).count }}
            </span>
            <span class="text-[14px] font-semibold leading-5 text-ink-900">{{ c.label }}</span>
          </span>
          <span class="mt-1 block truncate text-[13px] leading-[18px] text-ink-500">{{ detail(c.key) }}</span>
          <span class="mt-0.5 block text-[12px] leading-4 text-ink-400">{{ c.blurb }}</span>
        </span>
      </button>
    </div>

    <p v-if="!allClear && clearCards.length" class="-mt-2 mb-5 text-[13px] leading-[18px] text-ink-500">
      Also clear:
      <template v-for="(c, idx) in clearCards" :key="c.key">
        {{ idx ? ', ' : '' }}<span class="lowercase">nothing {{ c.key === 'chased' ? 'chasing you' : c.key === 'stale' ? 'left sitting' : c.key === 'ready' ? 'ready to close' : 'urgent or high' }}</span>
      </template>.
    </p>

    <div class="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-nowrap lg:items-center">
      <!-- A view already decided the status, so showing the tabs as though
           they were still in charge would be a lie. -->
      <div v-if="view" class="flex items-center gap-2 rounded-md border border-ink-900 bg-ink-900 px-3 py-1.5 text-[14px] leading-5 text-white">
        <span>Showing: {{ activeLabel.toLowerCase() }}</span>
        <button class="-mr-1 grid size-6 place-items-center rounded-sm hover:bg-white/15" aria-label="Show all items again" @click="view = ''">
          <X class="size-3.5" />
        </button>
      </div>
      <div v-else class="no-bar flex gap-1 overflow-x-auto rounded-md border border-line-200 bg-surface-0 p-1 lg:min-w-0">
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
      <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
        <h3 class="text-[15px] font-semibold leading-[22px]">{{ g.label }}</h3>
        <span v-if="g.sub" class="text-[13px] leading-[18px] text-ink-500">{{ g.sub }}</span>
        <!-- A client being quietly ignored should be visible from the header,
             not only by opening every item under it. -->
        <BaseBadge v-if="g.items.some((i) => i.chasedAt && (i.status === 'NEW' || i.status === 'IN_PROGRESS'))" tone="bad">chasing</BaseBadge>
        <span v-if="groupAge(g.items)" class="text-[13px] leading-[18px] text-ink-500">{{ groupAge(g.items) }}</span>
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
              <BaseBadge v-if="it.chasedAt && (it.status === 'NEW' || it.status === 'IN_PROGRESS')" tone="bad">chased {{ ago(it.chasedAt) }}</BaseBadge>
              <BaseBadge v-if="it.teamStatus === 'RESOLVED' && (it.status === 'NEW' || it.status === 'IN_PROGRESS')" tone="ok">{{ it.teamBy === 'us' ? 'you' : it.teamBy || 'your side' }} says done</BaseBadge>
              <BaseBadge v-else-if="it.teamStatus === 'IN_PROGRESS' && it.status === 'NEW'" tone="info">{{ it.teamBy === 'us' ? 'you' : it.teamBy || 'your side' }} on it</BaseBadge>
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

    <!-- The numbers that used to be six cards. Real, worth knowing, not
         decisions — so they get one line at the bottom. -->
    <p v-if="dash" class="mt-6 border-t border-line-100 pt-4 text-[13px] leading-[18px] text-ink-500">
      <span class="num">{{ openCount }}</span> open ·
      <span class="num">{{ dash.items.DONE }}</span> done ·
      <span class="num">{{ dash.trackedChats }}</span> chat{{ dash.trackedChats === 1 ? '' : 's' }} being read ·
      <span class="num">{{ dash.messages7 }}</span> messages this week, <span class="num">{{ dash.messages7 ? Math.round((dash.dismissed7 / dash.messages7) * 100) : 0 }}%</span> filtered out as noise ·
      <span class="num">{{ usd(dash.cost.d7) }}</span> on models in 7 days
      <template v-if="dash.pendingMessages">
        · <span class="num">{{ dash.pendingMessages }}</span> messages waiting to be read
      </template>
      <RouterLink to="/review" class="ml-1 font-medium text-primary-700 hover:underline">Review</RouterLink>
    </p>
  </div>
</template>
