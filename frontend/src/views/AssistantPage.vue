<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Square, SendHorizontal, Trash2, ChevronDown, ChevronRight, Loader2, Wrench, MessagesSquare, X, ShieldAlert, Undo2, Check } from 'lucide-vue-next'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { streamAgentEvents, type AgentEvent } from '../lib/agentStream'
import { renderMarkdown } from '../lib/markdown'
import { ago } from '../lib/format'
import BaseButton from '../components/base/BaseButton.vue'

/// The assistant. A thread list and a transcript that streams: text as it
/// is written, each tool call as a card that fills in when the result
/// lands, reasoning behind a disclosure. Everything shown is what the
/// server stored — a reload shows the same conversation.

interface Thread { id: string; title: string; status: string; running: boolean; model: string | null; costUsd: number; inputTokens: number; outputTokens: number; turns: number; lastMessageAt: string }
interface ToolCall { id: string; name: string; input: unknown }
interface ToolResult { id: string; name: string; output: unknown; isError: boolean; ms: number }
interface Msg { id: string; seq: number; role: string; content: { text?: string; reasoning?: string; toolCalls?: ToolCall[]; toolResults?: ToolResult[] }; createdAt: string }
interface Action { id: string; callId: string | null; tool: string; tier: string; status: string; summary: string | null; input: unknown; output: unknown; undoable: boolean; createdAt: string }

const route = useRoute()
const router = useRouter()
const { ok, bad } = useToast()

const threads = ref<Thread[]>([])
const thread = ref<Thread | null>(null)
const messages = ref<Msg[]>([])
const actions = ref<Action[]>([])
const acting = ref('')
const draft = ref('')
const running = ref(false)
const listOpen = ref(false)
const expanded = ref<Set<string>>(new Set())
const scroller = ref<HTMLElement | null>(null)
const composer = ref<HTMLTextAreaElement | null>(null)

/// The turn in flight, assembled from events. `live` is the assistant
/// message being written right now; it becomes a stored message when the
/// server says so.
const live = ref<{ text: string; reasoning: string; tools: Map<string, { name: string; input: unknown; done: boolean; ok: boolean; ms: number; preview: string }> } | null>(null)
let stop: (() => void) | null = null

const threadId = computed(() => (route.params.id as string | undefined) ?? null)

async function loadThreads() {
  try {
    const { data } = await api.get<{ threads: Thread[] }>('/agent/threads')
    threads.value = data.threads
  } catch (e) {
    bad(errorMessage(e))
  }
}

async function loadThread(id: string) {
  try {
    const { data } = await api.get<{ thread: Thread & { messages: Msg[]; actions: Action[] } }>(`/agent/threads/${id}`)
    thread.value = data.thread
    messages.value = data.thread.messages
    actions.value = data.thread.actions
    running.value = data.thread.running
    await scrollDown()
    if (data.thread.running) attach(id)
  } catch (e) {
    bad(errorMessage(e))
    router.replace('/assistant')
  }
}

async function newThread() {
  try {
    const { data } = await api.post<{ thread: Thread }>('/agent/threads')
    threads.value.unshift({ ...data.thread, running: false })
    listOpen.value = false
    await router.push(`/assistant/${data.thread.id}`)
    await nextTick()
    composer.value?.focus()
  } catch (e) {
    bad(errorMessage(e))
  }
}

async function removeThread(t: Thread) {
  if (!confirm(`Delete “${t.title}”?`)) return
  try {
    await api.delete(`/agent/threads/${t.id}`)
    threads.value = threads.value.filter((x) => x.id !== t.id)
    if (threadId.value === t.id) router.replace('/assistant')
  } catch (e) {
    bad(errorMessage(e))
  }
}

async function send() {
  const text = draft.value.trim()
  if (!text || running.value) return
  let id = threadId.value
  try {
    if (!id) {
      const { data } = await api.post<{ thread: Thread }>('/agent/threads')
      threads.value.unshift({ ...data.thread, running: false })
      id = data.thread.id
    }
    draft.value = ''
    running.value = true
    live.value = { text: '', reasoning: '', tools: new Map() }
    // Start the turn before navigating to a new thread: the route watcher
    // reloads the thread, sees it running, and attaches — no race with a
    // load that would report it idle.
    await api.post(`/agent/threads/${id}/turns`, { text })
    if (threadId.value !== id) await router.push(`/assistant/${id}`)
    else attach(id)
  } catch (e) {
    running.value = false
    live.value = null
    draft.value = text
    bad(errorMessage(e))
  }
}

