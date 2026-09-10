import axios from 'axios'

export const TOKEN_KEY = 'tapis_token'

export const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((c) => {
  const t = localStorage.getItem(TOKEN_KEY)
  if (t) c.headers.Authorization = `Bearer ${t}`
  return c
})

api.interceptors.response.use(
  (r) => r,
  (e) => {
    if (e.response?.status === 401 && !location.pathname.startsWith('/login')) {
      localStorage.removeItem(TOKEN_KEY)
      location.href = '/login'
    }
    return Promise.reject(e)
  },
)

export function errorMessage(e: unknown): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string }
  return err.response?.data?.error || err.message || 'Something went wrong'
}

export function mediaUrl(messageId: string): string {
  return `/api/media/${messageId}?token=${encodeURIComponent(localStorage.getItem(TOKEN_KEY) ?? '')}`
}
