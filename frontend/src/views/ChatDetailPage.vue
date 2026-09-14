<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { usePolling } from '../composables/usePolling'
import { fmtDateTime, senderOf, bodyOf, FILTER_LABEL, FILTER_TONE } from '../lib/format'
import MediaText from '../components/MediaText.vue'
import TranslationLine from '../components/TranslationLine.vue'
import PageHeader from '../components/base/PageHeader.vue'
import Card from '../components/base/Card.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseTextarea from '../components/base/BaseTextarea.vue'
import BaseToggle from '../components/base/BaseToggle.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import RuleModal, { type Rule } from '../components/RuleModal.vue'
import { ArrowLeft, Plus, Pencil, Trash2, Play, User, LifeBuoy, Sparkles } from 'lucide-vue-next'
import SetupSheet from '../components/SetupSheet.vue'

interface Participant { waId: string; name: string | null; messageCount: number; lastSeenAt: string; team?: boolean }
interface Chat {
  id: string
  jid: string
  name: string
  isGroup: boolean
  tracked: boolean
  clientName: string | null
  description: string | null
  trackedSince: string | null
  participantCount: number | null
  lastMessageAt: string | null
  rules: Rule[]
  participants: Participant[]
  counts: { pending: number; dismissed: number; flagged: number; attached: number; items: number; openItems: number }
}
interface Msg {
  id: string
  senderName: string | null
  senderWaId: string
  fromMe: boolean
  type: string
  text: string | null
  sentAt: string
  filterStatus: string
  filterReason: string | null
  simulated: boolean
  team?: boolean
  mediaPath?: string | null
  mediaText?: string | null
  mediaTextStatus?: string
  mediaTextError?: string | null
  mediaTextModel?: string | null
  textTranslation?: string | null
  mediaTextTranslation?: string | null
  itemLinks: { itemId: string; kind: string; item: { title: string; status: string } }[]
}

const route = useRoute()
const { ok, bad } = useToast()
const chat = ref<Chat | null>(null)
const messages = ref<Msg[]>([])
const msgTotal = ref(0)
const msgFilter = ref('')
const busy = ref('')
const ctx = reactive({ clientName: '', description: '', name: '' })
const dirty = computed(
  () => chat.value && (ctx.clientName !== (chat.value.clientName ?? '') || ctx.description !== (chat.value.description ?? '') || ctx.name !== chat.value.name),
)
const ruleModal = ref(false)
const editing = ref<Rule | null>(null)
const simulationAllowed = ref(false)
const sim = reactive({ senderName: '', senderWaId: '', text: '' })

const id = route.params.id as string

const setupOpen = ref(false)
async function load(refill = false) {
  try {
    const [c, m, s] = await Promise.all([
      api.get<{ chat: Chat }>(`/chats/${id}`),
      api.get<{ messages: Msg[]; total: number }>(`/chats/${id}/messages`, { params: { status: msgFilter.value || undefined, limit: 60 } }),
      api.get<{ settings: { simulationAllowed: boolean } }>('/settings'),
    ])
    const first = !chat.value
    chat.value = c.data.chat
    messages.value = m.data.messages
    msgTotal.value = m.data.total
    simulationAllowed.value = s.data.settings.simulationAllowed
    // The form is filled once, so polling never overwrites an edit in
    // progress — except after a setup saved from the sheet, which is new
    // context the form must show.
    if (first || refill) {
      ctx.clientName = chat.value.clientName ?? ''
      ctx.description = chat.value.description ?? ''
      ctx.name = chat.value.name
    }
  } catch (e) {
    bad(errorMessage(e))
  }
}
onMounted(() => load())
usePolling(() => load(), 15_000)
watch(msgFilter, () => load())