function attach(id: string) {
  stop?.()
  if (!live.value) live.value = { text: '', reasoning: '', tools: new Map() }
  stop = streamAgentEvents(
    id,
    (_, e) => onEvent(e),
    async (reason) => {
      running.value = false
      live.value = null
      stop = null
      if (reason === 'closed') bad('Lost the connection to the assistant. Reload to see where it got to.')
      await loadThread(id)
      await loadThreads()
    },
  )
}

function onEvent(e: AgentEvent) {
  const l = live.value
  if (!l) return
  switch (e.type) {
    case 'text':
      l.text += String(e.delta ?? '')
      break
    case 'reasoning':
      l.reasoning += String(e.delta ?? '')
      break
    case 'tool_start':
      l.tools.set(String(e.callId), { name: String(e.name), input: e.input, done: false, ok: true, ms: 0, preview: '' })
      break
    case 'tool_end': {
      const t = l.tools.get(String(e.callId))
      if (t) Object.assign(t, { done: true, ok: !!e.ok, ms: Number(e.ms ?? 0), preview: String(e.preview ?? '') })
      break
    }
    case 'message': {
      const m = e.message as Msg
      if (!messages.value.some((x) => x.id === m.id)) messages.value.push(m)
      // A stored message supersedes the live view of the same content.
      if (m.role === 'assistant') {
        l.text = ''
        l.reasoning = ''
      }
      if (m.role === 'tool') l.tools.clear()
      break
    }
    case 'approval': {
      const a = e.action as Action
      if (!actions.value.some((x) => x.id === a.id)) actions.value.push(a)
      break
    }
    case 'error':
      bad(String(e.message ?? 'The assistant hit an error'))
      break
  }
  void scrollDown()
}

/// The operator's decisions on the assistant's actions. Approve and decline
/// resume the thread, so the stream is re-attached straight away.
async function decide(a: Action, verb: 'approve' | 'decline' | 'undo') {
  acting.value = a.id
  try {
    const { data } = await api.post<{ action: Action; note?: string }>(`/agent/actions/${a.id}/${verb}`)
    Object.assign(a, data.action)
    if (verb === 'undo') ok(data.note ?? 'Undone')
    else if (threadId.value) {
      running.value = true
      attach(threadId.value)
    }
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    acting.value = ''
  }
}

async function stopTurn() {
  if (!threadId.value) return
  try {
    await api.post(`/agent/threads/${threadId.value}/stop`)
  } catch (e) {
    bad(errorMessage(e))
  }
}

async function scrollDown() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

