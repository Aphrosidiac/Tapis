import type { Chat, Item, Message, Rule } from '@prisma/client'
import prisma from '../prisma.js'
import { baileysReady, sendText } from '../whatsapp/baileys.js'
import { formatTime, senderLabel, messageBody } from '../llm/prompts.js'

/// WhatsApp delivery of items. Rows are queued by the pipeline and sent by
/// the scheduler; a send that fails is a FAILED row with its reason, never a
/// message the operator believes went out.

const MAX_ATTEMPTS = 5

function quoteLines(messages: Message[], limit = 4): string {
  return messages
    .slice(0, limit)
    .map((m) => `– ${senderLabel(m).replace(/ \(.*\)$/, '')} (${formatTime(m.sentAt).slice(11)}): "${messageBody(m).slice(0, 220)}"`)
    .join('\n')
}

export function formatNewItem(item: Item, chat: Chat, rules: Rule[], messages: Message[]): string {
  const lines = [
    `*New item — ${chat.clientName ? `${chat.clientName} · ` : ''}${chat.name}*`,
    `*${item.title}*`,
    item.priority !== 'NORMAL' ? `Priority: ${item.priority}` : '',
    rules.length ? `Rule: ${rules.map((r) => r.text).join(' / ')}` : '',
    '',
    item.brief,
    '',
    `_Suggested next steps_`,
    item.suggestion,
  ]
  const extra = (item.extra as { label: string; value: string }[]) ?? []
  if (extra.length) {
    lines.push('', ...extra.map((e) => `${e.label}: ${e.value}`))
  }
  if (messages.length) {
    lines.push('', `_They said_`, quoteLines(messages))
    if (messages.length > 4) lines.push(`… and ${messages.length - 4} more on the dashboard`)
  }
  return lines.filter((l) => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function formatUpdate(item: Item, chat: Chat, note: string, kind: string, messages: Message[]): string {
  const what = kind === 'STATUS_CHECK' ? 'Status check' : kind === 'DETAIL' ? 'More detail' : kind === 'TEAM_UPDATE' ? 'Update from our side' : 'Follow-up'
  const lines = [
    `*${what} — ${chat.clientName ? `${chat.clientName} · ` : ''}${chat.name}*`,
    `*${item.title}* (${item.status.replace('_', ' ').toLowerCase()})`,
    '',
    note,
  ]
  if (messages.length) lines.push('', `_They said_`, quoteLines(messages))
  return lines.join('\n').trim()
}

/// Queues one delivery per distinct number across the rules that matched.
export async function queueDeliveries(item: Item, rules: Rule[], body: string) {
  const targets = new Map<string, string | null>()
  for (const r of rules) for (const n of r.toWhatsapp) if (!targets.has(n)) targets.set(n, r.id)
  if (!targets.size) return 0
  await prisma.delivery.createMany({
    data: [...targets].map(([toWaId, ruleId]) => ({ itemId: item.id, ruleId, toWaId, body })),
  })
  return targets.size
}

export async function sendPendingDeliveries(log: (m: string, e?: unknown) => void): Promise<number> {
  if (!baileysReady()) return 0
  const pending = await prisma.delivery.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  let sent = 0
  for (const d of pending) {
    try {
      const waMessageId = await sendText(d.toWaId, d.body)
      await prisma.delivery.update({
        where: { id: d.id },
        data: { status: 'SENT', sentAt: new Date(), waMessageId, attempts: { increment: 1 }, error: null },
      })
      await prisma.itemEvent.create({ data: { itemId: d.itemId, kind: 'DELIVERED', detail: `Sent to WhatsApp +${d.toWaId}` } })
      sent += 1
      // A burst of sends from a linked device reads as spam. Space them.
      await new Promise((r) => setTimeout(r, 400))
    } catch (err) {
      const attempts = d.attempts + 1
      const message = err instanceof Error ? err.message : String(err)
      const failed = attempts >= MAX_ATTEMPTS
      await prisma.delivery.update({
        where: { id: d.id },
        data: { attempts, error: message.slice(0, 500), status: failed ? 'FAILED' : 'PENDING' },
      })
      if (failed) {
        await prisma.itemEvent.create({ data: { itemId: d.itemId, kind: 'DELIVERY_FAILED', detail: `Could not send to +${d.toWaId}: ${message.slice(0, 200)}` } })
      }
      log(`delivery ${d.id} to ${d.toWaId} failed (attempt ${attempts})`, err)
      // One failure usually means the link is down; the rest can wait a tick.
      break
    }
  }
  return sent
}
