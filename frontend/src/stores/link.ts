import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../lib/api'

export interface LinkStatus {
  installed: boolean | null
  state: string
  socketOpen: boolean
  ready: boolean
  hasSession: boolean
  qr: string | null
  qrIssuedAt: string | null
  pairingExpiresAt: string | null
  pairingCode: string | null
  me: { id: string; name: string | null } | null
  connectedAt: string | null
  disconnectedAt: string | null
  lastEventAt: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  inboundStored: number
  inboundIgnored: number
  lastError: string | null
  lastErrorAt: string | null
  ghostDevice: string | null
  attempts: number
  nextRetryAt: string | null
  action: string | null
}

export const useLinkStore = defineStore('link', () => {
  const link = ref<LinkStatus | null>(null)
  const sessionFiles = ref(0)
  async function refresh() {
    try {
      const { data } = await api.get<{ link: LinkStatus; sessionFiles: number }>('/whatsapp/status')
      link.value = data.link
      sessionFiles.value = data.sessionFiles
    } catch {
      /* the navbar pill simply keeps its last value */
    }
  }
  function set(l: LinkStatus) {
    link.value = l
  }
  return { link, sessionFiles, refresh, set }
})
