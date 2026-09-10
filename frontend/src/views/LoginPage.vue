<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api, errorMessage } from '../lib/api'
import { useAuthStore } from '../stores/auth'
import BaseInput from '../components/base/BaseInput.vue'
import BaseButton from '../components/base/BaseButton.vue'
import Alert from '../components/base/Alert.vue'

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
  <div class="flex min-h-screen items-center justify-center bg-surface-50 p-6">
    <div class="w-full max-w-[400px] rise">
      <div class="mb-6 flex items-center gap-3">
        <span class="grid size-10 place-items-center rounded-md bg-ink-900">
          <svg viewBox="0 0 32 32" class="size-5" aria-hidden="true">
            <path d="M7 9h18M9.5 15.5h13M13 22h6" stroke="#4fb6a9" stroke-width="3" stroke-linecap="round" fill="none" />
          </svg>
        </span>
        <div>
          <h1 class="text-[22px] font-semibold leading-7 tracking-[-0.015em]">Tapis</h1>
          <p class="text-[14px] leading-5 text-ink-500">WhatsApp chatter, sifted into items.</p>
        </div>
      </div>

      <form class="card space-y-4 p-6" @submit.prevent="submit">
        <p v-if="needsSetup === null" class="text-[14px] text-ink-500">Checking…</p>
        <template v-else>
          <Alert v-if="needsSetup" tone="info" title="First run">
            Create the account that will manage this install.
          </Alert>
          <BaseInput v-if="needsSetup" v-model="name" label="Your name" required autocomplete="name" />
          <BaseInput v-model="email" label="Email" type="email" required autocomplete="username" />
          <BaseInput
            v-model="password"
            label="Password"
            type="password"
            required
            :autocomplete="needsSetup ? 'new-password' : 'current-password'"
            :hint="needsSetup ? 'At least 8 characters' : ''"
          />
          <p v-if="error" class="text-[14px] leading-5 text-danger-600">{{ error }}</p>
          <BaseButton type="submit" variant="primary" size="lg" block :loading="busy">
            {{ needsSetup ? 'Create account' : 'Sign in' }}
          </BaseButton>
        </template>
      </form>
    </div>
  </div>
</template>
