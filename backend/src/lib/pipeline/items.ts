import type { Bundle, Chat, Message, Rule } from '@prisma/client'
import prisma from '../prisma.js'
import type { AnalyzeAction } from '../llm/analyze.js'
import { formatNewItem, formatUpdate, queueDeliveries } from './deliver.js'

/// Applies the analysis's actions. Items are created, follow-ups attached,
/// deliveries queued. Nothing here rewrites a message.

export interface ApplyResult {
  created: number
  updated: number
  ignored: number
}

export async function applyActions(
  bundle: Pick<Bundle, 'id'>,
  chat: Chat,
  rules: Rule[],
  flagged: Message[],
  actions: AnalyzeAction[],
): Promise<ApplyResult> {
  const byId = new Map(flagged.map((m) => [m.id, m]))
  const ruleById = new Map(rules.map((r) => [r.id, r]))
  const covered = new Set<string>()
  const result: ApplyResult = { created: 0, updated: 0, ignored: 0 }

  for (const a of actions) {
    const msgs = a.messageIds.map((id) => byId.get(id)).filter((m): m is Message => !!m && !covered.has(m.id))
    if (!msgs.length) continue
    msgs.forEach((m) => covered.add(m.id))

    if (a.kind === 'ignore') {
      await prisma.message.updateMany({
        where: { id: { in: msgs.map((m) => m.id) } },
        data: { filterStatus: 'DISMISSED', filterReason: `Analysis: ${a.note || 'not actionable'}`.slice(0, 300) },
      })
      result.ignored += msgs.length
      continue
    }

    if (a.kind === 'attach' && a.itemId) {
      const item = await prisma.item.findUnique({ where: { id: a.itemId }, include: { rules: true } })
      if (item && item.chatId === chat.id) {
        const kind = a.attachKind === 'NONE' ? 'FOLLOW_UP' : a.attachKind
        for (const m of msgs) {
          await prisma.itemMessage.upsert({
            where: { itemId_messageId: { itemId: item.id, messageId: m.id } },
            create: { itemId: item.id, messageId: m.id, kind, note: a.note || null },
            update: { kind, note: a.note || null },
          })
        }
        const latest = msgs.reduce((d, m) => (m.sentAt > d ? m.sentAt : d), item.lastActivityAt)
        // A closed item the client is still asking about is not closed.
        const reopen = item.status === 'DONE' || item.status === 'DISMISSED'
        const updated = await prisma.item.update({
          where: { id: item.id },
          data: { lastActivityAt: latest, ...(reopen ? { status: 'NEW' } : {}) },
        })
        await prisma.itemEvent.create({
          data: {
            itemId: item.id,
            kind: 'UPDATED',
            detail: `${kind === 'STATUS_CHECK' ? 'Status check' : kind === 'DETAIL' ? 'More detail' : 'Follow-up'}: ${a.note || `${msgs.length} message(s) attached`}${reopen ? ' — reopened' : ''}`,
          },
        })
        await prisma.message.updateMany({ where: { id: { in: msgs.map((m) => m.id) } }, data: { filterStatus: 'ATTACHED' } })
        const itemRules = item.rules.map((r) => ruleById.get(r.ruleId)).filter((r): r is Rule => !!r)
        await queueDeliveries(updated, itemRules, formatUpdate(updated, chat, a.note || 'A new message about this item arrived.', kind, msgs))
        result.updated += 1
        continue
      }
      // The item the model named is gone or belongs elsewhere: fall through
      // and create rather than lose the messages.
    }

    const matched = a.ruleIds.map((id) => ruleById.get(id)).filter((r): r is Rule => !!r)
    const first = msgs.reduce((d, m) => (m.sentAt < d ? m.sentAt : d), msgs[0].sentAt)
    const last = msgs.reduce((d, m) => (m.sentAt > d ? m.sentAt : d), msgs[0].sentAt)
    const extra = a.extra.filter((e) => e.label && e.value).slice(0, 20)
    const item = await prisma.item.create({
      data: {
        chatId: chat.id,
        title: (a.title || msgs[0].text || 'Untitled item').slice(0, 200),
        brief: a.brief || '(no brief produced)',
        suggestion: a.suggestion || '',
        extra,
        priority: a.priority,
        firstMessageAt: first,
        lastActivityAt: last,
        rules: { create: matched.map((r) => ({ ruleId: r.id })) },
        messages: { create: msgs.map((m) => ({ messageId: m.id, kind: 'ORIGIN' as const })) },
        events: { create: [{ kind: 'CREATED', detail: `Created from ${msgs.length} message(s) in bundle ${bundle.id.slice(0, 8)}` }] },
      },
    })
    await prisma.message.updateMany({ where: { id: { in: msgs.map((m) => m.id) } }, data: { filterStatus: 'ATTACHED' } })
    await queueDeliveries(item, matched, formatNewItem(item, chat, matched, msgs))
    result.created += 1
  }

  // Flagged but never mentioned by the analysis: dismissed, visibly.
  const leftover = flagged.filter((m) => !covered.has(m.id))
  if (leftover.length) {
    await prisma.message.updateMany({
      where: { id: { in: leftover.map((m) => m.id) } },
      data: { filterStatus: 'DISMISSED', filterReason: 'Analysis: passed the filter but no actionable content was found' },
    })
    result.ignored += leftover.length
  }
  return result
}
