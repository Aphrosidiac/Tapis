<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { useAuthStore } from '../stores/auth'
import { useNoticesStore } from '../stores/notices'
import PageHeader from '../components/base/PageHeader.vue'
import Card from '../components/base/Card.vue'
import Alert from '../components/base/Alert.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import BaseToggle from '../components/base/BaseToggle.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import TeamCard from '../components/TeamCard.vue'

interface KeyView { configured: boolean; source: string; hint: string }
interface Settings {
  businessName: string
  provider: 'anthropic' | 'openrouter' | 'mock'
  outputLanguage: string
  timezone: string
  filterModel: string
  analyzeModel: string
  bundleQuietSeconds: number
  bundleMaxMessages: number
  bundleMaxWaitSeconds: number
  contextMessages: number
  allowSimulation: boolean
  analyzeImages: boolean
  describeImages: boolean
  transcribeVoice: boolean
  transcribeModel: string
  translateOriginals: boolean
  agentModel: string
  agentEscalationModel: string
  agentEffort: 'low' | 'medium' | 'high'
  agentReflect: boolean
  operatorWaId: string
  agentDigest: boolean
  agentDigestHour: number
  agentWhatsapp: boolean
  keys: { anthropic: KeyView; openrouter: KeyView }
  simulationAllowed: boolean
  mockAllowed: boolean
}
interface Model { key: string; label: string; anthropic: string; openrouter: string; in: number; out: number }

const { ok, bad } = useToast()
const auth = useAuthStore()
const notices = useNoticesStore()
const s = ref<Settings | null>(null)
const models = ref<Model[]>([])
const audioModels = ref<Model[]>([])
const agentModels = ref<Model[]>([])
const form = reactive<Partial<Settings>>({})
const keys = reactive({ anthropic: '', openrouter: '' })
const busy = ref('')
const test = ref<{ ok: boolean; message: string } | null>(null)
const account = reactive({ name: '', currentPassword: '', password: '' })

async function load() {
  const { data } = await api.get<{ settings: Settings; models: Model[]; audioModels: Model[]; agentModels: Model[] }>('/settings')
  s.value = data.settings
  models.value = data.models
  audioModels.value = data.audioModels
  agentModels.value = data.agentModels
  Object.assign(form, data.settings)
  account.name = auth.user?.name ?? ''
}
onMounted(load)

const audioModelOptions = computed(() =>
  [...new Set([form.transcribeModel!, ...audioModels.value.map((m) => m.openrouter)])].filter(Boolean).map((id) => {
    const m = audioModels.value.find((x) => x.openrouter === id)
    return { value: id, label: m ? `${m.label} · $${m.in}/$${m.out} per M tokens` : `${id} (custom)` }
  }),
)

const modelOptions = computed(() => {
  const p = form.provider === 'openrouter' ? 'openrouter' : 'anthropic'
  const opts = models.value.filter((m) => m[p]).map((m) => ({ value: m[p], label: `${m.label} · $${m.in}/$${m.out} per M tokens` }))
  // The mock keeps whichever ids were last chosen, so offer both spellings.
  if (form.provider === 'mock')
    for (const m of models.value) if (m[p === 'openrouter' ? 'anthropic' : 'openrouter']) opts.push({ value: m[p === 'openrouter' ? 'anthropic' : 'openrouter'], label: `${m.label} · $${m.in}/$${m.out} per M tokens` })
  for (const v of [form.filterModel, form.analyzeModel]) if (v && !opts.find((o) => o.value === v)) opts.push({ value: v, label: `${v} (custom)` })
  return opts
})

/// Changing provider must carry the chosen models across, or the id from the
/// other provider is silently kept and every call 404s.
function switchProvider(p: string) {
  const from = form.provider === 'openrouter' ? 'openrouter' : 'anthropic'
  const to = p === 'openrouter' ? 'openrouter' : 'anthropic'
  form.provider = p as Settings['provider']
  if (from !== to) {
    for (const k of ['filterModel', 'analyzeModel'] as const) {
      const m = models.value.find((x) => x[from] === form[k])
      if (m) form[k] = m[to]
    }
  }
}

