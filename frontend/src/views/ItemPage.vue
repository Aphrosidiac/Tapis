<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import MediaSrc from '../components/MediaSrc.vue'
import MediaText, { type MediaTextMessage } from '../components/MediaText.vue'
import { useToast } from '../composables/useToast'
import { fmtDateTime, ago, senderOf, bodyOf, STATUS_LABEL, STATUS_TONE, PRIORITY_TONE } from '../lib/format'
import Card from '../components/base/Card.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseTextarea from '../components/base/BaseTextarea.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import { ArrowLeft, Send } from 'lucide-vue-next'

interface Msg {
  id: string
  senderName: string | null
  senderWaId: string
  fromMe: boolean
  type: string
  text: string | null
  mediaPath: string | null
  mediaText?: string | null
  mediaTextStatus?: string
  mediaTextError?: string | null
  mediaTextModel?: string | null
  mediaMime: string | null
  sentAt: string
  filterReason: string | null
  link: { kind: string; note: string | null }
}
interface Item {
  id: string
  title: string
  brief: string
  suggestion: string
  extra: { label: string; value: string }[]
  status: string
  priority: string
  firstMessageAt: string
  lastActivityAt: string
  createdAt: string
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
function patchMessage(target: { id: string } & Record<string, unknown>, u: MediaTextMessage) {
  Object.assign(target, { mediaText: u.mediaText, mediaTextStatus: u.mediaTextStatus, mediaTextError: u.mediaTextError, mediaTextModel: u.mediaTextModel })
}
</script>

<template>
  <div v-if="item" class="rise">
    <RouterLink to="/" class="tap-target mb-2 inline-flex items-center gap-1.5 text-[14px] leading-5 text-ink-500 hover:text-ink-900 lg:mb-4">
      <ArrowLeft class="size-4" :stroke-width="1.5" /> Dashboard
    </RouterLink>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div class="space-y-6">
        <div class="card p-6">
          <div class="flex flex-wrap items-center gap-2">
            <BaseBadge :tone="STATUS_TONE[item.status]">{{ STATUS_LABEL[item.status] }}</BaseBadge>
            <BaseBadge v-if="item.priority !== 'NORMAL'" :tone="PRIORITY_TONE[item.priority]">{{ item.priority }}</BaseBadge>
            <RouterLink :to="`/chats/${item.chat.id}`" class="text-[13px] leading-[18px] text-ink-500 hover:text-ink-900">
              {{ item.chat.clientName ? `${item.chat.clientName} · ` : '' }}{{ item.chat.name }}
            </RouterLink>
            <span class="text-[13px] leading-[18px] text-ink-500">· first raised {{ fmtDateTime(item.firstMessageAt) }} · last activity {{ ago(item.lastActivityAt) }}</span>
          </div>
          <h1 class="mt-3 text-[22px] font-semibold leading-8 tracking-[-0.015em]">{{ item.title }}</h1>
          <div v-if="item.rules.length" class="mt-3 flex flex-wrap gap-1.5">
            <span v-for="r in item.rules" :key="r.id" class="rounded-full bg-line-100 px-2.5 py-0.5 text-[13px] leading-5 text-ink-600">{{ r.text }}</span>
          </div>

          <p class="eyebrow mt-6">What they want</p>
          <p class="mt-1.5 whitespace-pre-wrap text-[15px] leading-[22px] text-ink-800">{{ item.brief }}</p>

          <p class="eyebrow mt-6">Suggested next steps</p>
          <p class="mt-1.5 whitespace-pre-wrap text-[15px] leading-[22px] text-ink-800">{{ item.suggestion || '—' }}</p>

          <template v-if="item.extra.length">
            <p class="eyebrow mt-6">Also asked by the rule</p>
            <dl class="mt-2 grid gap-x-6 gap-y-1.5 text-[14px] leading-5 sm:grid-cols-[max-content_1fr]">
              <template v-for="e in item.extra" :key="e.label">
                <dt class="font-medium text-ink-500">{{ e.label }}</dt>
                <dd class="text-ink-800">{{ e.value }}</dd>
              </template>
            </dl>
          </template>
        </div>

