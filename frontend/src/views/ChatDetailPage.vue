<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { usePolling } from '../composables/usePolling'
import { fmtDateTime, senderOf, bodyOf, FILTER_LABEL, FILTER_TONE } from '../lib/format'
import PageHeader from '../components/base/PageHeader.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseTextarea from '../components/base/BaseTextarea.vue'
import BaseToggle from '../components/base/BaseToggle.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import RuleModal, { type Rule } from '../components/RuleModal.vue'
import { ArrowLeft, Plus, Pencil, Trash2, Play, User, LifeBuoy } from 'lucide-vue-next'

interface Participant { waId: string; name: string | null; messageCount: number; lastSeenAt: string }
interface Chat { id: string; jid: string; name: string; isGroup: boolean; tracked: boolean; clientName: string | null; description: string | null; trackedSince: string | null; participantCount: number | null; lastMessageAt: string | null; rules: Rule[]; participants: Participant[]; counts: { pending: number; dismissed: number; flagged: number; attached: number; items: number; openItems: number } }
interface Msg { id: string; senderName: string | null; senderWaId: string; fromMe: boolean; type: string; text: string | null; sentAt: string; filterStatus: string; filterReason: string | null; simulated: boolean; itemLinks: { itemId: string; kind: string; item: { title: string; status: string } }[] }

const route = useRoute()
const { ok, bad } = useToast()
const chat = ref<Chat | null>(null)
const messages = ref<Msg[]>([])
const msgTotal = ref(0)
const msgFilter = ref('')
const busy = ref('')
const ctx = reactive({ clientName: '', description: '', name: '' })
const dirty = computed(() => chat.value && (ctx.clientName !== (chat.value.clientName ?? '') || ctx.description !== (chat.value.description ?? '') || ctx.name !== chat.value.name))
const ruleModal = ref(false)
const editing = ref<Rule | null>(null)
const simulationAllowed = ref(false)
const sim = reactive({ senderName: '', senderWaId: '', text: '' })

const id = route.params.id as string

async function load() {
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
    if (first) {
      ctx.clientName = chat.value.clientName ?? ''
      ctx.description = chat.value.description ?? ''
      ctx.name = chat.value.name
    }
  } catch (e) {
    bad(errorMessage(e))
  }
}
onMounted(load)
usePolling(load, 15_000)
watch(msgFilter, load)

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
    await api.post('/simulate', { chatId: id, senderName: sim.senderName || 'Test sender', senderWaId: sim.senderWaId || '60100000001', text: sim.text })
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
</script>

