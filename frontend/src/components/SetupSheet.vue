<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { Sparkles, Loader2, Plus, X, Users } from 'lucide-vue-next'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import BaseModal from './base/BaseModal.vue'
import BaseButton from './base/BaseButton.vue'
import BaseInput from './base/BaseInput.vue'
import BaseTextarea from './base/BaseTextarea.vue'
import BaseToggle from './base/BaseToggle.vue'

/// One sheet to set a chat up. It opens already drafted — the phone is
/// asked for the last three days (nothing stored) and a cheap model writes
/// the client name, the description, the rules worth having and who on our
/// side is in it. The operator edits what is wrong, unticks what is not
/// wanted, and presses one button. Typing everything from scratch is still
/// possible; it is no longer the only way.

interface Draft {
  clientName: string
  description: string
  languages: string
  kind: 'client' | 'internal' | 'personal' | 'other'
  rules: { text: string; why: string }[]
  suggestedTeam: { waId: string; name: string | null; why: string }[]
  peeked: number
  source: 'history' | 'name-only'
}

const props = defineProps<{ show: boolean; chat: { id: string; name: string; tracked?: boolean } | null }>()
const emit = defineEmits<{ close: []; done: [chatId: string] }>()
const { ok, bad } = useToast()

const TEMPLATES = [
  'Track feature requests from this group',
  'Track complaints and bug reports',
  'Flag anything about payments or invoices',
  'Track change requests to the approved scope',
  'Track delivery and schedule commitments',
  'Track questions the client is waiting on an answer for',
]

const loading = ref(false)
const applying = ref(false)
const draft = ref<Draft | null>(null)
const form = reactive({ clientName: '', description: '' })
const rules = ref<{ text: string; why?: string; on: boolean }[]>([])
const team = ref<{ waId: string; name: string | null; why: string; on: boolean }[]>([])
const custom = ref('')

async function load() {
  if (!props.chat) return
  loading.value = true
  draft.value = null
  form.clientName = ''
  form.description = ''
  rules.value = []
  team.value = []
  try {
    const { data } = await api.post<{ draft: Draft }>(`/chats/${props.chat.id}/setup-draft`, {})
    draft.value = data.draft
    form.clientName = data.draft.clientName
    form.description = data.draft.description
    rules.value = data.draft.rules.map((r) => ({ ...r, on: true }))
    team.value = data.draft.suggestedTeam.map((t) => ({ ...t, on: true }))
  } catch (e) {
    bad(errorMessage(e))
    draft.value = { clientName: '', description: '', languages: '', kind: 'other', rules: [], suggestedTeam: [], peeked: 0, source: 'name-only' }
  } finally {
    loading.value = false
  }
}
watch(() => props.show, (v) => v && load(), { immediate: true })

function addRule(text: string) {
  const t = text.trim()
  if (!t || rules.value.some((r) => r.text.toLowerCase() === t.toLowerCase())) return
  rules.value.push({ text: t, on: true })
  custom.value = ''
}

