<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { useAuthStore } from '../stores/auth'
import PageHeader from '../components/base/PageHeader.vue'
import BaseInput from '../components/base/BaseInput.vue'
import BaseSelect from '../components/base/BaseSelect.vue'
import BaseToggle from '../components/base/BaseToggle.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'

interface KeyView { configured: boolean; source: string; hint: string }
interface Settings {
  businessName: string; provider: 'anthropic' | 'openrouter' | 'mock'; outputLanguage: string; timezone: string
  filterModel: string; analyzeModel: string; bundleQuietSeconds: number; bundleMaxMessages: number; bundleMaxWaitSeconds: number; contextMessages: number
  allowSimulation: boolean; analyzeImages: boolean; keys: { anthropic: KeyView; openrouter: KeyView }; simulationAllowed: boolean; mockAllowed: boolean
}
interface Model { key: string; label: string; anthropic: string; openrouter: string; in: number; out: number }

const { ok, bad } = useToast()
const auth = useAuthStore()
const s = ref<Settings | null>(null)
const models = ref<Model[]>([])
const form = reactive<Partial<Settings>>({})
const keys = reactive({ anthropic: '', openrouter: '' })
const busy = ref('')
const test = ref<{ ok: boolean; message: string } | null>(null)
const account = reactive({ name: '', currentPassword: '', password: '' })

async function load() {
  const { data } = await api.get<{ settings: Settings; models: Model[] }>('/settings')
  s.value = data.settings
  models.value = data.models
  Object.assign(form, data.settings)
  account.name = auth.user?.name ?? ''
}
onMounted(load)

const modelOptions = computed(() => {
  const p = form.provider === 'openrouter' ? 'openrouter' : 'anthropic'
  const opts = models.value.map((m) => ({ value: m[p], label: `${m.label} · $${m.in}/$${m.out} per M tokens` }))
  // The mock keeps whichever ids were last chosen; offer both spellings.
  if (form.provider === 'mock') for (const m of models.value) opts.push({ value: m[p === 'openrouter' ? 'anthropic' : 'openrouter'], label: `${m.label} · $${m.in}/$${m.out} per M tokens` })
  for (const v of [form.filterModel, form.analyzeModel]) if (v && !opts.find((o) => o.value === v)) opts.push({ value: v, label: `${v} (custom)` })
  return opts
})

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
    ok('Key saved (encrypted)')
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
    const { data } = await api.put<{ user: { id: string; email: string; name: string } }>('/auth/me', account)
    auth.user = data.user
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
</script>

