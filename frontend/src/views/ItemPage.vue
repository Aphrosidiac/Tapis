<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { api, errorMessage, mediaUrl } from '../lib/api'
import { useToast } from '../composables/useToast'
import { fmtDateTime, ago, senderOf, bodyOf, STATUS_LABEL, STATUS_TONE, PRIORITY_TONE } from '../lib/format'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseTextarea from '../components/base/BaseTextarea.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import { ArrowLeft, Send } from 'lucide-vue-next'

interface Msg { id: string; senderName: string | null; senderWaId: string; fromMe: boolean; type: string; text: string | null; mediaPath: string | null; mediaMime: string | null; sentAt: string; filterReason: string | null; link: { kind: string; note: string | null } }
interface Item {
  id: string; title: string; brief: string; suggestion: string; extra: { label: string; value: string }[]; status: string; priority: string
  firstMessageAt: string; lastActivityAt: string; createdAt: string
  chat: { id: string; name: string; clientName: string | null; description: string | null }
  rules: { id: string; text: string; toWhatsapp: string[] }[]
  messages: Msg[]
  events: { id: string; kind: string; detail: string; createdAt: string }[]
  deliveries: { id: string; toWaId: string; status: string; error: string | null; attempts: number; createdAt: string; sentAt: string | null }[]
}

const route = useRoute()
const { ok, bad } = useToast()
const item = ref<Item | null>(null)
const busy = ref('')
const note = ref('')
const sendTo = ref('')

async function load() {
  try {
    const { data } = await api.get<{ item: Item }>(`/items/${route.params.id}`)
    item.value = data.item
  } catch (e) {
    bad(errorMessage(e))
  }
}
onMounted(load)

