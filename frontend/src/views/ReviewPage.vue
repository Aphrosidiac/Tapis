<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { usePolling } from '../composables/usePolling'
import { fmtDateTime, ago, senderOf, bodyOf } from '../lib/format'
import PageHeader from '../components/base/PageHeader.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import EmptyState from '../components/base/EmptyState.vue'
import { LifeBuoy, RotateCcw, Trash2, Search } from 'lucide-vue-next'

interface Msg {
  id: string
  senderName: string | null
  senderWaId: string
  fromMe: boolean
  type: string
  text: string | null
  sentAt: string
  filterReason: string | null
  chat: { id: string; name: string; clientName: string | null }
}
interface Call { kind: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; latencyMs: number; ok: boolean }
interface Bundle {
  id: string
  status: string
  trigger: string
  messageCount: number
  flaggedCount: number
  itemsCreated: number
  itemsUpdated: number
  error: string | null
  createdAt: string
  completedAt: string | null
  chat: { id: string; name: string }
  llmCalls: Call[]
}
interface Feedback { id: string; kind: string; text: string; createdAt: string; chat: { id: string; name: string } }

const { ok, bad } = useToast()
const tab = ref<'dismissed' | 'runs' | 'learned'>('dismissed')
const dismissed = ref<Msg[]>([])
const total = ref(0)
const bundles = ref<Bundle[]>([])
const feedback = ref<Feedback[]>([])
const chats = ref<{ id: string; name: string }[]>([])
const chatId = ref('')
const q = ref('')
const busy = ref('')

async function load() {
  try {
    const [d, b, f, c] = await Promise.all([
      api.get<{ messages: Msg[]; total: number }>('/review/dismissed', { params: { chatId: chatId.value || undefined, q: q.value || undefined, limit: 100 } }),
      api.get<{ bundles: Bundle[] }>('/review/bundles', { params: { chatId: chatId.value || undefined, limit: 60 } }),
      api.get<{ feedback: Feedback[] }>('/review/feedback', { params: { chatId: chatId.value || undefined } }),
      api.get<{ chats: { id: string; name: string }[] }>('/chats', { params: { tracked: true } }),
    ])
    dismissed.value = d.data.messages
    total.value = d.data.total
    bundles.value = b.data.bundles
    feedback.value = f.data.feedback
    chats.value = c.data.chats
  } catch (e) {
    bad(errorMessage(e))
  }
}
usePolling(load, 20_000)
watch(chatId, load)
let t: number | null = null
watch(q, () => {
  if (t) clearTimeout(t)
  t = window.setTimeout(load, 250)
})