<template>
  <div v-if="chat" class="animate-page-in">
    <RouterLink to="/chats" class="mb-3 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"><ArrowLeft class="h-3.5 w-3.5" /> All chats</RouterLink>
    <PageHeader :title="chat.name" :subtitle="`${chat.isGroup ? 'Group' : 'Private chat'}${chat.participantCount ? ` · ${chat.participantCount} members` : ''} · ${chat.counts.items} items, ${chat.counts.openItems} open · reading since ${chat.trackedSince ? fmtDateTime(chat.trackedSince) : 'never'}`">
      <template #actions>
        <label class="flex items-center gap-2 text-[12.5px]"><BaseToggle :model-value="chat.tracked" label="Read this chat" size="lg" @update:model-value="setTracked" /> {{ chat.tracked ? 'Reading' : 'Ignored' }}</label>
        <BaseButton variant="secondary" :loading="busy === 'run'" :disabled="!chat.tracked" @click="runNow"><Play class="h-3.5 w-3.5" /> Run now<span v-if="chat.counts.pending" class="text-faint">({{ chat.counts.pending }} waiting)</span></BaseButton>
      </template>
    </PageHeader>

    <div class="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <div class="space-y-4">
        <div class="rounded-md border border-line bg-surface p-5">
          <h2 class="text-[13px] font-bold">What this chat is</h2>
          <p class="mb-3 text-[11.5px] text-faint">The models read this before every message, so say who the client is and what the project is about.</p>
          <div class="space-y-3">
            <BaseInput v-model="ctx.name" label="Chat name" />
            <BaseInput v-model="ctx.clientName" label="Client" placeholder="e.g. Client 1" hint="Items are grouped by this on the dashboard." />
            <BaseTextarea v-model="ctx.description" label="About" :rows="4" placeholder="e.g. Custom ERP project. Modules: sales, purchasing, inventory. Ahmad is the client's PM; Mei Ling is our lead." />
            <div class="flex justify-end"><BaseButton :disabled="!dirty" :loading="busy === 'ctx'" @click="saveContext">Save context</BaseButton></div>
          </div>
        </div>

        <div class="rounded-md border border-line bg-surface">
          <div class="flex items-center justify-between border-b border-hair px-5 py-3">
            <div>
              <h2 class="text-[13px] font-bold">Tracking rules</h2>
              <p class="text-[11.5px] text-faint">Plain language. One message can match several rules.</p>
            </div>
            <BaseButton size="sm" @click="editing = null; ruleModal = true"><Plus class="h-3.5 w-3.5" /> Add rule</BaseButton>
          </div>
          <p v-if="!chat.rules.length" class="px-5 py-6 text-center text-[12.5px] text-muted">No rules yet. Without a rule, every message in this chat is dismissed as noise.</p>
          <div v-for="r in chat.rules" :key="r.id" class="flex items-start gap-3 border-b border-hair px-5 py-3 last:border-b-0">
            <BaseToggle :model-value="r.active" :label="`Rule active`" @update:model-value="(v) => toggleRule(r, v)" />
            <div class="min-w-0 flex-1">
              <p :class="['text-[13px] font-semibold', r.active ? 'text-ink' : 'text-faint line-through']">{{ r.text }}</p>
              <p v-if="r.extraAsk" class="text-[12px] text-muted">Also: {{ r.extraAsk }}</p>
              <p class="mt-1 text-[11.5px] text-faint">
                {{ r.senderWaIds.length ? `Only from ${r.senderWaIds.map((w) => chat!.participants.find((p) => p.waId === w)?.name || '+' + w).join(', ')}` : 'Whole chat' }}
                · to {{ [r.toDashboard ? 'dashboard' : '', ...r.toWhatsapp.map((n) => '+' + n)].filter(Boolean).join(', ') || 'nowhere' }}
              </p>
            </div>
            <button class="p-1 text-faint hover:text-ink" aria-label="Edit rule" @click="editing = r; ruleModal = true"><Pencil class="h-3.5 w-3.5" /></button>
            <button class="p-1 text-faint hover:text-bad" aria-label="Delete rule" @click="removeRule(r)"><Trash2 class="h-3.5 w-3.5" /></button>
          </div>
        </div>

        <div class="rounded-md border border-line bg-surface p-5">
          <h2 class="text-[13px] font-bold">People in this chat</h2>
          <p class="mb-2 text-[11.5px] text-faint">Learned from who has spoken since tracking began. Rules can be limited to any of them.</p>
          <p v-if="!chat.participants.length" class="text-[12.5px] text-muted">Nobody yet.</p>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="p in chat.participants" :key="p.waId" class="inline-flex items-center gap-1.5 rounded-sm border border-line bg-tint px-2 py-1 text-[12px]">
              <User class="h-3 w-3 text-faint" />{{ p.name || (p.waId.startsWith('lid:') ? 'Unknown contact' : '+' + p.waId) }}<span class="text-faint tabular">{{ p.messageCount }}</span>
            </span>
          </div>
        </div>

        <div v-if="simulationAllowed" class="rounded-md border border-dashed border-line bg-surface p-5">
          <h2 class="text-[13px] font-bold">Simulate a message</h2>
          <p class="mb-2 text-[11.5px] text-faint">Injects a message as if it arrived from WhatsApp, to test the rules. Only shown while simulation is enabled in Settings.</p>
          <div class="grid gap-2 sm:grid-cols-2">
            <BaseInput v-model="sim.senderName" placeholder="Sender name" />
            <BaseInput v-model="sim.senderWaId" placeholder="Sender number, e.g. 60123456701" />
          </div>
          <div class="mt-2 flex gap-2">
            <BaseTextarea v-model="sim.text" :rows="2" placeholder="Message text…" />
            <BaseButton variant="secondary" class="self-start" :disabled="!sim.text.trim()" :loading="busy === 'sim'" @click="simulate">Inject</BaseButton>
          </div>
        </div>
      </div>

      <div class="rounded-md border border-line bg-surface">
        <div class="flex flex-wrap items-center gap-2 border-b border-hair px-5 py-3">
          <div class="mr-auto">
            <h2 class="text-[13px] font-bold">Messages</h2>
            <p class="text-[11.5px] text-faint">{{ msgTotal }} stored · {{ chat.counts.dismissed }} dismissed · {{ chat.counts.attached }} in items</p>
          </div>
          <div class="w-40"><BaseSelect v-model="msgFilter" :options="[{ value: 'DISMISSED', label: 'Dismissed' }, { value: 'ATTACHED', label: 'In items' }, { value: 'FLAGGED', label: 'Flagged' }, { value: 'PENDING', label: 'Waiting' }, { value: 'SKIPPED', label: 'Ours' }]" placeholder="All messages" /></div>
        </div>
        <p v-if="!messages.length" class="px-5 py-10 text-center text-[12.5px] text-muted">{{ chat.tracked ? 'Nothing stored yet. Messages are kept from the moment tracking was switched on.' : 'This chat is not being read, so nothing is stored.' }}</p>
        <div v-for="m in messages" :key="m.id" class="border-b border-hair px-5 py-2.5 last:border-b-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint">
            <span class="font-semibold text-ink">{{ senderOf(m) }}</span>
            <span>{{ fmtDateTime(m.sentAt) }}</span>
            <BaseBadge :tone="FILTER_TONE[m.filterStatus]">{{ FILTER_LABEL[m.filterStatus] }}</BaseBadge>
            <BaseBadge v-if="m.simulated" tone="neutral">simulated</BaseBadge>
            <button v-if="m.filterStatus === 'DISMISSED'" class="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent-strong hover:underline" :disabled="busy === m.id" @click="rescue(m)"><LifeBuoy class="h-3 w-3" /> {{ busy === m.id ? 'Analysing…' : 'Rescue' }}</button>
          </div>
          <p class="original mt-0.5 text-[13px] text-ink">{{ bodyOf(m) }}</p>
          <p v-if="m.filterReason && m.filterStatus !== 'ATTACHED'" class="text-[11.5px] italic text-faint">{{ m.filterReason }}</p>
          <p v-for="l in m.itemLinks" :key="l.itemId" class="text-[11.5px]">
            → <RouterLink :to="`/items/${l.itemId}`" class="font-semibold text-accent-strong hover:underline">{{ l.item.title }}</RouterLink> <span class="text-faint">({{ l.kind.toLowerCase().replace('_', ' ') }})</span>
          </p>
        </div>
      </div>
    </div>

    <RuleModal :show="ruleModal" :chat-id="chat.id" :rule="editing" :participants="participantsForRule" @close="ruleModal = false" @saved="onSaved" />
  </div>
</template>
