import { onMounted, onUnmounted } from 'vue'

/// Calls `fn` now and every `ms` while the component is mounted. Not gated
/// on tab visibility on purpose: a pairing QR that goes stale in a background
/// tab is worse than a few cheap requests.
export function usePolling(fn: () => void | Promise<void>, ms: number) {
  let timer: number | null = null
  onMounted(() => {
    void fn()
    timer = window.setInterval(() => void fn(), ms)
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })
}