        <Card title="What the client actually said" :sub="`Exact originals, never rewritten. ${item.messages.length} message${item.messages.length === 1 ? '' : 's'}.`" flush>
          <div class="divide-y divide-line-100">
            <div v-for="m in item.messages" :key="m.id" class="px-6 py-4">
              <div class="flex flex-wrap items-center gap-2 text-[13px] leading-[18px] text-ink-500">
                <span class="font-medium text-ink-900">{{ senderOf(m) }}</span>
                <span>{{ fmtDateTime(m.sentAt) }}</span>
                <BaseBadge :tone="KIND_TONE[m.link.kind]">{{ KIND[m.link.kind] }}</BaseBadge>
              </div>
              <p class="original mt-1.5 text-[15px] leading-[22px] text-ink-800">{{ bodyOf(m) }}</p>
              <MediaSrc v-if="m.type === 'IMAGE' && m.mediaPath" v-slot="{ src }" :message-id="m.id">
                <img :src="src" alt="" class="mt-3 max-h-80 rounded-md border border-line-200" />
              </MediaSrc>
              <MediaSrc v-else-if="m.type === 'AUDIO' && m.mediaPath" v-slot="{ src }" :message-id="m.id">
                <audio :src="src" controls class="mt-3 h-9 w-full max-w-sm" />
              </MediaSrc>
              <MediaText :message="m" @updated="(u) => patchMessage(m, u)" />
              <p v-if="m.link.note" class="mt-1.5 text-[14px] leading-5 text-ink-500 italic">{{ m.link.note }}</p>
            </div>
          </div>
        </Card>
      </div>

      <div class="space-y-6">
        <Card title="Status">
          <div class="grid grid-cols-2 gap-2">
            <BaseButton
              v-for="s in ['NEW', 'IN_PROGRESS', 'DONE', 'DISMISSED']"
              :key="s"
              size="sm"
              :variant="item.status === s ? 'primary' : 'secondary'"
              :loading="busy === s"
              @click="update({ status: s }, s)"
            >
              {{ STATUS_LABEL[s] }}
            </BaseButton>
          </div>
          <p v-if="item.status !== 'DISMISSED'" class="mt-3 text-[13px] leading-[18px] text-ink-500">
            Dismissing tells the filter that messages like these are noise in this chat.
          </p>
          <div class="mt-4">
            <BaseSelect
              label="Priority"
              :model-value="item.priority"
              :options="['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => ({ value: p, label: p.charAt(0) + p.slice(1).toLowerCase() }))"
              @update:model-value="(v) => update({ priority: v }, 'priority')"
            />
          </div>
        </Card>

        <Card title="Send to WhatsApp">
          <div v-for="d in item.deliveries" :key="d.id" class="mb-2 flex items-center justify-between gap-2 text-[14px] leading-5">
            <span class="num text-ink-800">+{{ d.toWaId }}</span>
            <BaseBadge :tone="d.status === 'SENT' ? 'ok' : d.status === 'FAILED' ? 'bad' : 'warn'">
              {{ d.status === 'PENDING' ? `queued${d.attempts ? ` · ${d.attempts} tries` : ''}` : d.status.toLowerCase() }}
            </BaseBadge>
          </div>
          <p v-for="d in item.deliveries.filter((x) => x.error)" :key="d.id + 'e'" class="mb-1 text-[13px] leading-[18px] text-danger-600">{{ d.error }}</p>
          <div class="mt-3 flex items-end gap-2">
            <div class="min-w-0 flex-1"><BaseInput v-model="sendTo" placeholder="60123456789" /></div>
            <BaseButton variant="secondary" :loading="busy === 'send'" :disabled="!sendTo" @click="send" aria-label="Send this item to that number">
              <Send class="size-4" :stroke-width="1.5" />
            </BaseButton>
          </div>
        </Card>

        <Card title="Timeline">
          <ol class="space-y-3">
            <li v-for="e in item.events" :key="e.id" class="border-l-2 border-line-200 pl-3">
              <p class="text-[14px] leading-5 text-ink-800">{{ e.detail }}</p>
              <p class="text-[13px] leading-[18px] text-ink-500">{{ fmtDateTime(e.createdAt) }}</p>
            </li>
          </ol>
          <div class="mt-4 space-y-2">
            <BaseTextarea v-model="note" placeholder="Add a note…" :rows="2" />
            <BaseButton size="sm" variant="secondary" :disabled="!note.trim()" :loading="busy === 'note'" @click="update({ note }, 'note')">Add note</BaseButton>
          </div>
        </Card>
      </div>
    </div>
  </div>
</template>