async function update(patch: Record<string, unknown>, label: string) {
  busy.value = label
  try {
    await api.put(`/items/${route.params.id}`, patch)
    await load()
    ok(label === 'note' ? 'Note added' : 'Updated')
    if (label === 'note') note.value = ''
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}

async function send() {
  busy.value = 'send'
  try {
    await api.post(`/items/${route.params.id}/send`, { to: sendTo.value })
    ok('Queued for WhatsApp. It goes out as soon as the link is connected.')
    sendTo.value = ''
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}

const KIND: Record<string, string> = { ORIGIN: 'Original', DETAIL: 'More detail', STATUS_CHECK: 'Status check', FOLLOW_UP: 'Follow-up' }
const KIND_TONE: Record<string, 'accent' | 'info' | 'warn' | 'neutral'> = { ORIGIN: 'accent', DETAIL: 'info', STATUS_CHECK: 'warn', FOLLOW_UP: 'neutral' }
</script>

<template>
  <div v-if="item" class="animate-page-in">
    <RouterLink to="/" class="mb-3 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"><ArrowLeft class="h-3.5 w-3.5" /> Dashboard</RouterLink>

    <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div class="space-y-4">
        <div class="rounded-md border border-line bg-surface p-5">
          <div class="flex flex-wrap items-center gap-2">
            <BaseBadge :tone="STATUS_TONE[item.status]">{{ STATUS_LABEL[item.status] }}</BaseBadge>
            <BaseBadge v-if="item.priority !== 'NORMAL'" :tone="PRIORITY_TONE[item.priority]">{{ item.priority }}</BaseBadge>
            <span class="text-[11.5px] text-faint">
              <RouterLink :to="`/chats/${item.chat.id}`" class="font-semibold text-muted hover:text-ink">{{ item.chat.clientName ? `${item.chat.clientName} · ` : '' }}{{ item.chat.name }}</RouterLink>
              · first raised {{ fmtDateTime(item.firstMessageAt) }} · last activity {{ ago(item.lastActivityAt) }}
            </span>
          </div>
          <h1 class="mt-2 text-[18px] font-bold leading-snug tracking-tight text-ink">{{ item.title }}</h1>
          <div v-if="item.rules.length" class="mt-2 flex flex-wrap gap-1.5">
            <span v-for="r in item.rules" :key="r.id" class="rounded-sm bg-inert px-1.5 py-0.5 text-[11.5px] text-muted">{{ r.text }}</span>
          </div>

          <p class="eyebrow mt-5">What they want</p>
          <p class="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{{ item.brief }}</p>

          <p class="eyebrow mt-5">Suggested next steps</p>
          <p class="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{{ item.suggestion || '—' }}</p>

          <template v-if="item.extra.length">
            <p class="eyebrow mt-5">Also asked by the rule</p>
            <dl class="mt-1 grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-[max-content_1fr]">
              <template v-for="e in item.extra" :key="e.label">
                <dt class="font-semibold text-muted">{{ e.label }}</dt>
                <dd class="text-ink">{{ e.value }}</dd>
              </template>
            </dl>
          </template>
        </div>

        <div class="rounded-md border border-line bg-surface">
          <div class="border-b border-hair px-5 py-3">
            <h2 class="text-[13px] font-bold">What the client actually said</h2>
            <p class="text-[11.5px] text-faint">Exact originals, never rewritten. {{ item.messages.length }} message{{ item.messages.length === 1 ? '' : 's' }}.</p>
          </div>
          <div v-for="m in item.messages" :key="m.id" class="border-b border-hair px-5 py-3 last:border-b-0">
            <div class="flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
              <span class="font-semibold text-ink">{{ senderOf(m) }}</span>
              <span>{{ fmtDateTime(m.sentAt) }}</span>
              <BaseBadge :tone="KIND_TONE[m.link.kind]">{{ KIND[m.link.kind] }}</BaseBadge>
            </div>
            <p class="original mt-1 text-[13.5px] text-ink">{{ bodyOf(m) }}</p>
            <img v-if="m.type === 'IMAGE' && m.mediaPath" :src="mediaUrl(m.id)" alt="" class="mt-2 max-h-80 rounded border border-line" />
            <audio v-else-if="m.type === 'AUDIO' && m.mediaPath" :src="mediaUrl(m.id)" controls class="mt-2 h-9 w-full max-w-sm" />
            <p v-if="m.link.note" class="mt-1 text-[12px] italic text-muted">{{ m.link.note }}</p>
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="rounded-md border border-line bg-surface p-4">
          <p class="eyebrow mb-2">Status</p>
          <div class="grid grid-cols-2 gap-1.5">
            <BaseButton v-for="s in ['NEW', 'IN_PROGRESS', 'DONE', 'DISMISSED']" :key="s" size="sm" :variant="item.status === s ? 'primary' : 'secondary'" :loading="busy === s" @click="update({ status: s }, s)">{{ STATUS_LABEL[s] }}</BaseButton>
          </div>
          <p v-if="item.status !== 'DISMISSED'" class="mt-2 text-[11px] text-faint">Dismissing tells the filter that messages like these are noise in this chat.</p>
          <div class="mt-3">
            <BaseSelect label="Priority" :model-value="item.priority" :options="['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => ({ value: p, label: p.charAt(0) + p.slice(1).toLowerCase() }))" @update:model-value="(v) => update({ priority: v }, 'priority')" />
          </div>
        </div>

        <div class="rounded-md border border-line bg-surface p-4">
          <p class="eyebrow mb-2">Send to WhatsApp</p>
          <div v-for="d in item.deliveries" :key="d.id" class="mb-1.5 flex items-center justify-between gap-2 text-[12px]">
            <span class="text-ink">+{{ d.toWaId }}</span>
            <BaseBadge :tone="d.status === 'SENT' ? 'ok' : d.status === 'FAILED' ? 'bad' : 'warn'">{{ d.status === 'PENDING' ? `queued${d.attempts ? ` · ${d.attempts} tries` : ''}` : d.status.toLowerCase() }}</BaseBadge>
          </div>
          <p v-for="d in item.deliveries.filter((x) => x.error)" :key="d.id + 'e'" class="mb-1 text-[11px] text-bad">{{ d.error }}</p>
          <div class="mt-2 flex gap-1.5">
            <BaseInput v-model="sendTo" placeholder="60123456789" />
            <BaseButton variant="secondary" :loading="busy === 'send'" :disabled="!sendTo" @click="send"><Send class="h-3.5 w-3.5" /></BaseButton>
          </div>
        </div>

        <div class="rounded-md border border-line bg-surface p-4">
          <p class="eyebrow mb-2">Timeline</p>
          <ol class="space-y-2">
            <li v-for="e in item.events" :key="e.id" class="text-[12px]">
              <p class="text-ink">{{ e.detail }}</p>
              <p class="text-[11px] text-faint">{{ fmtDateTime(e.createdAt) }}</p>
            </li>
          </ol>
          <div class="mt-3 space-y-1.5">
            <BaseTextarea v-model="note" placeholder="Add a note…" :rows="2" />
            <BaseButton size="sm" variant="secondary" :disabled="!note.trim()" :loading="busy === 'note'" @click="update({ note }, 'note')">Add note</BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
