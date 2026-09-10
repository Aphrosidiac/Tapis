<script setup lang="ts">
import { computed, ref, reactive } from 'vue'
import { api, errorMessage } from '../lib/api'
import { useToast } from '../composables/useToast'
import { usePolling } from '../composables/usePolling'
import { useLinkStore, type LinkStatus } from '../stores/link'
import { fmtDateTime, ago } from '../lib/format'
import PageHeader from '../components/base/PageHeader.vue'
import Card from '../components/base/Card.vue'
import Alert from '../components/base/Alert.vue'
import BaseButton from '../components/base/BaseButton.vue'
import BaseBadge from '../components/base/BaseBadge.vue'
import BaseInput from '../components/base/BaseInput.vue'
import { QrCode, Smartphone, Unlink, Square } from 'lucide-vue-next'

const { ok, bad } = useToast()
const store = useLinkStore()
const link = computed(() => store.link)
const busy = ref('')
const pair = reactive({ number: '' })

// Fast while pairing: WhatsApp rotates the QR about every 20s and a stale one
// is worse than none — it looks scannable and does nothing.
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
    if (label === 'unlink') ok(data.link.ghostDevice ? 'Keys removed, but the phone still lists the device — see the note.' : 'Unlinked')
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
  <div class="rise">
    <PageHeader
      title="WhatsApp link"
      subtitle="Tapis reads chats as a linked device on your own WhatsApp account, the same way WhatsApp Web does. Nothing is read from chats you have not chosen."
    />

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div class="space-y-6">
        <div class="card p-6">
          <div class="flex flex-wrap items-center gap-3">
            <BaseBadge :tone="tone">{{ link?.state.replace('-', ' ') ?? '…' }}</BaseBadge>
            <span v-if="link?.me" class="text-[15px] font-medium leading-[22px] text-ink-900">
              {{ link.me.name || 'Linked account' }} <span class="num text-ink-500">+{{ link.me.id }}</span>
            </span>
          </div>

          <p v-if="link && link.state === 'connected' && !link.socketOpen" class="mt-3 text-[13px] leading-[18px] text-warning-600">
            The socket is closed while the state says connected — the watchdog will force a reconnect.
          </p>

          <div v-if="link?.action || link?.ghostDevice" class="mt-4 space-y-3">
            <Alert v-if="link?.ghostDevice" tone="danger" title="A device was left on the phone">{{ link.ghostDevice }}</Alert>
            <Alert v-else-if="link?.action" tone="warning" title="Needs you">{{ link.action }}</Alert>
          </div>

          <dl class="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <dt class="eyebrow">Connected since</dt>
              <dd class="mt-1 text-[14px] leading-5">{{ link?.connectedAt ? fmtDateTime(link.connectedAt) : '—' }}</dd>
            </div>
            <div>
              <dt class="eyebrow">Last message from WhatsApp</dt>
              <dd class="mt-1 text-[14px] leading-5">{{ ago(link?.lastInboundAt) }}</dd>
            </div>
            <div>
              <dt class="eyebrow">Stored / ignored this session</dt>
              <dd class="num mt-1 text-[14px] leading-5">{{ link?.inboundStored ?? 0 }} / {{ link?.inboundIgnored ?? 0 }}</dd>
            </div>
            <div>
              <dt class="eyebrow">Last sent</dt>
              <dd class="mt-1 text-[14px] leading-5">{{ ago(link?.lastOutboundAt) }}</dd>
            </div>
            <div v-if="link?.lastError" class="sm:col-span-2">
              <dt class="eyebrow">Last error</dt>
              <dd class="mt-1 text-[14px] leading-5 text-danger-600">{{ link.lastError }} <span class="text-ink-500">({{ ago(link.lastErrorAt) }})</span></dd>
            </div>
            <div v-if="link?.nextRetryAt">
              <dt class="eyebrow">Next retry</dt>
              <dd class="mt-1 text-[14px] leading-5">{{ fmtDateTime(link.nextRetryAt) }} (attempt {{ link.attempts + 1 }})</dd>
            </div>
          </dl>

          <div class="mt-6 flex flex-wrap gap-2">
            <BaseButton
              v-if="!link?.ready && link?.state !== 'pairing' && link?.state !== 'starting'"
              variant="primary"
              :loading="busy === 'link'"
              @click="call('link', 'link')"
            >
              <QrCode class="size-4" :stroke-width="1.5" /> {{ link?.hasSession ? 'Reconnect' : 'Show QR code' }}
            </BaseButton>
            <BaseButton
              v-if="link?.ready || link?.state === 'pairing' || link?.state === 'reconnecting'"
              variant="secondary"
              :loading="busy === 'stop'"
              @click="call('stop', 'stop')"
            >
              <Square class="size-4" :stroke-width="1.5" /> {{ link?.state === 'pairing' ? 'Cancel' : 'Pause' }}
            </BaseButton>
            <BaseButton v-if="link?.hasSession || link?.ready" variant="danger-ghost" :loading="busy === 'unlink'" @click="unlink">
              <Unlink class="size-4" :stroke-width="1.5" /> Unlink
            </BaseButton>
          </div>
        </div>

        <Card title="What happens when it is linked">
          <ul class="list-disc space-y-2 pl-5 text-[14px] leading-5 text-ink-600">
            <li>Your groups are listed under <strong class="font-medium text-ink-800">Chats</strong> right away. Private chats appear when they next say something.</li>
            <li>Only chats you switch on are read. Messages from other chats are seen by the link and dropped immediately — nothing is written down.</li>
            <li>The account is never marked "online", so your phone keeps its notifications. Read receipts are not sent.</li>
            <li>Items sent to WhatsApp go out from this same account, to the numbers on each rule.</li>
            <li>Only one server may hold this link. Linking the same account from a second Tapis install knocks both offline.</li>
          </ul>
        </Card>
      </div>

      <div class="space-y-6">
        <Card title="Scan to link" sub="On the phone: WhatsApp → Settings → Linked devices → Link a device.">
          <div class="grid aspect-square place-items-center rounded-md border border-line-200 bg-surface-50 p-3">
            <img v-if="link?.qr" :src="link.qr" alt="WhatsApp pairing QR code" class="size-full rounded-sm" />
            <div v-else-if="link?.pairingCode" class="text-center">
              <p class="eyebrow">Enter this code on the phone</p>
              <p class="num mt-3 text-[30px] font-semibold tracking-[0.18em]">{{ link.pairingCode }}</p>
            </div>
            <p v-else-if="link?.state === 'pairing' || link?.state === 'starting'" class="text-[14px] leading-5 text-ink-500">Generating a code…</p>
            <div v-else-if="link?.ready" class="px-6 text-center text-[14px] leading-5 text-ink-500">
              <Smartphone class="mx-auto mb-2 size-6 text-ink-400" :stroke-width="1.5" />
              Linked. Nothing to scan.
            </div>
            <p v-else class="px-6 text-center text-[14px] leading-5 text-ink-500">Press <strong class="font-medium text-ink-800">Show QR code</strong> to start.</p>
          </div>
          <p v-if="link?.pairingExpiresAt" class="mt-3 text-[13px] leading-[18px] text-ink-500">
            Codes keep refreshing until {{ fmtDateTime(link.pairingExpiresAt) }}.
          </p>
        </Card>

        <Card v-if="!link?.ready" title="Or pair with a code" sub="For a phone that cannot scan. Enter the account's own number.">
          <div class="flex items-end gap-2">
            <div class="min-w-0 flex-1"><BaseInput v-model="pair.number" placeholder="60123456789" /></div>
            <BaseButton variant="secondary" :loading="busy === 'code'" :disabled="!pair.number" @click="call('pair-code', 'code', { number: pair.number })">
              Get code
            </BaseButton>
          </div>
        </Card>
      </div>
    </div>
  </div>
</template>