async function apply(justRead = false) {
  if (!props.chat) return
  applying.value = true
  try {
    if (justRead) {
      await api.put(`/chats/${props.chat.id}`, { tracked: true })
    } else {
      await api.post(`/chats/${props.chat.id}/setup`, {
        clientName: form.clientName,
        description: form.description,
        rules: rules.value.filter((r) => r.on).map((r) => ({ text: r.text })),
        team: team.value.filter((t) => t.on).map((t) => ({ waId: t.waId, name: t.name })),
      })
    }
    ok(`Reading “${props.chat.name}” from now on`)
    emit('done', props.chat.id)
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <BaseModal :show="show" :title="chat ? `Set up “${chat.name}”` : 'Set up'" size="lg" @close="$emit('close')">
    <div v-if="loading" class="flex flex-col items-center gap-3 py-12 text-center">
      <Loader2 class="size-6 animate-spin text-ink-400" :stroke-width="1.75" />
      <p class="text-[15px] leading-[22px] text-ink-800">{{ chat?.tracked ? 'Reading the recent messages…' : 'Asking your phone for the last 3 days…' }}</p>
      <p class="max-w-sm text-[13px] leading-[18px] text-ink-500">{{ chat?.tracked ? 'Drafting the context and rules from what this chat has said.' : 'A one-off look to draft the setup. Nothing from it is stored until you switch the chat on. If the phone does not answer, it drafts from the name.' }}</p>
    </div>

    <div v-else-if="draft" class="space-y-6">
      <p class="flex items-center gap-2 text-[13px] leading-[18px] text-ink-500">
        <Sparkles class="size-4 text-primary-600" :stroke-width="1.75" />
        <span v-if="draft.source === 'history'">Drafted from {{ draft.peeked }} recent messages{{ draft.languages ? ` · ${draft.languages}` : '' }}. Fix anything wrong; it learns nothing until you press the button.</span>
        <span v-else>No recent messages to read yet, so this is drafted from the name and the people. Edit as you like.</span>
      </p>

      <div class="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <BaseInput v-model="form.clientName" label="Client" placeholder="e.g. Harvestgrow" hint="Items are grouped by this." />
        <BaseTextarea v-model="form.description" label="What this chat is" :rows="4" hint="The models read this before every message." />
      </div>

      <div>
        <p class="eyebrow">What to track</p>
        <div class="mt-2 space-y-1.5">
          <label v-for="r in rules" :key="r.text" class="flex items-start gap-3 rounded-md border border-line-200 bg-surface-0 px-3 py-2">
            <BaseToggle v-model="r.on" :label="r.text" />
            <span class="min-w-0 flex-1 text-[14px] leading-5">
              <span class="text-ink-900">{{ r.text }}</span>
              <span v-if="r.why" class="block text-[13px] leading-[18px] text-ink-500">{{ r.why }}</span>
            </span>
            <button class="rounded-sm p-1 text-ink-400 hover:text-danger-600" aria-label="Remove" @click="rules = rules.filter((x) => x !== r)"><X class="size-3.5" :stroke-width="1.75" /></button>
          </label>
        </div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            v-for="t in TEMPLATES.filter((t) => !rules.some((r) => r.text.toLowerCase() === t.toLowerCase()))"
            :key="t"
            type="button"
            class="rounded-full border border-dashed border-line-200 px-3 py-1 text-[13px] leading-5 text-ink-500 hover:border-ink-300 hover:text-ink-900"
            @click="addRule(t)"
          >
            <Plus class="inline size-3" :stroke-width="2" /> {{ t }}
          </button>
        </div>
        <div class="mt-2 flex gap-2">
          <input v-model="custom" class="field flex-1" placeholder="Or write your own: “Track …”" @keydown.enter.prevent="addRule(custom)" />
          <BaseButton variant="secondary" :disabled="!custom.trim()" @click="addRule(custom)">Add</BaseButton>
        </div>
      </div>

      <div v-if="team.length">
        <p class="eyebrow">Your side in this chat</p>
        <p class="mt-1 text-[13px] leading-[18px] text-ink-500">Their messages count as your team's — never a request, but "fixed" and "will do" get recorded on items.</p>
        <div class="mt-2 space-y-1.5">
          <label v-for="t in team" :key="t.waId" class="flex items-center gap-3 rounded-md border border-line-200 bg-surface-0 px-3 py-2">
            <BaseToggle v-model="t.on" :label="`${t.name ?? t.waId} is on our team`" />
            <Users class="size-4 shrink-0 text-ink-400" :stroke-width="1.5" />
            <span class="min-w-0 flex-1 text-[14px] leading-5">
              <span class="text-ink-900">{{ t.name ?? (t.waId.startsWith('lid:') ? 'Unknown contact' : `+${t.waId}`) }}</span>
              <span class="block text-[13px] leading-[18px] text-ink-500">{{ t.why }}</span>
            </span>
          </label>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-line-100 pt-4">
        <BaseButton variant="primary" :loading="applying" @click="apply(false)">{{ chat?.tracked ? 'Save setup' : 'Start reading' }}</BaseButton>
        <BaseButton v-if="!chat?.tracked" variant="secondary" :disabled="applying" @click="apply(true)">Just start reading, set up later</BaseButton>
        <BaseButton variant="ghost" :disabled="applying" @click="$emit('close')">Cancel</BaseButton>
      </div>
    </div>
  </BaseModal>
</template>
