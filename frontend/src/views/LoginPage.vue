<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { useAuthStore } from '../stores/auth'
import BaseInput from '../components/base/BaseInput.vue'
import BaseButton from '../components/base/BaseButton.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const needsSetup = ref<boolean | null>(null)
const email = ref('')
const password = ref('')
const name = ref('')
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  try {
    const { data } = await api.get<{ needsSetup: boolean }>('/auth/status')
    needsSetup.value = data.needsSetup
  } catch (e) {
    error.value = errorMessage(e)
    needsSetup.value = false
  }
})

async function submit() {
  error.value = ''
  busy.value = true
  try {
    const { data } = needsSetup.value
      ? await api.post('/auth/setup', { email: email.value, password: password.value, name: name.value })
      : await api.post('/auth/login', { email: email.value, password: password.value })
    auth.accept(data.token, data.user)
    router.push((route.query.next as string) || '/')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-canvas p-6">
    <div class="w-full max-w-sm animate-page-in">
      <div class="mb-6 flex items-center gap-3">
        <span class="inline-flex h-9 w-9 items-center justify-center rounded bg-ink">
          <svg viewBox="0 0 32 32" class="h-5 w-5"><path d="M7 9h18M9 15h14M12 21h8" stroke="#2dd4bf" stroke-width="3.5" stroke-linecap="square" fill="none" /></svg>
        </span>
        <div>
          <h1 class="text-[18px] font-bold tracking-tight">Tapis</h1>
          <p class="text-[12px] text-muted">WhatsApp chatter, sifted into items.</p>
        </div>
      </div>
      <form class="space-y-3 rounded-md border border-line bg-surface p-5" @submit.prevent="submit">
        <template v-if="needsSetup === null"><p class="text-[12.5px] text-muted">Checking…</p></template>
        <template v-else>
          <div v-if="needsSetup" class="rounded border border-accent/30 bg-accent-soft px-3 py-2 text-[12px] text-accent-strong">
            First run. Create the account that will manage this install.
          </div>
          <BaseInput v-if="needsSetup" v-model="name" label="Your name" required autocomplete="name" />
          <BaseInput v-model="email" label="Email" type="email" required autocomplete="username" />
          <BaseInput v-model="password" label="Password" type="password" required :autocomplete="needsSetup ? 'new-password' : 'current-password'" :hint="needsSetup ? 'At least 8 characters' : ''" />
          <p v-if="error" class="text-[12px] text-bad">{{ error }}</p>
          <BaseButton type="submit" size="lg" class="w-full" :loading="busy">{{ needsSetup ? 'Create account' : 'Sign in' }}</BaseButton>
        </template>
      </form>
    </div>
  </div>
</template>
