<script setup lang="ts">
import { ref } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import TranslationLine from './TranslationLine.vue'

/// What a model read out of a message's media — a voice note's transcript
/// or an image's description — shown under the untouched original, with
/// the way to read it again. The reading is never the original: the eyebrow
/// says what it is, and the file stays beside it.
export interface MediaTextMessage {
  id: string
  type: string
  mediaPath?: string | null
  mediaText?: string | null
  mediaTextStatus?: string
  mediaTextError?: string | null
  mediaTextModel?: string | null
  text?: string | null
  textTranslation?: string | null
  mediaTextTranslation?: string | null
}

const props = defineProps<{ message: MediaTextMessage }>()
const emit = defineEmits<{ updated: [m: MediaTextMessage] }>()
const { bad } = useToast()
const busy = ref(false)

const readable = () => !!props.message.mediaPath && (props.message.type === 'AUDIO' || props.message.type === 'IMAGE')
const label = () => (props.message.type === 'AUDIO' ? 'Transcript' : 'What the image shows')

async function reread() {
  busy.value = true
  try {
    const { data } = await api.post<{ message: MediaTextMessage }>(`/messages/${props.message.id}/read-media`)
    emit('updated', data.message)
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="readable()" class="mt-2">
    <template v-if="message.mediaTextStatus === 'DONE' && message.mediaText">
      <div class="rounded-md border-l-2 border-primary-300 bg-surface-100 px-3 py-2">
        <p class="eyebrow flex items-center gap-2">
          {{ label() }}
          <span v-if="message.mediaTextModel" class="font-normal normal-case tracking-normal text-ink-400">· read by {{ message.mediaTextModel.replace(/^.*\//, '') }}</span>
          <button class="ml-auto inline-flex min-h-6 items-center gap-1 rounded-sm px-1 font-normal normal-case tracking-normal text-ink-400 hover:text-ink-900" :disabled="busy" aria-label="Read again" @click="reread">
            <RefreshCw class="size-3" :stroke-width="1.75" :class="busy && 'animate-spin'" /> {{ busy ? 'Reading…' : 'Read again' }}
          </button>
        </p>
        <p class="mt-1 whitespace-pre-wrap text-[14px] leading-5 text-ink-800">{{ message.mediaText }}</p>
        <TranslationLine :message="message" field="reading" @updated="(u) => emit('updated', { ...message, ...u })" />
      </div>
    </template>
    <p v-else class="flex flex-wrap items-center gap-x-2 text-[13px] leading-[18px]" :class="message.mediaTextStatus === 'FAILED' ? 'text-danger-600' : 'text-ink-500'">
      <span v-if="message.mediaTextStatus === 'FAILED'">{{ label() }} — could not be read: {{ message.mediaTextError || 'unknown reason' }}</span>
      <span v-else>{{ message.type === 'AUDIO' ? 'Not transcribed yet.' : 'Not described yet.' }}</span>
      <button class="inline-flex min-h-6 items-center gap-1 rounded-sm px-1 font-medium text-primary-700 hover:underline" :disabled="busy" @click="reread">
        <RefreshCw class="size-3" :stroke-width="1.75" :class="busy && 'animate-spin'" /> {{ busy ? 'Reading…' : message.mediaTextStatus === 'FAILED' ? 'Try again' : 'Read now' }}
      </button>
    </p>
  </div>
</template>