async function rescue(m: Msg) {
  busy.value = m.id
  try {
    const { data } = await api.post<{ message: { itemLinks: { itemId: string }[] } }>(`/review/rescue/${m.id}`, {})
    const linked = data.message?.itemLinks?.length
    ok(
      linked
        ? 'Rescued: it is now part of an item, and the filter will remember.'
        : 'Rescued and analysed, but nothing actionable was found. The correction is still remembered.',
    )
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function retry(b: Bundle) {
  busy.value = b.id
  try {
    await api.post(`/review/bundles/${b.id}/retry`, {})
    await load()
    ok('Run retried')
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function forget(f: Feedback) {
  try {
    await api.delete(`/review/feedback/${f.id}`)
    feedback.value = feedback.value.filter((x) => x.id !== f.id)
  } catch (e) {
    bad(errorMessage(e))
  }
}
const tokens = (b: Bundle) => b.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0)
const STATUS_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info'> = { DONE: 'ok', FAILED: 'bad', FILTERING: 'warn', ANALYZING: 'info' }
</script>

<template>
  <div class="rise">
    <PageHeader title="Review" subtitle="What the filter threw away, every pipeline run, and the corrections it has learned from." />

    <div class="mb-4 flex flex-wrap items-center gap-3">
      <div class="flex gap-1 rounded-md border border-line-200 bg-surface-0 p-1">
        <button
          v-for="t2 in [
            ['dismissed', 'Dismissed', total],
            ['runs', 'Pipeline runs', bundles.length],
            ['learned', 'Learned', feedback.length],
          ]"
          :key="t2[0] as string"
          class="rounded-sm px-3 py-1.5 text-[14px] leading-5"
          :class="tab === t2[0] ? 'bg-ink-900 font-medium text-white' : 'text-ink-500 hover:bg-surface-50 hover:text-ink-900'"
          @click="tab = t2[0] as never"
        >
          {{ t2[1] }} <span class="num opacity-70">{{ t2[2] }}</span>
        </button>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <div class="w-52"><BaseSelect v-model="chatId" :options="chats.map((c) => ({ value: c.id, label: c.name }))" placeholder="All chats" /></div>
        <div v-if="tab === 'dismissed'" class="relative w-52">
          <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" :stroke-width="1.5" />
          <input v-model="q" class="field pl-9" placeholder="Search text…" aria-label="Search dismissed messages" />
        </div>
      </div>
    </div>

    <template v-if="tab === 'dismissed'">
      <EmptyState
        v-if="!dismissed.length"
        title="Nothing dismissed"
        hint="Every message the first pass judged as noise lands here. Rescue one and it goes straight to analysis — and the filter is shown it next time as an example of what matters."
      />
      <div v-else class="card divide-y divide-line-100 overflow-hidden">
        <div v-for="m in dismissed" :key="m.id" class="flex items-start gap-4 px-5 py-3.5">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 text-[13px] leading-[18px] text-ink-500">
              <span class="font-medium text-ink-900">{{ senderOf(m) }}</span>
              <RouterLink :to="`/chats/${m.chat.id}`" class="hover:text-ink-900">
                {{ m.chat.clientName ? `${m.chat.clientName} · ` : '' }}{{ m.chat.name }}
              </RouterLink>
              <span>{{ fmtDateTime(m.sentAt) }}</span>
            </div>
            <p class="original mt-1 text-[15px] leading-[22px] text-ink-800">{{ bodyOf(m) }}</p>
            <p class="text-[13px] leading-[18px] text-ink-500 italic">{{ m.filterReason }}</p>
          </div>
          <BaseButton size="sm" variant="secondary" :loading="busy === m.id" @click="rescue(m)">
            <LifeBuoy class="size-4" :stroke-width="1.5" /> Rescue
          </BaseButton>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'runs'">
      <EmptyState v-if="!bundles.length" title="No runs yet" hint="A run happens when a tracked chat goes quiet, fills up, or you press Run now." />
      <div v-else class="card divide-y divide-line-100 overflow-hidden">
        <div v-for="b in bundles" :key="b.id" class="px-5 py-3.5">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] leading-5">
            <BaseBadge :tone="STATUS_TONE[b.status] ?? 'neutral'">{{ b.status.toLowerCase() }}</BaseBadge>
            <RouterLink :to="`/chats/${b.chat.id}`" class="font-medium text-ink-900 hover:underline">{{ b.chat.name }}</RouterLink>
            <span class="text-[13px] leading-[18px] text-ink-500">{{ b.trigger }} · {{ ago(b.createdAt) }}</span>
            <span class="num text-[13px] leading-[18px] text-ink-600">
              {{ b.messageCount }} msgs → {{ b.flaggedCount }} flagged → {{ b.itemsCreated }} new, {{ b.itemsUpdated }} updated
            </span>
            <span v-if="b.llmCalls.length" class="num text-[13px] leading-[18px] text-ink-500">
              · {{ tokens(b).toLocaleString() }} tokens · {{ b.llmCalls.map((c) => `${c.kind.toLowerCase()} ${(c.latencyMs / 1000).toFixed(1)}s`).join(', ') }}
            </span>
            <BaseButton v-if="b.status === 'FAILED'" size="sm" variant="secondary" class="ml-auto" :loading="busy === b.id" @click="retry(b)">
              <RotateCcw class="size-4" :stroke-width="1.5" /> Retry
            </BaseButton>
          </div>
          <p v-if="b.error" class="mt-1.5 text-[13px] leading-[18px] text-danger-600">{{ b.error }}</p>
        </div>
      </div>
      <p class="mt-3 text-[13px] leading-[18px] text-ink-500">Token counts are the provider's; the dashboard turns them into money.</p>
    </template>

    <template v-else>
      <EmptyState
        v-if="!feedback.length"
        title="Nothing learned yet"
        hint="Rescuing a dismissed message, or dismissing an item, records an example the filter is shown for that chat from then on. Remove one here if it was a mistake."
      />
      <div v-else class="card divide-y divide-line-100 overflow-hidden">
        <div v-for="f in feedback" :key="f.id" class="flex items-start gap-4 px-5 py-3.5">
          <BaseBadge :tone="f.kind === 'RESCUED' ? 'ok' : 'dormant'">{{ f.kind === 'RESCUED' ? 'matters' : 'noise' }}</BaseBadge>
          <div class="min-w-0 flex-1">
            <p class="original text-[15px] leading-[22px] text-ink-800">{{ f.text }}</p>
            <p class="text-[13px] leading-[18px] text-ink-500">{{ f.chat.name }} · {{ ago(f.createdAt) }}</p>
          </div>
          <button class="rounded-sm p-1.5 text-ink-400 hover:text-danger-600" aria-label="Forget this example" @click="forget(f)">
            <Trash2 class="size-4" :stroke-width="1.5" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
