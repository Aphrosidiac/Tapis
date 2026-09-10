import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, TOKEN_KEY } from '../lib/api'

export interface User { id: string; email: string; name: string }

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const ready = ref(false)
  const isAuthenticated = computed(() => !!user.value)

  async function restore() {
    ready.value = true
    if (!localStorage.getItem(TOKEN_KEY)) return
    try {
      const { data } = await api.get<{ user: User }>('/auth/me')
      user.value = data.user
    } catch {
      localStorage.removeItem(TOKEN_KEY)
    }
  }

  function accept(token: string, u: User) {
    localStorage.setItem(TOKEN_KEY, token)
    user.value = u
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    user.value = null
  }

  return { user, ready, isAuthenticated, restore, accept, logout }
})