async function save() {
  busy.value = 'save'
  try {
    const { data } = await api.put<{ settings: Settings }>('/settings', form)
    s.value = data.settings
    Object.assign(form, data.settings)
    void notices.refresh()
    ok('Settings saved')
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function saveKey(p: 'anthropic' | 'openrouter') {
  busy.value = `key-${p}`
  try {
    const { data } = await api.post<{ settings: Settings }>(`/settings/keys/${p}`, { key: keys[p] })
    s.value = data.settings
    keys[p] = ''
    void notices.refresh()
    ok('Key saved, encrypted at rest')
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function clearKey(p: 'anthropic' | 'openrouter') {
  if (!confirm('Remove the stored key? The environment variable, if set, is used instead.')) return
  try {
    const { data } = await api.delete<{ settings: Settings }>(`/settings/keys/${p}`)
    s.value = data.settings
    void notices.refresh()
    ok('Stored key removed')
  } catch (e) {
    bad(errorMessage(e))
  }
}
async function runTest() {
  busy.value = 'test'
  test.value = null
  try {
    await api.put('/settings', form)
    const { data } = await api.post<{ ok: boolean; message: string }>('/settings/test', {})
    test.value = data
  } catch (e) {
    test.value = { ok: false, message: errorMessage(e) }
  } finally {
    busy.value = ''
  }
}
async function saveAccount() {
  busy.value = 'account'
  try {
    const { data } = await api.put<{ user: { id: string; email: string; name: string }; token?: string }>('/auth/me', account)
    // A password change retires the old token server-side; keep the new one.
    if (data.token) auth.accept(data.token, data.user)
    else auth.user = data.user
    account.currentPassword = ''
    account.password = ''
    ok('Account updated')
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}

const TZ = ['Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Manila', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Dubai', 'Europe/London', 'UTC']
const PROVIDERS = computed(() => [
  ['anthropic', 'Anthropic'],
  ['openrouter', 'OpenRouter'],
  ...(s.value?.mockAllowed ? [['mock', 'Mock · dev only']] : []),
])
</script>

<template>
  <div v-if="s" class="rise">
    <PageHeader title="Settings" subtitle="Everything an operator can change, without touching a file on the server.">
      <template #actions><BaseButton variant="primary" :loading="busy === 'save'" @click="save">Save settings</BaseButton></template>
    </PageHeader>

    <div class="grid gap-6 lg:grid-cols-2">
      <div class="space-y-6">
        <Card title="Business">
          <div class="space-y-4">
            <BaseInput
              v-model="form.businessName"
              label="Business name"
              placeholder="e.g. Lewix Software House"
              hint="Told to the models as “We are …”, so briefs are written from your side."
            />
            <BaseSelect
              v-model="form.outputLanguage"
              label="Write briefs and suggestions in"
              :options="[
                { value: 'en', label: 'English' },
                { value: 'ms', label: 'Bahasa Malaysia' },
                { value: 'zh', label: 'Chinese (Simplified)' },
              ]"
              hint="Messages can arrive in any mix of Malay, English and Chinese. Output is always this one."
            />
            <BaseSelect v-model="form.timezone" label="Timezone" :options="[...new Set([form.timezone!, ...TZ])].map((t) => ({ value: t, label: t }))" />
          </div>
        </Card>

        <Card title="Bundling" sub="Messages are judged in batches, so a burst of short lines reads as one thought. A batch is cut when any of these is reached.">
          <div class="grid gap-4 sm:grid-cols-2">
            <BaseInput v-model="form.bundleQuietSeconds" type="number" :min="10" :max="3600" label="Chat quiet for (seconds)" hint="Default 60" />
            <BaseInput v-model="form.bundleMaxMessages" type="number" :min="3" :max="100" label="Or this many waiting" hint="Default 15" />
            <BaseInput v-model="form.bundleMaxWaitSeconds" type="number" :min="30" :max="7200" label="Or oldest waited (seconds)" hint="Default 300" />
            <BaseInput v-model="form.contextMessages" type="number" :min="0" :max="60" label="Earlier messages as context" hint="Default 20" />
          </div>
        </Card>

        <Card title="Assistant" sub="The model behind the Assistant screen. Any tool-calling model on OpenRouter works; the harness carries the reliability, so a cheap one does well.">
          <div class="space-y-4">
            <BaseSelect
              v-model="form.agentModel"
              label="Model"
              :options="[...new Set([form.agentModel!, ...agentModels.map((m) => m.openrouter)])].map((id) => ({ value: id, label: agentModels.find((m) => m.openrouter === id) ? `${agentModels.find((m) => m.openrouter === id)!.label} · $${agentModels.find((m) => m.openrouter === id)!.in}/$${agentModels.find((m) => m.openrouter === id)!.out} per M tokens` : id }))"
            />
            <BaseSelect
              v-model="form.agentEscalationModel"
              label="Escalation model"
              :options="[...new Set([form.agentEscalationModel!, ...agentModels.map((m) => m.openrouter)])].map((id) => ({ value: id, label: agentModels.find((m) => m.openrouter === id) ? `${agentModels.find((m) => m.openrouter === id)!.label} · $${agentModels.find((m) => m.openrouter === id)!.in}/$${agentModels.find((m) => m.openrouter === id)!.out} per M tokens` : id }))"
              hint="Takes over a turn when the first model fails or keeps calling tools wrongly. Rare, so it may cost more."
            />
            <BaseSelect
              v-model="form.agentEffort"
              label="Reasoning effort"
              :options="[
                { value: 'low', label: 'Low — quick answers' },
                { value: 'medium', label: 'Medium — the default' },
                { value: 'high', label: 'High — for hard questions' },
              ]"
            />
            <BaseInput
              v-model="form.operatorWaId"
              label="Your own number"
              placeholder="60123456789"
              hint="The ONLY WhatsApp number the assistant can ever message — for the morning brief and for talking to it from your phone. It refuses every other number; no approval overrides this."
            />
            <label class="flex items-start gap-3 py-2">
              <BaseToggle v-model="form.agentReflect!" label="Nightly reflection" />
              <span class="text-[14px] leading-5">
                <span class="font-medium text-ink-900">Consolidate memory every night at 3am.</span><br />
                <span class="text-ink-500">It re-reads the day's conversations, actions and items, and tidies what it remembers. Costs about a cent.</span>
              </span>
            </label>
            <label class="flex items-start gap-3 py-2">
              <BaseToggle v-model="form.agentDigest!" label="Morning brief" />
              <span class="text-[14px] leading-5">
                <span class="font-medium text-ink-900">Send a morning brief to your WhatsApp.</span><br />
                <span class="text-ink-500">What needs you today — chasing, left sitting, urgent, failures — as one message, written from the data.</span>
              </span>
            </label>
            <label class="flex items-start gap-3 py-2">
              <BaseToggle v-model="form.agentWhatsapp!" label="Assistant over WhatsApp" />
              <span class="text-[14px] leading-5">
                <span class="font-medium text-ink-900">Talk to it from your phone.</span><br />
                <span class="text-ink-500">Message your own number (the “You” chat on the linked account) and it answers there. Anything that needs approval comes with a code — reply YES 1234 or NO 1234. “new” starts a fresh conversation, “stop” cancels. Only works when the linked account is your own number.</span>
              </span>
            </label>
            <div v-if="form.agentDigest" class="pl-14 sm:w-40">
              <BaseInput v-model="form.agentDigestHour" type="number" :min="0" :max="23" label="Brief at (hour)" hint="Local time, to your own number" />
            </div>
          </div>
        </Card>

        <Card title="Options">
          <label class="flex items-start gap-3 py-2">
            <BaseToggle v-model="form.analyzeImages!" label="Analyse images" />
            <span class="text-[14px] leading-5">
              <span class="font-medium text-ink-900">Send images to the analysis model.</span><br />
              <span class="text-ink-500">Screenshots of bugs are usually the report. Costs a little more per image.</span>
            </span>
          </label>
          <label class="flex items-start gap-3 py-2">
            <BaseToggle v-model="form.describeImages!" label="Describe images" />
            <span class="text-[14px] leading-5">
              <span class="font-medium text-ink-900">Read every image before it is judged.</span><br />
              <span class="text-ink-500">The first-pass model writes what the picture shows and any text in it, so a screenshot with no caption is judged on what it contains. One cheap call per image; the reading is shown under the message. Needs a first-pass model that reads images — the ones marked so in the list.</span>
            </span>
          </label>
          <label class="flex items-start gap-3 py-2">
            <BaseToggle v-model="form.transcribeVoice!" label="Transcribe voice notes" />
            <span class="text-[14px] leading-5">
              <span class="font-medium text-ink-900">Transcribe every voice note before it is judged.</span><br />
              <span class="text-ink-500">Verbatim, in whatever mix of Malay, English and Chinese was spoken. Needs an OpenRouter key whatever the provider — the Anthropic API takes no audio. A 30-second note costs well under a cent.</span>
            </span>
          </label>
          <label class="flex items-start gap-3 py-2">
            <BaseToggle v-model="form.translateOriginals!" label="Translate Chinese originals" />
            <span class="text-[14px] leading-5">
              <span class="font-medium text-ink-900">Show Chinese messages, transcripts and readings with a translation underneath.</span><br />
              <span class="text-ink-500">Into the output language above, by the filter model, one call per bundle. The original is never replaced.</span>
            </span>
          </label>
          <label class="flex items-start gap-3 py-2">
            <BaseToggle v-model="form.allowSimulation!" label="Allow simulation" />
            <span class="text-[14px] leading-5">
              <span class="font-medium text-ink-900">Allow simulated messages in production.</span><br />
              <span class="text-ink-500">Shows an “inject a message” box on each chat for testing rules. Always on in development.</span>
            </span>
          </label>
        </Card>

        <TeamCard />

        <Card title="Your account">
          <div class="space-y-4">
            <BaseInput v-model="account.name" label="Name" />
            <div class="grid gap-4 sm:grid-cols-2">
              <BaseInput v-model="account.currentPassword" type="password" label="Current password" autocomplete="current-password" />
              <BaseInput v-model="account.password" type="password" label="New password" autocomplete="new-password" hint="Leave empty to keep it" />
            </div>
            <div class="flex justify-end"><BaseButton variant="secondary" :loading="busy === 'account'" @click="saveAccount">Update account</BaseButton></div>
          </div>
        </Card>
      </div>

      <div class="space-y-6">
        <Card title="Model provider" sub="Two model calls per batch: a cheap first pass over everything, a capable second pass over what survives.">
          <div class="flex flex-wrap gap-2">
            <button
              v-for="p in PROVIDERS"
              :key="p[0]"
              type="button"
              class="rounded-sm border px-3.5 py-2 text-[14px] leading-5"
              :class="form.provider === p[0] ? 'border-ink-900 bg-ink-900 font-medium text-white' : 'border-line-200 bg-surface-0 text-ink-600 hover:border-ink-300 hover:text-ink-900'"
              @click="switchProvider(p[0])"
            >
              {{ p[1] }}
            </button>
          </div>

          <Alert v-if="form.provider === 'mock'" tone="warning" title="The mock calls no model" class="mt-4">
            It exists to exercise the pipeline on a machine with no API credit. Every brief it writes says MOCK.
          </Alert>

          <div v-for="p in (['anthropic', 'openrouter'] as const)" :key="p" class="mt-5" :class="form.provider !== p && form.provider !== 'mock' && 'opacity-60'">
            <div class="mb-1.5 flex flex-wrap items-center gap-2">
              <p class="text-[14px] font-medium capitalize leading-5 text-ink-800">{{ p }} API key</p>
              <BaseBadge v-if="s.keys[p].configured" tone="ok">{{ s.keys[p].source === 'env' ? 'from environment' : 'stored' }} {{ s.keys[p].hint }}</BaseBadge>
              <BaseBadge v-else tone="dormant">not set</BaseBadge>
            </div>
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <input v-model="keys[p]" class="field" type="password" :placeholder="p === 'anthropic' ? 'sk-ant-…' : 'sk-or-…'" autocomplete="off" :aria-label="`${p} API key`" />
              </div>
              <BaseButton variant="secondary" :disabled="!keys[p]" :loading="busy === `key-${p}`" @click="saveKey(p)">Save</BaseButton>
              <BaseButton v-if="s.keys[p].source === 'settings'" variant="ghost" @click="clearKey(p)">Remove</BaseButton>
            </div>
          </div>
          <p class="mt-2 text-[13px] leading-[18px] text-ink-500">
            Keys are encrypted at rest and never shown again. An empty box leaves the stored key alone.
          </p>

          <div class="mt-5 space-y-4">
            <BaseSelect v-model="form.filterModel" label="First pass (filter) model" :options="modelOptions" :disabled="form.provider === 'mock'" hint="Runs on every message. Keep it cheap." />
            <BaseSelect v-model="form.analyzeModel" label="Second pass (analysis) model" :options="modelOptions" :disabled="form.provider === 'mock'" hint="Runs only on flagged messages. This writes the briefs." />
            <BaseSelect
              v-model="form.transcribeModel"
              label="Voice note (transcription) model"
              :options="audioModelOptions"
              :disabled="form.provider === 'mock' || !form.transcribeVoice"
              :hint="!form.transcribeVoice ? 'Voice notes are not transcribed — switch it on under Options.' : s?.keys.openrouter.configured ? 'Always called through OpenRouter, whatever the provider — the Anthropic API takes no audio. Images are read by the first-pass model.' : 'No OpenRouter key yet — add one above or voice notes stay untranscribed.'"
            />
          </div>

          <div class="mt-5 flex flex-wrap items-center gap-3">
            <BaseButton variant="secondary" :loading="busy === 'test'" @click="runTest">Save &amp; test connection</BaseButton>
            <p v-if="test" class="text-[14px] leading-5" :class="test.ok ? 'text-success-600' : 'text-danger-600'">{{ test.message }}</p>
          </div>
        </Card>
      </div>
    </div>
  </div>
</template>
