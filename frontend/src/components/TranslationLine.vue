<script setup lang="ts">
import { computed, ref } from 'vue'
import { Languages } from 'lucide-vue-next'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { hasCjk } from '../lib/format'

/// The rendering of a Chinese original into the operator's language, shown
/// under the original and never instead of it. Offers to translate when
/// there is Chinese and no translation yet.
export interface TranslatableMessage {
  id: string
  text?: string | null
  mediaText?: string | null
  mediaTextStatus?: string
  textTranslation?: string | null
  mediaTextTranslation?: string | null
}

const props = defineProps<{ message: TranslatableMessage; field: 'text' | 'reading' }>()
const emit = defineEmits<{ updated: [m: TranslatableMessage] }>()
const { bad } = useToast()
const busy = ref(false)

const source = computed(() => (props.field === 'text' ? props.message.text : props.message.mediaTextStatus === 'DONE' ? props.message.mediaText : null))
const translation = computed(() => (props.field === 'text' ? props.message.textTranslation : props.message.mediaTextTranslation))
const wanted = computed(() => hasCjk(source.value ?? ''))

async function translate() {
  busy.value = true
  try {
    const { data } = await api.post<{ message: TranslatableMessage }>(`/messages/${props.message.id}/translate`)
    emit('updated', data.message)
    if (!(props.field === 'text' ? data.message.textTranslation : data.message.mediaTextTranslation)) bad('No translation came back. Check the model key on Settings.')
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <p v-if="translation" class="mt-1 flex gap-1.5 text-[14px] leading-5 text-ink-500">
    <Languages class="mt-0.5 size-3.5 shrink-0 text-ink-400" :stroke-width="1.5" aria-label="Translation" />
    <span class="whitespace-pre-wrap">{{ translation }}</span>
  </p>
  <button
    v-else-if="wanted"
    type="button"
    class="mt-1 inline-flex min-h-6 items-center gap-1 rounded-sm px-1 text-[13px] font-medium text-primary-700 hover:underline"
    :disabled="busy"
    @click="translate"
  >
    <Languages class="size-3.5" :stroke-width="1.75" /> {{ busy ? 'Translating…' : 'Translate' }}
  </button>
</template>
