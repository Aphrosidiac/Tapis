<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { X, FileText, Plus, Trash2, Save } from 'lucide-vue-next'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { ago } from '../lib/format'
import BaseButton from './base/BaseButton.vue'
import BaseInput from './base/BaseInput.vue'

/// What the assistant remembers, readable and editable. Nothing it knows
/// about how to work with you is hidden from you.
interface File { path: string; chars: number; updatedAt: string }

defineEmits<{ close: [] }>()
const { ok, bad } = useToast()
const files = ref<File[]>([])
const open = ref<{ path: string; content: string; dirty: boolean } | null>(null)
const creating = ref(false)
const newPath = ref('')
const busy = ref('')

async function load() {
  try {
    const { data } = await api.get<{ files: File[] }>('/agent/memory')
    files.value = data.files
  } catch (e) {
    bad(errorMessage(e))
  }
}
async function view(f: File) {
  try {
    const { data } = await api.get<{ path: string; content: string }>(`/agent/memory/${f.path}`)
    open.value = { path: data.path, content: data.content, dirty: false }
    creating.value = false
  } catch (e) {
    bad(errorMessage(e))
  }
}
async function save() {
  if (!open.value) return
  busy.value = 'save'
  try {
    await api.put(`/agent/memory/${open.value.path}`, { content: open.value.content })
    open.value.dirty = false
    ok('Saved')
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function remove() {
  if (!open.value || !confirm(`Forget ${open.value.path}?`)) return
  busy.value = 'delete'
  try {
    await api.delete(`/agent/memory/${open.value.path}`)
    open.value = null
    await load()
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
function startNew() {
  creating.value = true
  newPath.value = ''
  open.value = null
}
function createFile() {
  const p = newPath.value.trim().replace(/^\/?memories\//, '').replace(/^\/+/, '')
  if (!p) return
  open.value = { path: p, content: '', dirty: true }
  creating.value = false
}
onMounted(load)
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-line-100 px-4">
      <p class="min-w-0 flex-1 truncate text-[15px] font-medium leading-5 text-ink-900">{{ open ? open.path : 'Memory' }}</p>
      <BaseButton v-if="!open && !creating" size="sm" variant="secondary" @click="startNew"><Plus class="size-4" :stroke-width="1.75" /> New</BaseButton>
      <template v-if="open">
        <BaseButton size="sm" variant="primary" :disabled="!open.dirty" :loading="busy === 'save'" @click="save"><Save class="size-4" :stroke-width="1.75" /> Save</BaseButton>
        <button class="grid size-9 place-items-center rounded-sm text-ink-400 hover:text-danger-600" aria-label="Forget this file" :disabled="busy === 'delete'" @click="remove"><Trash2 class="size-4" :stroke-width="1.5" /></button>
      </template>
      <button class="grid size-9 place-items-center rounded-sm text-ink-500 hover:text-ink-900" aria-label="Close" @click="open ? (open = null) : $emit('close')"><X class="size-5" :stroke-width="1.5" /></button>
    </div>

    <div v-if="open" class="flex min-h-0 flex-1 flex-col p-4">
      <textarea v-model="open.content" class="field min-h-0 flex-1 resize-none font-mono text-[13px] leading-[18px]" spellcheck="false" @input="open.dirty = true" />
      <p class="mt-2 text-[12px] leading-4 text-ink-500">Plain text the assistant reads at the start of every conversation (operator.md) or on demand (the rest). Edit freely — it will read your version.</p>
    </div>

    <div v-else-if="creating" class="p-4">
      <BaseInput v-model="newPath" label="Path under /memories" placeholder="clients/harvestgrow.md" hint="Letters, digits, - _ . and at most two folders." @keydown.enter="createFile" />
      <div class="mt-3 flex gap-2">
        <BaseButton size="sm" variant="primary" :disabled="!newPath.trim()" @click="createFile">Create</BaseButton>
        <BaseButton size="sm" variant="secondary" @click="creating = false">Cancel</BaseButton>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="!files.length" class="px-4 py-6 text-[13px] leading-[18px] text-ink-500">Nothing remembered yet. It writes here when it learns something durable — how you like things done, what it learned about a client, a procedure that worked. The nightly reflection tidies it.</p>
      <button v-for="f in files" :key="f.path" class="flex w-full items-center gap-3 border-b border-line-100 px-4 py-3 text-left hover:bg-surface-50" @click="view(f)">
        <FileText class="size-4 shrink-0 text-ink-400" :stroke-width="1.5" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[14px] leading-5 text-ink-800">{{ f.path }}</span>
          <span class="block text-[12px] leading-4 text-ink-500"><span class="num">{{ f.chars }}</span> chars · {{ ago(f.updatedAt) }}</span>
        </span>
      </button>
    </div>
  </div>
</template>
