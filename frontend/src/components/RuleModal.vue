<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import BaseModal from './base/BaseModal.vue'
import BaseInput from './base/BaseInput.vue'
import BaseTextarea from './base/BaseTextarea.vue'
import BaseToggle from './base/BaseToggle.vue'
import BaseButton from './base/BaseButton.vue'
import { X } from 'lucide-vue-next'

export interface Rule { id: string; text: string; extraAsk: string | null; senderWaIds: string[]; toDashboard: boolean; toWhatsapp: string[]; active: boolean }
interface Participant { waId: string; name: string | null; messageCount: number }

const props = defineProps<{ show: boolean; chatId: string; rule: Rule | null; participants: Participant[] }>()
const emit = defineEmits<{ close: []; saved: [rule: Rule] }>()
const { ok, bad } = useToast()

const form = reactive({ text: '', extraAsk: '', senderWaIds: [] as string[], toDashboard: true, toWhatsapp: [] as string[] })
const newNumber = ref('')
const busy = ref(false)
const error = ref('')

watch(() => props.show, (open) => {
  if (!open) return
  error.value = ''
  newNumber.value = ''
  form.text = props.rule?.text ?? ''
  form.extraAsk = props.rule?.extraAsk ?? ''
  form.senderWaIds = [...(props.rule?.senderWaIds ?? [])]
  form.toDashboard = props.rule?.toDashboard ?? true
  form.toWhatsapp = [...(props.rule?.toWhatsapp ?? [])]
})

function addNumber() {
  const n = newNumber.value.replace(/[^0-9]/g, '')
  if (!n) return
  if (!form.toWhatsapp.includes(n)) form.toWhatsapp.push(n)
  newNumber.value = ''
}
function toggleSender(waId: string) {
  const i = form.senderWaIds.indexOf(waId)
  if (i >= 0) form.senderWaIds.splice(i, 1)
  else form.senderWaIds.push(waId)
}
function labelOf(p: Participant) {
  return p.name ? `${p.name}${p.waId.startsWith('lid:') ? '' : ` (+${p.waId})`}` : p.waId.startsWith('lid:') ? 'Unknown contact' : `+${p.waId}`
}

async function save() {
  error.value = ''
  busy.value = true
  try {
    addNumber()
    const body = { ...form, extraAsk: form.extraAsk || null }
    const { data } = props.rule ? await api.put<{ rule: Rule }>(`/rules/${props.rule.id}`, body) : await api.post<{ rule: Rule }>(`/chats/${props.chatId}/rules`, body)
    ok(props.rule ? 'Rule updated' : 'Rule added')
    emit('saved', data.rule)
  } catch (e) {
    error.value = errorMessage(e)
    bad(error.value)
  } finally {
    busy.value = false
  }
}

const EXAMPLES = ['Track feature requests from this group', 'Track complaints and bug reports', 'Flag anything about payments or invoices', 'Track change requests to the approved scope']
</script>

<template>
  <BaseModal :show="show" :title="rule ? 'Edit rule' : 'New tracking rule'" size="md" @close="emit('close')">
    <div class="space-y-4">
      <BaseTextarea v-model="form.text" label="What should be tracked?" required :rows="2" placeholder="In plain language, e.g. “Track complaints from this group”" hint="Free-form. The models read this sentence as-is, so say exactly what matters." />
      <div v-if="!rule" class="-mt-2 flex flex-wrap gap-1.5">
        <button v-for="ex in EXAMPLES" :key="ex" type="button" class="rounded-sm border border-line bg-tint px-2 py-0.5 text-[11.5px] text-muted hover:border-ink hover:text-ink" @click="form.text = ex">{{ ex }}</button>
      </div>

      <BaseTextarea v-model="form.extraAsk" label="Anything else the analysis should produce? (optional)" :rows="2" placeholder="e.g. “Which module is affected and how severe it is”, or “An estimate of effort in days”" />

      <div>
        <p class="mb-1 text-[11.5px] font-semibold text-muted">Only messages from certain people? <span class="font-normal text-faint">Leave empty for the whole chat.</span></p>
        <div v-if="participants.length" class="flex flex-wrap gap-1.5">
          <button v-for="p in participants" :key="p.waId" type="button" :class="['rounded-sm border px-2 py-1 text-[12px]', form.senderWaIds.includes(p.waId) ? 'border-accent bg-accent-soft font-semibold text-accent-strong' : 'border-line bg-surface text-muted hover:text-ink']" @click="toggleSender(p.waId)">{{ labelOf(p) }}</button>
        </div>
        <p v-else class="text-[12px] text-faint">Nobody has spoken in this chat since it was tracked, so there is nobody to pick yet.</p>
        <div v-if="form.senderWaIds.some((w) => !participants.find((p) => p.waId === w))" class="mt-1.5 flex flex-wrap gap-1.5">
          <span v-for="w in form.senderWaIds.filter((w) => !participants.find((p) => p.waId === w))" :key="w" class="inline-flex items-center gap-1 rounded-sm border border-accent bg-accent-soft px-2 py-1 text-[12px] text-accent-strong">+{{ w }}<button type="button" @click="toggleSender(w)"><X class="h-3 w-3" /></button></span>
        </div>
      </div>

      <div>
        <p class="mb-1 text-[11.5px] font-semibold text-muted">Where do matches go?</p>
        <label class="flex items-center gap-2 py-1 text-[12.5px]"><BaseToggle v-model="form.toDashboard" label="Dashboard" /> The dashboard</label>
        <div class="mt-1">
          <p class="text-[12.5px]">WhatsApp numbers</p>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <span v-for="n in form.toWhatsapp" :key="n" class="inline-flex items-center gap-1 rounded-sm border border-line bg-tint px-2 py-1 text-[12px]">+{{ n }}<button type="button" class="text-faint hover:text-bad" @click="form.toWhatsapp = form.toWhatsapp.filter((x) => x !== n)"><X class="h-3 w-3" /></button></span>
          </div>
          <div class="mt-1.5 flex gap-1.5">
            <BaseInput v-model="newNumber" placeholder="60123456789" hint="International digits, no + or spaces" @keydown.enter.prevent="addNumber" />
            <BaseButton variant="secondary" class="self-start" @click="addNumber">Add</BaseButton>
          </div>
        </div>
      </div>
      <p v-if="error" class="text-[12px] text-bad">{{ error }}</p>
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton :loading="busy" @click="save">{{ rule ? 'Save' : 'Add rule' }}</BaseButton>
    </template>
  </BaseModal>
</template>
