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
import BaseInput from '../components/base/BaseInput.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import EmptyState from '../components/base/EmptyState.vue'
import { LifeBuoy, RotateCcw, Trash2 } from 'lucide-vue-next'

interface Msg { id: string; senderName: string | null; senderWaId: string; fromMe: boolean; type: string; text: string | null; sentAt: string; filterReason: string | null; chat: { id: string; name: string; clientName: string | null } }
interface Call { kind: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; latencyMs: number; ok: boolean }
interface Bundle { id: string; status: string; trigger: string; messageCount: number; flaggedCount: number; itemsCreated: number; itemsUpdated: number; error: string | null; createdAt: string; completedAt: string | null; chat: { id: string; name: string }; llmCalls: Call[] }
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
    ok(linked ? 'Rescued: it is now part of an item, and the filter will remember.' : 'Rescued and analysed, but the analysis found nothing actionable. The correction is still remembered.')
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
function cost(b: Bundle) {
  return b.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0)
}
const STATUS_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info'> = { DONE: 'ok', FAILED: 'bad', FILTERING: 'warn', ANALYZING: 'info' }
</script>

<template>
  <div class="animate-page-in">
    <PageHeader title="Review" subtitle="What the filter threw away, every pipeline run, and the corrections it has learned from." />

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="flex">
        <button :class="['tab px-3 py-1.5 text-[12.5px]', tab === 'dismissed' && 'tab-on']" @click="tab = 'dismissed'">Dismissed <span class="text-faint tabular">{{ total }}</span></button>
        <button :class="['tab px-3 py-1.5 text-[12.5px]', tab === 'runs' && 'tab-on']" @click="tab = 'runs'">Pipeline runs <span v-if="bundles.some((b) => b.status === 'FAILED')" class="text-bad tabular">{{ bundles.filter((b) => b.status === 'FAILED').length }} failed</span></button>
        <button :class="['tab px-3 py-1.5 text-[12.5px]', tab === 'learned' && 'tab-on']" @click="tab = 'learned'">Learned <span class="text-faint tabular">{{ feedback.length }}</span></button>
      </div>
      <div class="ml-auto flex gap-2">
        <div class="w-48"><BaseSelect v-model="chatId" :options="chats.map((c) => ({ value: c.id, label: c.name }))" placeholder="All chats" /></div>
        <div v-if="tab === 'dismissed'" class="w-44"><BaseInput v-model="q" placeholder="Search text…" /></div>
      </div>
    </div>

    <template v-if="tab === 'dismissed'">
      <EmptyState v-if="!dismissed.length" title="Nothing dismissed" hint="Every message the first pass judged as noise lands here. Rescue one and it goes straight to analysis — and the filter is shown it next time as an example of what matters." />
      <div v-else class="overflow-hidden rounded-md border border-line bg-surface">
        <div v-for="m in dismissed" :key="m.id" class="flex items-start gap-3 border-b border-hair px-4 py-2.5 last:border-b-0">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 text-[11.5px] text-faint">
              <span class="font-semibold text-ink">{{ senderOf(m) }}</span>
              <RouterLink :to="`/chats/${m.chat.id}`" class="hover:text-ink">{{ m.chat.clientName ? `${m.chat.clientName} · ` : '' }}{{ m.chat.name }}</RouterLink>
              <span>{{ fmtDateTime(m.sentAt) }}</span>
            </div>
            <p class="original mt-0.5 text-[13px] text-ink">{{ bodyOf(m) }}</p>
            <p class="text-[11.5px] italic text-faint">{{ m.filterReason }}</p>
          </div>
          <BaseButton size="sm" variant="secondary" :loading="busy === m.id" @click="rescue(m)"><LifeBuoy class="h-3.5 w-3.5" /> Rescue</BaseButton>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'runs'">
      <EmptyState v-if="!bundles.length" title="No runs yet" hint="A run happens when a tracked chat goes quiet, fills up, or you press Run now." />
      <div v-else class="overflow-hidden rounded-md border border-line bg-surface">
        <div v-for="b in bundles" :key="b.id" class="border-b border-hair px-4 py-2.5 last:border-b-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <BaseBadge :tone="STATUS_TONE[b.status] ?? 'neutral'">{{ b.status.toLowerCase() }}</BaseBadge>
            <RouterLink :to="`/chats/${b.chat.id}`" class="font-semibold text-ink hover:underline">{{ b.chat.name }}</RouterLink>
            <span class="text-faint">{{ b.trigger }} · {{ ago(b.createdAt) }}</span>
            <span class="text-muted tabular">{{ b.messageCount }} msgs → {{ b.flaggedCount }} flagged → {{ b.itemsCreated }} new, {{ b.itemsUpdated }} updated</span>
            <span v-if="b.llmCalls.length" class="text-faint tabular">· {{ cost(b).toLocaleString() }} tokens · {{ b.llmCalls.map((c) => `${c.kind.toLowerCase()} ${(c.latencyMs / 1000).toFixed(1)}s`).join(', ') }}</span>
            <BaseButton v-if="b.status === 'FAILED'" size="sm" variant="secondary" class="ml-auto" :loading="busy === b.id" @click="retry(b)"><RotateCcw class="h-3.5 w-3.5" /> Retry</BaseButton>
          </div>
          <p v-if="b.error" class="mt-1 text-[12px] text-bad">{{ b.error }}</p>
        </div>
      </div>
    </template>

    <template v-else>
      <EmptyState v-if="!feedback.length" title="Nothing learned yet" hint="Rescuing a dismissed message, or dismissing an item, records an example the filter is shown for that chat from then on. Remove one here if it was a mistake." />
      <div v-else class="overflow-hidden rounded-md border border-line bg-surface">
        <div v-for="f in feedback" :key="f.id" class="flex items-start gap-3 border-b border-hair px-4 py-2.5 last:border-b-0">
          <BaseBadge :tone="f.kind === 'RESCUED' ? 'ok' : 'dormant'">{{ f.kind === 'RESCUED' ? 'matters' : 'noise' }}</BaseBadge>
          <div class="min-w-0 flex-1">
            <p class="original text-[13px] text-ink">{{ f.text }}</p>
            <p class="text-[11.5px] text-faint">{{ f.chat.name }} · {{ ago(f.createdAt) }}</p>
          </div>
          <button class="p-1 text-faint hover:text-bad" aria-label="Forget" @click="forget(f)"><Trash2 class="h-3.5 w-3.5" /></button>
        </div>
      </div>
    </template>
    <p v-if="tab === 'runs'" class="mt-2 text-[11.5px] text-faint">Token counts are the provider's; the dashboard turns them into money.</p>
  </div>
</template>
