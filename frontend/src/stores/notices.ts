import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../lib/api'

export type NoticeTone = 'danger' | 'warning' | 'info'
export interface Notice {
  id: string
  tone: NoticeTone
  title: string
  body: string
  to?: string
  action?: string
}

export const useNoticesStore = defineStore('notices', () => {
  const notices = ref<Notice[]>([])
  const loaded = ref(false)

  async function refresh() {
    try {
      const { data } = await api.get<{ notices: Notice[] }>('/notices')
      notices.value = data.notices
      loaded.value = true
    } catch {
      // A failed poll keeps the last known list. A panel that empties itself
      // because one request timed out would say "nothing needs you" at the
      // exact moment something does.
    }
  }

  const count = computed(() => notices.value.length)
  const worst = computed<NoticeTone | 'none'>(() =>
    notices.value.some((n) => n.tone === 'danger')
      ? 'danger'
      : notices.value.some((n) => n.tone === 'warning')
        ? 'warning'
        : notices.value.length
          ? 'info'
          : 'none',
  )

  return { notices, loaded, refresh, count, worst }
})
