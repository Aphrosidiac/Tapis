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

export interface Rule {
  id: string
  text: string
  extraAsk: string | null
  senderWaIds: string[]
  toDashboard: boolean
  toWhatsapp: string[]
  active: boolean
}
interface Participant { waId: string; name: string | null; messageCount: number }

const props = defineProps<{ show: boolean; chatId: string; rule: Rule | null; participants: Participant[] }>()
const emit = defineEmits<{ close: []; saved: [rule: Rule] }>()
const { ok, bad } = useToast()

const form = reactive({ text: '', extraAsk: '', senderWaIds: [] as string[], toDashboard: true, toWhatsapp: [] as string[] })
const newNumber = ref('')
const busy = ref(false)
const error = ref('')

watch(
  () => props.show,
  (open) => {
    if (!open) return
    error.value = ''
    newNumber.value = ''
    form.text = props.rule?.text ?? ''
    form.extraAsk = props.rule?.extraAsk ?? ''
    form.senderWaIds = [...(props.rule?.senderWaIds ?? [])]
    form.toDashboard = props.rule?.toDashboard ?? true
    form.toWhatsapp = [...(props.rule?.toWhatsapp ?? [])]
  },
)

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
  return p.name ? `${p.name}${p.waId.startsWith('lid:') ? '' : ` · +${p.waId}`}` : p.waId.startsWith('lid:') ? 'Unknown contact' : `+${p.waId}`
}

async function save() {
  error.value = ''
  busy.value = true
  try {
    // A number typed but not yet added is what the person meant to send.
    addNumber()
    const body = { ...form, extraAsk: form.extraAsk || null }
    const { data } = props.rule
      ? await api.put<{ rule: Rule }>(`/rules/${props.rule.id}`, body)
      : await api.post<{ rule: Rule }>(`/chats/${props.chatId}/rules`, body)
    ok(props.rule ? 'Rule updated' : 'Rule added')
    emit('saved', data.rule)
  } catch (e) {
    error.value = errorMessage(e)
    bad(error.value)
  } finally {
    busy.value = false
  }
}

const EXAMPLES = [
  'Track feature requests from this group',
  'Track complaints and bug reports',
  'Flag anything about payments or invoices',
  'Track change requests to the approved scope',
]
</script>

<template>
  <BaseModal
    :show="show"
    :title="rule ? 'Edit rule' : 'New tracking rule'"
    subtitle="Written in plain language. The models read your sentence as-is."
    size="lg"
    @close="emit('close')"
  >
    <div class="space-y-5">
      <div>
        <BaseTextarea
          v-model="form.text"
          label="What should be tracked?"
          required
          :rows="2"
          placeholder="e.g. “Track complaints from this group”"
        />
        <div v-if="!rule" class="mt-2 flex flex-wrap gap-1.5">
          <button
            v-for="ex in EXAMPLES"
            :key="ex"
            type="button"
            class="rounded-full border border-line-200 bg-surface-50 px-3 py-1 text-[13px] leading-5 text-ink-600 hover:border-ink-300 hover:text-ink-900"
            @click="form.text = ex"
          >
            {{ ex }}
          </button>
        </div>
      </div>

      <BaseTextarea
        v-model="form.extraAsk"
        label="Anything else the analysis should produce?"
        :rows="2"
        placeholder="e.g. “Which module is affected and how severe it is”"
        hint="Optional. Answers appear on the item as labelled fields."
      />

      <div>
        <p class="mb-1.5 text-[14px] font-medium leading-5 text-ink-800">
          Only messages from certain people?
          <span class="font-normal text-ink-500">Leave empty for the whole chat.</span>
        </p>
        <div v-if="participants.length" class="flex flex-wrap gap-1.5">
          <button
            v-for="p in participants"
            :key="p.waId"
            type="button"
            class="rounded-full border px-3 py-1 text-[13px] leading-5"
            :class="
              form.senderWaIds.includes(p.waId)
                ? 'border-primary-600 bg-primary-50 font-medium text-primary-700'
                : 'border-line-200 bg-surface-0 text-ink-600 hover:border-ink-300 hover:text-ink-900'
            "
            @click="toggleSender(p.waId)"
          >
            {{ labelOf(p) }}
          </button>
        </div>
        <p v-else class="text-[14px] leading-5 text-ink-500">
          Nobody has spoken in this chat since it was tracked, so there is nobody to pick yet.
        </p>
      </div>

      <div>
        <p class="mb-2 text-[14px] font-medium leading-5 text-ink-800">Where do matches go?</p>
        <label class="flex items-center gap-3 py-1 text-[15px] leading-[22px]">
          <BaseToggle v-model="form.toDashboard" label="Send to the dashboard" />
          The dashboard
        </label>
        <div class="mt-3">
          <p class="mb-1.5 text-[14px] leading-5 text-ink-800">WhatsApp numbers</p>
          <div v-if="form.toWhatsapp.length" class="mb-2 flex flex-wrap gap-1.5">
            <span
              v-for="n in form.toWhatsapp"
              :key="n"
              class="num inline-flex items-center gap-1.5 rounded-full bg-line-100 px-3 py-1 text-[13px] leading-5 text-ink-700"
            >
              +{{ n }}
              <button type="button" class="text-ink-400 hover:text-danger-600" :aria-label="`Remove ${n}`" @click="form.toWhatsapp = form.toWhatsapp.filter((x) => x !== n)">
                <X class="size-3.5" />
              </button>
            </span>
          </div>
          <div class="flex items-end gap-2">
            <div class="min-w-0 flex-1">
              <BaseInput v-model="newNumber" placeholder="60123456789" hint="International digits, no + or spaces" @keydown.enter.prevent="addNumber" />
            </div>
            <BaseButton variant="secondary" @click="addNumber">Add</BaseButton>
          </div>
        </div>
      </div>

      <p v-if="error" class="text-[14px] leading-5 text-danger-600">{{ error }}</p>
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton variant="primary" :loading="busy" @click="save">{{ rule ? 'Save rule' : 'Add rule' }}</BaseButton>
    </template>
  </BaseModal>
</template>
