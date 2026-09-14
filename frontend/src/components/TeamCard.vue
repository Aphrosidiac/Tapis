<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Users } from 'lucide-vue-next'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import Card from './base/Card.vue'
import BaseInput from './base/BaseInput.vue'
import BaseToggle from './base/BaseToggle.vue'
import BaseBadge from './base/BaseBadge.vue'

/// Settings → Your team. Every sender the link has seen, one row per id,
/// with a switch. Chosen, never typed: the id matched at ingest is the id
/// on the row, so there is no number to mistype and no name to mismatch.
interface Person {
  waId: string
  name: string | null
  names: string[]
  chats: { id: string; name: string }[]
  messageCount: number
  lastSeenAt: string
  team: boolean
}

const { ok, bad } = useToast()
const people = ref<Person[]>([])
const q = ref('')
const busy = ref('')
const loaded = ref(false)

const shown = computed(() => {
  const needle = q.value.trim().toLowerCase()
  const list = needle
    ? people.value.filter((p) => p.waId.includes(needle) || p.names.some((n) => n.toLowerCase().includes(needle)) || p.chats.some((c) => c.name.toLowerCase().includes(needle)))
    : people.value
  return list.slice(0, 60)
})
const teamCount = computed(() => people.value.filter((p) => p.team).length)

function display(p: Person) {
  return p.name || (p.waId.startsWith('lid:') ? 'Unknown contact' : `+${p.waId}`)
}

async function load() {
  try {
    const { data } = await api.get<{ people: Person[] }>('/team')
    people.value = data.people
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    loaded.value = true
  }
}

async function toggle(p: Person, on: boolean) {
  busy.value = p.waId
  try {
    await api.put(`/team/${encodeURIComponent(p.waId)}`, { team: on, name: p.name })
    p.team = on
    ok(on ? `${display(p)} is on your team` : `${display(p)} is no longer marked as team`)
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<template>
  <Card
    title="Your team"
    :sub="`Your own people, by WhatsApp number, across every chat. Their messages are context for the models — never a request to track — and are labelled as your side. ${teamCount} marked.`"
  >
    <BaseInput v-model="q" placeholder="Search by name, number or chat…" />
    <p v-if="loaded && !people.length" class="mt-4 text-[14px] leading-5 text-ink-500">Nobody has spoken in a tracked chat yet. People appear here as they do.</p>
    <p v-else-if="loaded && !shown.length" class="mt-4 text-[14px] leading-5 text-ink-500">No one matches.</p>
    <div v-else class="mt-3 divide-y divide-line-100">
      <div v-for="p in shown" :key="p.waId" class="flex items-center gap-3 py-2.5">
        <Users class="size-4 shrink-0 text-ink-400" :stroke-width="1.5" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[14px] leading-5 text-ink-900">
            <span class="font-medium">{{ display(p) }}</span>
            <span v-if="p.name && !p.waId.startsWith('lid:')" class="num ml-2 text-ink-500">+{{ p.waId }}</span>
            <BaseBadge v-if="p.team" tone="accent" class="ml-2">our team</BaseBadge>
          </p>
          <p class="truncate text-[13px] leading-[18px] text-ink-500">
            <span class="num">{{ p.chats.length }}</span> chat{{ p.chats.length === 1 ? '' : 's' }} · <span class="num">{{ p.messageCount }}</span> message{{ p.messageCount === 1 ? '' : 's' }}
            <template v-if="p.chats.length"> · {{ p.chats.slice(0, 3).map((c) => c.name).join(', ') }}{{ p.chats.length > 3 ? '…' : '' }}</template>
          </p>
        </div>
        <BaseToggle :model-value="p.team" :disabled="busy === p.waId" :label="`${display(p)} is on our team`" @update:model-value="(v) => toggle(p, v)" />
      </div>
    </div>
  </Card>
</template>
