<script setup lang="ts">
import { computed, ref, reactive } from 'vue'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { usePolling } from '../composables/usePolling'
import { useLinkStore, type LinkStatus } from '../stores/link'
import { fmtDateTime, ago } from '../lib/format'
import PageHeader from '../components/base/PageHeader.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseInput from '../components/base/BaseInput.vue'
import { QrCode, Smartphone, Unlink, Square } from 'lucide-vue-next'

const { ok, bad } = useToast()
const store = useLinkStore()
const link = computed(() => store.link)
const busy = ref('')
const pair = reactive({ number: '' })

// Fast while pairing: WhatsApp rotates the QR every ~20s and it must never
// be shown stale.
usePolling(() => store.refresh(), 3_000)

const tone = computed<'ok' | 'warn' | 'bad' | 'neutral'>(() => {
  const s = link.value?.state
  if (!s) return 'neutral'
  if (link.value?.ready) return 'ok'
  if (['pairing', 'starting', 'reconnecting'].includes(s)) return 'warn'
  if (['off', 'unlinked'].includes(s)) return 'neutral'
  return 'bad'
})

async function call(path: string, label: string, body: Record<string, unknown> = {}) {
  busy.value = label
  try {
    const { data } = await api.post<{ link: LinkStatus }>(`/whatsapp/${path}`, body)
    store.set(data.link)
    if (label === 'unlink') ok(data.link.ghostDevice ? 'Keys removed, but the phone still lists the device — see the note below.' : 'Unlinked')
  } catch (e) {
    bad(errorMessage(e))
  } finally {
    busy.value = ''
  }
}
async function unlink() {
  if (!confirm('Unlink this WhatsApp account? Tracked chats and items stay; messages stop arriving until you link again.')) return
  await call('unlink', 'unlink')
}
</script>

