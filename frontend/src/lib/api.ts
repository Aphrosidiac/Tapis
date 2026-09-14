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

/// Media is fetched with the Authorization header like every other call
/// and handed to <img>/<audio> as an object URL — a token never sits in a
/// URL, a proxy log, or a browser history. Revoke it when the element goes.
export async function fetchMediaObjectUrl(messageId: string): Promise<string> {
  const { data } = await api.get<Blob>(`/media/${messageId}`, { responseType: 'blob' })
  return URL.createObjectURL(data)
}