<template>
  <div v-if="s" class="animate-page-in">
    <PageHeader title="Settings" subtitle="Everything an operator can change, without touching a file on the server.">
      <template #actions><BaseButton :loading="busy === 'save'" @click="save">Save settings</BaseButton></template>
    </PageHeader>

    <div class="grid gap-4 lg:grid-cols-2">
      <div class="space-y-4">
        <section class="rounded-md border border-line bg-surface p-5">
          <h2 class="mb-3 text-[13px] font-bold">Business</h2>
          <div class="space-y-3">
            <BaseInput v-model="form.businessName" label="Business name" placeholder="e.g. Lewix Software House" hint="Told to the models as “We are …”, so briefs are written from your side." />
            <BaseSelect v-model="form.outputLanguage" label="Write briefs and suggestions in" :options="[{ value: 'en', label: 'English' }, { value: 'ms', label: 'Bahasa Malaysia' }, { value: 'zh', label: 'Chinese (Simplified)' }]" hint="Messages can arrive in any mix of Malay, English and Chinese. Output is always this one." />
            <BaseSelect v-model="form.timezone" label="Timezone" :options="[...new Set([form.timezone!, ...TZ])].map((t) => ({ value: t, label: t }))" />
          </div>
        </section>

        <section class="rounded-md border border-line bg-surface p-5">
          <h2 class="text-[13px] font-bold">Bundling</h2>
          <p class="mb-3 text-[11.5px] text-faint">Messages are judged in batches, so a burst of short lines reads as one thought. A batch is cut when any of these is reached.</p>
          <div class="grid gap-3 sm:grid-cols-2">
            <BaseInput v-model="form.bundleQuietSeconds" type="number" :min="10" :max="3600" label="Chat quiet for (seconds)" hint="Default 60" />
            <BaseInput v-model="form.bundleMaxMessages" type="number" :min="3" :max="100" label="Or this many waiting" hint="Default 15" />
            <BaseInput v-model="form.bundleMaxWaitSeconds" type="number" :min="30" :max="7200" label="Or oldest waited (seconds)" hint="Default 300" />
            <BaseInput v-model="form.contextMessages" type="number" :min="0" :max="60" label="Earlier messages shown as context" hint="Default 20" />
          </div>
        </section>

        <section class="rounded-md border border-line bg-surface p-5">
          <h2 class="mb-3 text-[13px] font-bold">Options</h2>
          <label class="flex items-start gap-3 py-1.5"><BaseToggle v-model="form.analyzeImages!" label="Analyse images" /><span class="text-[12.5px]"><strong>Send images to the analysis model.</strong><br /><span class="text-muted">Screenshots of bugs are usually the report. Costs a little more per image.</span></span></label>
          <label class="flex items-start gap-3 py-1.5"><BaseToggle v-model="form.allowSimulation!" label="Allow simulation" /><span class="text-[12.5px]"><strong>Allow simulated messages in production.</strong><br /><span class="text-muted">Shows an “inject a message” box on each chat for testing rules. Always on in development.</span></span></label>
        </section>

        <section class="rounded-md border border-line bg-surface p-5">
          <h2 class="mb-3 text-[13px] font-bold">Your account</h2>
          <div class="space-y-3">
            <BaseInput v-model="account.name" label="Name" />
            <div class="grid gap-3 sm:grid-cols-2">
              <BaseInput v-model="account.currentPassword" type="password" label="Current password" autocomplete="current-password" />
              <BaseInput v-model="account.password" type="password" label="New password" autocomplete="new-password" hint="Leave empty to keep it" />
            </div>
            <div class="flex justify-end"><BaseButton variant="secondary" :loading="busy === 'account'" @click="saveAccount">Update account</BaseButton></div>
          </div>
        </section>
      </div>

      <div class="space-y-4">
        <section class="rounded-md border border-line bg-surface p-5">
          <h2 class="text-[13px] font-bold">Model provider</h2>
          <p class="mb-3 text-[11.5px] text-faint">Two model calls per batch: a cheap first pass over everything, a capable second pass over what survives.</p>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="p in [['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter'], ...(s.mockAllowed ? [['mock', 'Mock (dev only)']] : [])]" :key="p[0]" type="button" :class="['rounded border px-3 py-1.5 text-[12.5px]', form.provider === p[0] ? 'border-ink bg-ink font-semibold text-white' : 'border-line bg-surface text-muted hover:text-ink']" @click="switchProvider(p[0])">{{ p[1] }}</button>
          </div>
          <p v-if="form.provider === 'mock'" class="mt-2 rounded border border-warn/40 bg-warn/8 px-3 py-2 text-[12px]">The mock calls no model. It exists to exercise the pipeline on a machine with no API credit; every brief it writes says MOCK.</p>

          <div v-for="p in (['anthropic', 'openrouter'] as const)" :key="p" :class="['mt-4', form.provider !== p && form.provider !== 'mock' && 'opacity-60']">
            <div class="flex items-center gap-2">
              <p class="text-[12.5px] font-semibold capitalize">{{ p }} API key</p>
              <BaseBadge v-if="s.keys[p].configured" tone="ok">{{ s.keys[p].source === 'env' ? 'from environment' : 'stored' }} {{ s.keys[p].hint }}</BaseBadge>
              <BaseBadge v-else tone="dormant">not set</BaseBadge>
            </div>
            <div class="mt-1.5 flex gap-1.5">
              <BaseInput v-model="keys[p]" type="password" :placeholder="p === 'anthropic' ? 'sk-ant-…' : 'sk-or-…'" autocomplete="off" />
              <BaseButton variant="secondary" class="self-start" :disabled="!keys[p]" :loading="busy === `key-${p}`" @click="saveKey(p)">Save</BaseButton>
              <BaseButton v-if="s.keys[p].source === 'settings'" variant="ghost" class="self-start" @click="clearKey(p)">Remove</BaseButton>
            </div>
          </div>
          <p class="mt-2 text-[11.5px] text-faint">Keys are encrypted at rest and never shown again. An empty box leaves the stored key alone.</p>

          <div class="mt-4 space-y-3">
            <BaseSelect v-model="form.filterModel" label="First pass (filter) model" :options="modelOptions" :disabled="form.provider === 'mock'" hint="Runs on every message. Keep it cheap." />
            <BaseSelect v-model="form.analyzeModel" label="Second pass (analysis) model" :options="modelOptions" :disabled="form.provider === 'mock'" hint="Runs only on flagged messages. This is what writes the briefs." />
          </div>
          <div class="mt-4 flex items-center gap-3">
            <BaseButton variant="secondary" :loading="busy === 'test'" @click="runTest">Save & test connection</BaseButton>
            <p v-if="test" :class="['text-[12px]', test.ok ? 'text-ok' : 'text-bad']">{{ test.message }}</p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