async function saveContext() {
  busy.value = 'ctx'
  try {
    const { data } = await api.put<{ chat: Chat }>(`/chats/${id}`, { clientName: ctx.clientName, description: ctx.description, name: ctx.name })
    chat.value = { ...chat.value!, ...data.chat }
    ok('Context saved')
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function setTracked(v: boolean) {
  try {
    await api.put(`/chats/${id}`, { tracked: v })
    await load()
    ok(v ? 'Reading this chat from now on' : 'Stopped reading this chat')
  } catch (e) {
    bad(errorMessage(e))
  }
}
async function toggleRule(r: Rule, active: boolean) {
  try {
    await api.put(`/rules/${r.id}`, { active })
    r.active = active
  } catch (e) {
    bad(errorMessage(e))
  }
}
async function removeRule(r: Rule) {
  if (!confirm(`Delete the rule “${r.text}”? Items it produced stay.`)) return
  try {
    await api.delete(`/rules/${r.id}`)
    await load()
    ok('Rule deleted')
  } catch (e) {
    bad(errorMessage(e))
  }
}
function onSaved() {
  ruleModal.value = false
  void load()
}
async function runNow() {
  busy.value = 'run'
  try {
    const { data } = await api.post<{ result: { cut: number; processed: number } }>(`/chats/${id}/run`, {})
    ok(data.result.cut ? `Bundled ${data.result.cut} batch and ran the pipeline` : 'Nothing was waiting')
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function rescue(m: Msg) {
  busy.value = m.id
  try {
    await api.post(`/review/rescue/${m.id}`, {})
    ok('Rescued and analysed. The filter will remember this.')
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function simulate() {
  busy.value = 'sim'
  try {
    await api.post('/simulate', {
      chatId: id,
      senderName: sim.senderName || 'Test sender',
      senderWaId: sim.senderWaId || '60100000001',
      text: sim.text,
    })
    sim.text = ''
    ok('Message injected. It will be bundled on the next quiet period, or press Run now.')
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
const participantsForRule = computed(() => chat.value?.participants ?? [])
const MSG_FILTERS = [
  { value: 'DISMISSED', label: 'Dismissed' },
  { value: 'ATTACHED', label: 'In items' },
  { value: 'FLAGGED', label: 'Flagged' },
  { value: 'PENDING', label: 'Waiting' },
  { value: 'SKIPPED', label: 'Ours' },
]
async function toggleTeam(p: Participant) {
  busy.value = `team-${p.waId}`
  try {
    await api.put(`/team/${encodeURIComponent(p.waId)}`, { team: !p.team, name: p.name })
    p.team = !p.team
    ok(p.team ? `${p.name || p.waId} marked as your team, in every chat` : `${p.name || p.waId} is no longer marked as team`)
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div v-if="chat" class="rise">
    <RouterLink to="/chats" class="tap-target mb-2 inline-flex items-center gap-1.5 text-[14px] leading-5 text-ink-500 hover:text-ink-900 lg:mb-4">
      <ArrowLeft class="size-4" :stroke-width="1.5" /> All chats
    </RouterLink>

    <PageHeader
      :title="chat.name"
      :subtitle="`${chat.isGroup ? 'Group' : 'Private chat'}${chat.participantCount ? ` · ${chat.participantCount} members` : ''} · ${chat.counts.items} items, ${chat.counts.openItems} open · reading since ${chat.trackedSince ? fmtDateTime(chat.trackedSince) : 'never'}`"
    >
      <template #actions>
        <label class="flex items-center gap-2.5 text-[14px] leading-5">
          <BaseToggle :model-value="chat.tracked" label="Read this chat" size="lg" @update:model-value="setTracked" />
          {{ chat.tracked ? 'Reading' : 'Ignored' }}
        </label>
        <BaseButton variant="secondary" :loading="busy === 'run'" :disabled="!chat.tracked" @click="runNow">
          <Play class="size-4" :stroke-width="1.5" /> Run now
          <span v-if="chat.counts.pending" class="num text-ink-500">({{ chat.counts.pending }})</span>
        </BaseButton>
      </template>
    </PageHeader>

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- Config is set once; the messages are why anyone opens this on a
           phone. Ordered messages-first below lg, unchanged on desktop where
           both columns are visible at once. -->
      <div class="order-2 space-y-6 lg:order-1">
        <Card title="What this chat is" sub="The models read this before every message, so say who the client is and what the project is about.">
          <div class="space-y-4">
            <BaseInput v-model="ctx.name" label="Chat name" />
            <BaseInput v-model="ctx.clientName" label="Client" placeholder="e.g. Client 1" hint="Items are grouped by this on the dashboard." />
            <BaseTextarea
              v-model="ctx.description"
              label="About"
              :rows="4"
              placeholder="e.g. Custom ERP project. Modules: sales, purchasing, inventory. Ahmad is the client's PM; Mei Ling is our lead."
            />
            <div class="flex flex-wrap items-center justify-end gap-2">
              <BaseButton variant="secondary" @click="setupOpen = true"><Sparkles class="size-4 text-primary-600" :stroke-width="1.75" /> Draft from the chat</BaseButton>
              <BaseButton variant="primary" :disabled="!dirty" :loading="busy === 'ctx'" @click="saveContext">Save context</BaseButton>
            </div>
          </div>
        </Card>

        <Card title="Tracking rules" sub="Plain language. One message can match several rules." flush>
          <template #actions>
            <BaseButton size="sm" variant="primary" @click="editing = null; ruleModal = true"><Plus class="size-4" :stroke-width="1.5" /> Add rule</BaseButton>
          </template>
          <p v-if="!chat.rules.length" class="px-6 py-8 text-center text-[14px] leading-5 text-ink-500">
            No rules yet. Without one, every message in this chat is dismissed as noise.
          </p>
          <div v-else class="divide-y divide-line-100">
            <div v-for="r in chat.rules" :key="r.id" class="flex items-start gap-3 px-6 py-4">
              <BaseToggle :model-value="r.active" label="Rule active" @update:model-value="(v) => toggleRule(r, v)" />
              <div class="min-w-0 flex-1">
                <p class="text-[15px] font-medium leading-[22px]" :class="r.active ? 'text-ink-900' : 'text-ink-400 line-through'">{{ r.text }}</p>
                <p v-if="r.extraAsk" class="text-[14px] leading-5 text-ink-600">Also: {{ r.extraAsk }}</p>
                <p class="mt-1 text-[13px] leading-[18px] text-ink-500">
                  {{
                    r.senderWaIds.length
                      ? `Only from ${r.senderWaIds.map((w) => chat!.participants.find((p) => p.waId === w)?.name || '+' + w).join(', ')}`
                      : 'Whole chat'
                  }}
                  · to {{ [r.toDashboard ? 'dashboard' : '', ...r.toWhatsapp.map((n) => '+' + n)].filter(Boolean).join(', ') || 'nowhere' }}
                </p>
              </div>
              <button
                class="-mr-1 grid size-10 shrink-0 place-items-center rounded-sm text-ink-400 hover:text-ink-900"
                aria-label="Edit rule"
                @click="editing = r; ruleModal = true"
              >
                <Pencil class="size-4" :stroke-width="1.5" />
              </button>
              <button
                class="-mr-1 grid size-10 shrink-0 place-items-center rounded-sm text-ink-400 hover:text-danger-600"
                aria-label="Delete rule"
                @click="removeRule(r)"
              >
                <Trash2 class="size-4" :stroke-width="1.5" />
              </button>
            </div>
          </div>
        </Card>

        <Card title="People in this chat" sub="Learned from who has spoken since tracking began. A rule can be limited to any of them. Click a person to mark them as your team — that applies in every chat.">
          <p v-if="!chat.participants.length" class="text-[14px] leading-5 text-ink-500">Nobody yet.</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="p in chat.participants"
              :key="p.waId"
              type="button"
              class="inline-flex min-h-8 items-center gap-2 rounded-full border px-3 py-1 text-[13px] leading-5 transition-colors"
              :class="p.team ? 'border-primary-200 bg-primary-50 text-primary-800' : 'border-line-200 bg-surface-50 text-ink-700 hover:border-ink-300'"
              :disabled="busy === `team-${p.waId}`"
              :title="p.team ? 'On your team — click to unmark' : 'Click to mark as your team'"
              @click="toggleTeam(p)"
            >
              <User class="size-3.5" :class="p.team ? 'text-primary-600' : 'text-ink-400'" :stroke-width="1.5" />
              {{ p.name || (p.waId.startsWith('lid:') ? 'Unknown contact' : '+' + p.waId) }}
              <span v-if="p.team" class="text-[12px] font-medium uppercase tracking-wide text-primary-700">team</span>
              <span class="num" :class="p.team ? 'text-primary-600' : 'text-ink-500'">{{ p.messageCount }}</span>
            </button>
          </div>
        </Card>

        <Card v-if="simulationAllowed" title="Simulate a message" sub="Injects a message as if it arrived from WhatsApp, to test the rules without a phone.">
          <div class="grid gap-3 sm:grid-cols-2">
            <BaseInput v-model="sim.senderName" placeholder="Sender name" />
            <BaseInput v-model="sim.senderWaId" placeholder="60123456701" />
          </div>
          <div class="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
            <div class="min-w-0 flex-1"><BaseTextarea v-model="sim.text" :rows="2" placeholder="Message text…" /></div>
            <BaseButton variant="secondary" :disabled="!sim.text.trim()" :loading="busy === 'sim'" @click="simulate">Inject</BaseButton>
          </div>
        </Card>
      </div>

      <Card
        :title="`Messages`"
        :sub="`${msgTotal} stored · ${chat.counts.dismissed} dismissed · ${chat.counts.attached} in items`"
        flush
        class="order-1 lg:order-2"
      >
        <template #actions>
          <div class="w-40"><BaseSelect v-model="msgFilter" :options="MSG_FILTERS" placeholder="All messages" /></div>
        </template>
        <p v-if="!messages.length" class="px-6 py-12 text-center text-[14px] leading-5 text-ink-500">
          {{ chat.tracked ? 'Nothing stored yet. Messages are kept from the moment tracking was switched on.' : 'This chat is not being read, so nothing is stored.' }}
        </p>
        <div v-else class="divide-y divide-line-100">
          <div v-for="m in messages" :key="m.id" class="px-6 py-3">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[18px] text-ink-500">
              <span class="font-medium text-ink-900">{{ senderOf(m) }}</span>
              <BaseBadge v-if="m.team" tone="accent">our team</BaseBadge>
              <span>{{ fmtDateTime(m.sentAt) }}</span>
              <BaseBadge :tone="FILTER_TONE[m.filterStatus]">{{ FILTER_LABEL[m.filterStatus] }}</BaseBadge>
              <BaseBadge v-if="m.simulated" tone="neutral">simulated</BaseBadge>
              <button
                v-if="m.filterStatus === 'DISMISSED'"
                class="ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-sm px-1 text-[13px] font-medium text-primary-700 hover:underline"
                :disabled="busy === m.id"
                @click="rescue(m)"
              >
                <LifeBuoy class="size-3.5" :stroke-width="1.75" /> {{ busy === m.id ? 'Analysing…' : 'Rescue' }}
              </button>
            </div>
            <p class="original mt-1 text-[15px] leading-[22px] text-ink-800">{{ bodyOf(m) }}</p>
            <TranslationLine :message="m" field="text" @updated="(u) => Object.assign(m, u)" />
            <MediaText :message="m" @updated="(u) => Object.assign(m, u)" />
            <p v-if="m.filterReason && m.filterStatus !== 'ATTACHED'" class="text-[13px] leading-[18px] text-ink-500 italic">{{ m.filterReason }}</p>
            <p v-for="l in m.itemLinks" :key="l.itemId" class="text-[13px] leading-[18px]">
              <!-- inline-block, not inline-flex: as a flex box the kind label
                   was laid out as a second column and a two-line title left
                   it stranded out to the right. The padding is what makes it
                   a thumb-sized target while it still wraps like text. -->
              <RouterLink
                :to="`/items/${l.itemId}`"
                class="inline-block py-1 font-medium text-primary-700 hover:underline"
              >
                <span aria-hidden="true">→</span> {{ l.item.title }}
                <span class="font-normal text-ink-500">({{ l.kind.toLowerCase().replace('_', ' ') }})</span>
              </RouterLink>
            </p>
          </div>
        </div>
      </Card>
    </div>

    <RuleModal :show="ruleModal" :chat-id="chat.id" :rule="editing" :participants="participantsForRule" @close="ruleModal = false" @saved="onSaved" />
    <SetupSheet :show="setupOpen" :chat="chat ? { id: chat.id, name: chat.name, tracked: chat.tracked } : null" @close="setupOpen = false" @done="() => { setupOpen = false; void load(true) }" />
</div>
</template>