function toggle(id: string) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expanded.value = s
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
function inputSummary(v: unknown): string {
  if (!v || typeof v !== 'object') return ''
  const parts = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined && x !== null && x !== '')
    .map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`)
  const s = parts.join(' · ')
  return s.length > 90 ? `${s.slice(0, 87)}…` : s
}
const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

const actionFor = computed(() => new Map(actions.value.filter((a) => a.callId).map((a) => [a.callId!, a])))
const TIER_CLS: Record<string, string> = { read: 'text-ink-500', write: 'text-warning-600 bg-warning-50', outward: 'text-danger-700 bg-danger-50' }

/// Stored tool results, keyed by call id, so a call card can show its answer.
const resultFor = computed(() => {
  const map = new Map<string, ToolResult>()
  for (const m of messages.value) for (const r of m.content.toolResults ?? []) map.set(r.id, r)
  return map
})

watch(
  threadId,
  (id) => {
    stop?.()
    stop = null
    live.value = null
    running.value = false
    thread.value = null
    messages.value = []
    actions.value = []
    if (id) void loadThread(id)
  },
  { immediate: true },
)
void loadThreads()
onBeforeUnmount(() => stop?.())
</script>

<template>
  <div class="rise relative -mx-4 -my-6 flex h-[calc(100dvh-4rem)] overflow-hidden lg:-mx-8">
    <!-- Threads -->
    <aside
      class="absolute inset-y-0 left-0 z-20 w-72 shrink-0 border-r border-line-200 bg-surface-0 transition-transform lg:static lg:translate-x-0"
      :class="listOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="flex h-14 items-center justify-between border-b border-line-100 px-4">
        <p class="text-[13px] font-medium uppercase tracking-wide text-ink-500">Conversations</p>
        <div class="flex items-center gap-1">
          <BaseButton size="sm" variant="secondary" @click="newThread"><Plus class="size-4" :stroke-width="1.75" /> New</BaseButton>
          <button class="grid size-9 place-items-center rounded-sm text-ink-500 lg:hidden" aria-label="Close" @click="listOpen = false"><X class="size-5" :stroke-width="1.5" /></button>
        </div>
      </div>
      <div class="h-[calc(100%-3.5rem)] overflow-y-auto">
        <p v-if="!threads.length" class="px-4 py-6 text-[13px] leading-[18px] text-ink-500">Nothing yet. Ask it what needs your attention.</p>
        <RouterLink
          v-for="t in threads"
          :key="t.id"
          :to="`/assistant/${t.id}`"
          class="group flex items-start gap-2 border-b border-line-100 px-4 py-3 hover:bg-surface-50"
          :class="t.id === threadId && 'bg-primary-50'"
          @click="listOpen = false"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-[14px] leading-5" :class="t.id === threadId ? 'font-medium text-ink-900' : 'text-ink-800'">{{ t.title }}</p>
            <p class="text-[12px] leading-4 text-ink-500">
              <Loader2 v-if="t.running" class="inline size-3 animate-spin" :stroke-width="2" />
              {{ ago(t.lastMessageAt) }} · {{ money(t.costUsd) }}
            </p>
          </div>
          <button class="hidden shrink-0 rounded-sm p-1 text-ink-400 hover:text-danger-600 group-hover:block" aria-label="Delete conversation" @click.prevent="removeThread(t)"><Trash2 class="size-3.5" :stroke-width="1.5" /></button>
        </RouterLink>
      </div>
    </aside>
    <div v-if="listOpen" class="absolute inset-0 z-10 bg-ink-900/30 lg:hidden" @click="listOpen = false" />

    <!-- Transcript -->
    <section class="flex min-w-0 flex-1 flex-col">
      <div class="flex h-14 shrink-0 items-center gap-3 border-b border-line-100 bg-surface-0 px-4 lg:px-6">
        <button class="grid size-9 place-items-center rounded-sm text-ink-500 lg:hidden" aria-label="Conversations" @click="listOpen = true"><MessagesSquare class="size-5" :stroke-width="1.5" /></button>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[15px] font-medium leading-5 text-ink-900">{{ thread?.title ?? 'Assistant' }}</p>
          <p v-if="thread" class="truncate text-[12px] leading-4 text-ink-500">
            {{ thread.model?.replace(/^.*\//, '') }} · {{ thread.turns }} turn{{ thread.turns === 1 ? '' : 's' }} · <span class="num">{{ thread.inputTokens + thread.outputTokens }}</span> tokens · {{ money(thread.costUsd) }}
          </p>
        </div>
        <BaseButton v-if="running" size="sm" variant="secondary" @click="stopTurn"><Square class="size-3.5" :stroke-width="2" /> Stop</BaseButton>
      </div>

      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-6">
        <div class="mx-auto max-w-3xl space-y-5">
          <div v-if="!threadId || (!messages.length && !live)" class="py-16 text-center">
            <p class="text-[17px] font-medium text-ink-900">What do you want to know?</p>
            <p class="mx-auto mt-2 max-w-md text-[14px] leading-5 text-ink-500">It can see every chat, message, item, run and setting, and answer with the data — “what's waiting on me”, “what did Ms L ask for this month”, “why did nothing arrive yesterday”.</p>
          </div>

          <template v-for="m in messages" :key="m.id">
            <!-- Operator -->
            <div v-if="m.role === 'user'" class="flex justify-end">
              <div class="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink-900 px-4 py-2.5 text-[15px] leading-[22px] text-white">{{ m.content.text }}</div>
            </div>

            <!-- Assistant prose and/or tool calls -->
            <div v-else-if="m.role === 'assistant'" class="space-y-2">
              <details v-if="m.content.reasoning" class="group text-[13px] leading-[18px] text-ink-500">
                <summary class="flex cursor-pointer list-none items-center gap-1 select-none"><ChevronRight class="size-3.5 transition-transform group-open:rotate-90" :stroke-width="1.75" /> Thinking</summary>
                <p class="mt-1 whitespace-pre-wrap border-l-2 border-line-200 pl-3 italic">{{ m.content.reasoning }}</p>
              </details>
              <div v-if="m.content.text" class="prose-tapis text-[15px] leading-[22px] text-ink-800" v-html="renderMarkdown(m.content.text)" />
              <div
                v-for="c in m.content.toolCalls ?? []"
                :key="c.id"
                class="rounded-md border bg-surface-0 text-[13px] leading-[18px]"
                :class="actionFor.get(c.id)?.status === 'pending' ? 'border-danger-600/40' : 'border-line-200'"
              >
                <button class="flex w-full items-center gap-2 px-3 py-2 text-left" @click="toggle(c.id)">
                  <ShieldAlert v-if="actionFor.get(c.id)?.tier === 'outward'" class="size-3.5 shrink-0 text-danger-600" :stroke-width="1.75" />
                  <Wrench v-else class="size-3.5 shrink-0 text-ink-400" :stroke-width="1.75" />
                  <span class="font-medium text-ink-800">{{ c.name }}</span>
                  <span v-if="actionFor.get(c.id) && actionFor.get(c.id)!.tier !== 'read'" class="rounded-full px-1.5 text-[11px] font-medium uppercase tracking-wide" :class="TIER_CLS[actionFor.get(c.id)!.tier]">{{ actionFor.get(c.id)!.tier }}</span>
                  <span class="min-w-0 flex-1 truncate text-ink-500">{{ actionFor.get(c.id)?.summary || inputSummary(c.input) }}</span>
                  <span v-if="actionFor.get(c.id)?.status === 'pending'" class="text-danger-700">needs your approval</span>
                  <span v-else-if="actionFor.get(c.id)?.status === 'declined'" class="text-ink-500">declined</span>
                  <span v-else-if="actionFor.get(c.id)?.status === 'undone'" class="text-ink-500">undone</span>
                  <template v-else-if="resultFor.get(c.id)">
                    <span :class="resultFor.get(c.id)!.isError ? 'text-danger-600' : 'text-ink-500'">{{ resultFor.get(c.id)!.isError ? 'error' : 'ok' }} · <span class="num">{{ resultFor.get(c.id)!.ms }}</span> ms</span>
                  </template>
                  <Loader2 v-else-if="live?.tools.get(c.id) && !live.tools.get(c.id)!.done" class="size-3.5 animate-spin text-ink-400" :stroke-width="2" />
                  <ChevronDown class="size-3.5 shrink-0 text-ink-400 transition-transform" :class="expanded.has(c.id) && 'rotate-180'" :stroke-width="1.75" />
                </button>

                <!-- An outward call waiting on the operator: the exact thing it would do, and two buttons. -->
                <div v-if="actionFor.get(c.id)?.status === 'pending'" class="border-t border-danger-600/20 bg-danger-50/40 px-3 py-3">
                  <p class="text-[14px] leading-5 font-medium text-ink-900">{{ actionFor.get(c.id)!.summary }}</p>
                  <pre class="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-line-200 bg-surface-0 px-3 py-2 text-[13px] leading-[18px] text-ink-800">{{ typeof (c.input as any)?.body === 'string' ? (c.input as any).body : pretty(c.input) }}</pre>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <BaseButton size="sm" variant="primary" :loading="acting === actionFor.get(c.id)!.id" :disabled="running" @click="decide(actionFor.get(c.id)!, 'approve')"><Check class="size-4" :stroke-width="2" /> Approve</BaseButton>
                    <BaseButton size="sm" variant="secondary" :disabled="running || acting === actionFor.get(c.id)!.id" @click="decide(actionFor.get(c.id)!, 'decline')">Decline</BaseButton>
                    <span v-if="running" class="self-center text-[12px] leading-4 text-ink-500">Wait for the assistant to finish its turn.</span>
                  </div>
                </div>

                <div v-if="expanded.has(c.id)" class="border-t border-line-100 px-3 py-2">
                  <p class="eyebrow">Input</p>
                  <pre class="mt-1 overflow-x-auto whitespace-pre-wrap text-[12px] leading-4 text-ink-700">{{ pretty(c.input) }}</pre>
                  <template v-if="resultFor.get(c.id)">
                    <p class="eyebrow mt-3">Result</p>
                    <pre class="mt-1 max-h-72 overflow-auto whitespace-pre-wrap text-[12px] leading-4 text-ink-700">{{ pretty(resultFor.get(c.id)!.output) }}</pre>
                  </template>
                  <div v-if="actionFor.get(c.id)?.undoable" class="mt-3">
                    <BaseButton size="sm" variant="secondary" :loading="acting === actionFor.get(c.id)!.id" @click="decide(actionFor.get(c.id)!, 'undo')"><Undo2 class="size-4" :stroke-width="1.75" /> Undo this change</BaseButton>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- In flight -->
          <div v-if="live && (live.text || live.reasoning || live.tools.size)" class="space-y-2">
            <details v-if="live.reasoning && !live.text" class="group text-[13px] leading-[18px] text-ink-500" open>
              <summary class="flex cursor-pointer list-none items-center gap-1 select-none"><Loader2 class="size-3.5 animate-spin" :stroke-width="2" /> Thinking</summary>
              <p class="mt-1 max-h-40 overflow-hidden whitespace-pre-wrap border-l-2 border-line-200 pl-3 italic">{{ live.reasoning.slice(-1200) }}</p>
            </details>
            <div v-if="live.text" class="prose-tapis text-[15px] leading-[22px] text-ink-800" v-html="renderMarkdown(live.text)" />
            <div v-for="[id, t] in live.tools" :key="id" class="flex items-center gap-2 rounded-md border border-line-200 bg-surface-0 px-3 py-2 text-[13px] leading-[18px]">
              <Loader2 v-if="!t.done" class="size-3.5 animate-spin text-ink-400" :stroke-width="2" />
              <Wrench v-else class="size-3.5 text-ink-400" :stroke-width="1.75" />
              <span class="font-medium text-ink-800">{{ t.name }}</span>
              <span class="min-w-0 flex-1 truncate text-ink-500">{{ inputSummary(t.input) }}</span>
              <span v-if="t.done" :class="t.ok ? 'text-ink-500' : 'text-danger-600'">{{ t.ok ? 'ok' : 'error' }} · <span class="num">{{ t.ms }}</span> ms</span>
            </div>
          </div>
          <p v-else-if="running" class="flex items-center gap-2 text-[13px] leading-[18px] text-ink-500"><Loader2 class="size-3.5 animate-spin" :stroke-width="2" /> Working…</p>
        </div>
      </div>

      <!-- Composer -->
      <div class="shrink-0 border-t border-line-100 bg-surface-0 px-4 py-3 lg:px-6" style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom))">
        <div class="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref="composer"
            v-model="draft"
            rows="1"
            class="field max-h-40 min-h-11 flex-1 resize-none py-2.5"
            placeholder="Ask about anything in Tapis…"
            :disabled="running"
            @keydown="onKey"
          />
          <BaseButton variant="primary" :disabled="!draft.trim() || running" aria-label="Send" @click="send"><SendHorizontal class="size-4" :stroke-width="1.75" /></BaseButton>
        </div>
        <p class="mx-auto mt-1.5 max-w-3xl text-[12px] leading-4 text-ink-500">Enter to send, Shift+Enter for a new line. Changes are recorded and can be undone from their card; anything that leaves the box waits for your approval.</p>
      </div>
    </section>
  </div>
</template>