<template>
  <div class="animate-page-in">
    <PageHeader title="WhatsApp link" subtitle="Tapis reads chats as a linked device on your own WhatsApp account, the same way WhatsApp Web does. Nothing is read from chats you have not chosen." />

    <div class="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div class="space-y-4">
        <div class="rounded-md border border-line bg-surface p-5">
          <div class="flex flex-wrap items-center gap-2">
            <BaseBadge :tone="tone">{{ link?.state.replace('-', ' ') ?? '…' }}</BaseBadge>
            <span v-if="link?.me" class="text-[13px] font-semibold text-ink">{{ link.me.name || 'Linked account' }} · +{{ link.me.id }}</span>
            <span v-if="link && link.state === 'connected' && !link.socketOpen" class="text-[11.5px] text-warn">the socket is closed while the state says connected — the watchdog will reconnect</span>
          </div>
          <p v-if="link?.action" class="mt-2 rounded border border-warn/40 bg-warn/8 px-3 py-2 text-[12.5px] text-ink">{{ link.action }}</p>
          <p v-if="link?.ghostDevice" class="mt-2 rounded border border-bad/40 bg-bad/8 px-3 py-2 text-[12.5px] text-ink">{{ link.ghostDevice }}</p>

          <dl class="mt-4 grid gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2">
            <div><dt class="eyebrow">Connected since</dt><dd class="mt-0.5">{{ link?.connectedAt ? fmtDateTime(link.connectedAt) : '—' }}</dd></div>
            <div><dt class="eyebrow">Last message from WhatsApp</dt><dd class="mt-0.5">{{ ago(link?.lastInboundAt) }}</dd></div>
            <div><dt class="eyebrow">Stored / ignored this session</dt><dd class="mt-0.5 tabular">{{ link?.inboundStored ?? 0 }} / {{ link?.inboundIgnored ?? 0 }}</dd></div>
            <div><dt class="eyebrow">Last sent</dt><dd class="mt-0.5">{{ ago(link?.lastOutboundAt) }}</dd></div>
            <div v-if="link?.lastError"><dt class="eyebrow">Last error</dt><dd class="mt-0.5 text-bad">{{ link.lastError }} <span class="text-faint">({{ ago(link.lastErrorAt) }})</span></dd></div>
            <div v-if="link?.nextRetryAt"><dt class="eyebrow">Next retry</dt><dd class="mt-0.5">{{ fmtDateTime(link.nextRetryAt) }} (attempt {{ link.attempts + 1 }})</dd></div>
          </dl>

          <div class="mt-5 flex flex-wrap gap-2">
            <BaseButton v-if="!link?.ready && link?.state !== 'pairing' && link?.state !== 'starting'" :loading="busy === 'link'" @click="call('link', 'link')"><QrCode class="h-3.5 w-3.5" /> {{ link?.hasSession ? 'Reconnect' : 'Show QR code' }}</BaseButton>
            <BaseButton v-if="link?.ready || link?.state === 'pairing' || link?.state === 'reconnecting'" variant="secondary" :loading="busy === 'stop'" @click="call('stop', 'stop')"><Square class="h-3.5 w-3.5" /> {{ link?.state === 'pairing' ? 'Cancel' : 'Pause' }}</BaseButton>
            <BaseButton v-if="link?.hasSession || link?.ready" variant="danger" :loading="busy === 'unlink'" @click="unlink"><Unlink class="h-3.5 w-3.5" /> Unlink</BaseButton>
          </div>
        </div>

        <div class="rounded-md border border-line bg-surface p-5 text-[12.5px] leading-relaxed text-muted">
          <h2 class="mb-1 text-[13px] font-bold text-ink">What happens when it is linked</h2>
          <ul class="list-disc space-y-1 pl-5">
            <li>Your groups are listed under <strong>Chats</strong> right away. Private chats appear when they next say something.</li>
            <li>Only chats you switch on are read. Messages from other chats are seen by the link and dropped immediately — nothing is written down.</li>
            <li>The account is never marked "online", so your phone keeps its notifications. Read receipts are not sent.</li>
            <li>Items sent to WhatsApp go out from this same account, to the numbers on each rule.</li>
            <li>Only one server may hold this link. Linking the same account from a second Tapis install knocks both offline.</li>
          </ul>
        </div>
      </div>

      <div class="space-y-4">
        <div class="rounded-md border border-line bg-surface p-5">
          <h2 class="text-[13px] font-bold">Scan to link</h2>
          <p class="mb-3 text-[11.5px] text-faint">On the phone: WhatsApp → Settings → Linked devices → Link a device.</p>
          <div class="flex aspect-square items-center justify-center rounded border border-line bg-tint">
            <img v-if="link?.qr" :src="link.qr" alt="WhatsApp pairing QR code" class="h-full w-full" />
            <div v-else-if="link?.pairingCode" class="text-center">
              <p class="eyebrow">Enter this code on the phone</p>
              <p class="mt-2 text-[28px] font-bold tracking-[0.2em] tabular">{{ link.pairingCode }}</p>
            </div>
            <p v-else-if="link?.state === 'pairing' || link?.state === 'starting'" class="text-[12.5px] text-muted">Generating a code…</p>
            <p v-else-if="link?.ready" class="px-6 text-center text-[12.5px] text-muted"><Smartphone class="mx-auto mb-1 h-5 w-5" />Linked. Nothing to scan.</p>
            <p v-else class="px-6 text-center text-[12.5px] text-muted">Press <strong>Show QR code</strong> to start.</p>
          </div>
          <p v-if="link?.pairingExpiresAt" class="mt-2 text-[11.5px] text-faint">Codes keep refreshing until {{ fmtDateTime(link.pairingExpiresAt) }}.</p>
        </div>

        <div v-if="!link?.ready" class="rounded-md border border-line bg-surface p-5">
          <h2 class="text-[13px] font-bold">Or pair with a code</h2>
          <p class="mb-2 text-[11.5px] text-faint">For a phone that cannot scan. Enter the account's own number.</p>
          <div class="flex gap-1.5">
            <BaseInput v-model="pair.number" placeholder="60123456789" />
            <BaseButton variant="secondary" class="self-start" :loading="busy === 'code'" :disabled="!pair.number" @click="call('pair-code', 'code', { number: pair.number })">Get code</BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
