import type { Bundle, Chat, Message, Rule } from '@prisma/client'
import prisma from '../prisma.js'
import type { AnalyzeAction } from '../llm/analyze.js'
import { formatNewItem, formatUpdate, queueDeliveries } from './deliver.js'
import { isTeam } from '../team.js'

/// Applies the analysis's actions. Items are created, follow-ups attached,
/// deliveries queued. Nothing here rewrites a message.

/// The fields an action's teamStatus writes on the item. `teamBy` is the
/// last sender from our side among the messages, or "us" for the phone.
function teamPatch(a: AnalyzeAction, msgs: Message[]): { teamStatus: 'IN_PROGRESS' | 'RESOLVED'; teamNote: string | null; teamBy: string | null; teamAt: Date } | Record<string, never> {
  if (a.teamStatus === 'NONE') return {}
  // The analysis judged this from our side; name whoever on our side said
  // it, else the last speaker — the model saw more context than we do.
  const ours = [...msgs].reverse().find((m) => m.fromMe || isTeam(m.senderWaId)) ?? msgs[msgs.length - 1]
  const by = ours ? (ours.fromMe ? 'us' : ours.senderName || ours.senderWaId) : null
  return { teamStatus: a.teamStatus, teamNote: a.teamNote?.trim() || null, teamBy: by, teamAt: new Date() }
}

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
        // A closed item the client is still asking about is not closed. Our
        // own side saying more about a closed item does not reopen it.
        const reopen = kind !== 'TEAM_UPDATE' && (item.status === 'DONE' || item.status === 'DISMISSED')
        // What our side said, when it said something; a client chasing an
        // item our side called resolved means it is not resolved after all.
        const team = teamPatch(a, msgs)
        const clearResolved = kind === 'STATUS_CHECK' && a.teamStatus === 'NONE' && item.teamStatus === 'RESOLVED'
        const updated = await prisma.item.update({
          where: { id: item.id },
          data: { lastActivityAt: latest, ...(reopen ? { status: 'NEW' } : {}), ...team, ...(clearResolved ? { teamStatus: 'NONE', teamNote: null, teamBy: null, teamAt: null } : {}) },
        })
        const what = kind === 'STATUS_CHECK' ? 'Status check' : kind === 'DETAIL' ? 'More detail' : kind === 'TEAM_UPDATE' ? 'Our side' : 'Follow-up'
        await prisma.itemEvent.create({
          data: {
            itemId: item.id,
            kind: 'UPDATED',
            detail: `${what}: ${a.note || `${msgs.length} message(s) attached`}${reopen ? ' — reopened' : ''}${a.teamStatus === 'RESOLVED' ? ' — our side says it is done' : a.teamStatus === 'IN_PROGRESS' ? ' — our side is on it' : ''}`,
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
        ...teamPatch(a, msgs),
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
