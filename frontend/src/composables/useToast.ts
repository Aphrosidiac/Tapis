import { ref } from 'vue'

export interface Toast { id: number; message: string; kind: 'ok' | 'bad' | 'info' }
const toasts = ref<Toast[]>([])
let nextId = 1

export function useToast() {
  function push(message: string, kind: Toast['kind'] = 'info', ms = 4000) {
    const id = nextId++
    toasts.value.push({ id, message, kind })
    setTimeout(() => dismiss(id), ms)
  }
  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }
  return { toasts, dismiss, toast: push, ok: (m: string) => push(m, 'ok'), bad: (m: string) => push(m, 'bad', 6000) }
}
