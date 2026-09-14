<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { fetchMediaObjectUrl } from '../lib/api'

/// Loads one message's media through the API with the auth header and
/// exposes it as an object URL for the slotted <img> or <audio>.
const props = defineProps<{ messageId: string }>()
const src = ref<string | null>(null)
const failed = ref(false)

async function load() {
  release()
  failed.value = false
  try {
    src.value = await fetchMediaObjectUrl(props.messageId)
  } catch {
    failed.value = true
  }
}
function release() {
  if (src.value) URL.revokeObjectURL(src.value)
  src.value = null
}
watch(() => props.messageId, load, { immediate: true })
onBeforeUnmount(release)
</script>

<template>
  <slot v-if="src" :src="src" />
  <p v-else-if="failed" class="mt-3 text-[13px] text-ink-500">Media could not be loaded.</p>
</template>
