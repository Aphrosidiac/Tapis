import prisma from '../prisma.js'
import { settings } from '../settings.js'
import { llmConfigured } from '../llm/client.js'
import { runFilter } from '../llm/filter.js'
import { runAnalysis } from '../llm/analyze.js'
import { understandMedia } from '../llm/media.js'
import { translateBatch } from '../llm/translate.js'
import { applyActions } from './items.js'

/// Bundling and the two passes.
///
/// A bundle is cut per chat when the chat has been quiet for a while, when
/// enough messages are waiting, or when the oldest has waited too long.
/// Messages are then judged as a batch — the neighbours are what make "dah
/// siap ke?" legible.

export type CutTrigger = 'quiet' | 'size' | 'age' | 'manual' | 'rescue'

let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(`[pipeline] ${m}`, e ?? '')
export function setPipelineLogger(fn: typeof logLine) {
  logLine = fn
}

export async function cutBundles(opts: { force?: boolean; chatId?: string } = {}): Promise<string[]> {
  const s = settings()
  const now = Date.now()
  const groups = await prisma.message.groupBy({
    by: ['chatId'],
    where: { filterStatus: 'PENDING', bundleId: null, ...(opts.chatId ? { chatId: opts.chatId } : {}) },
    _count: { _all: true },
    _min: { receivedAt: true },
    _max: { receivedAt: true },
  })

  const cut: string[] = []
  for (const g of groups) {
    const count = g._count._all
    const oldest = g._min.receivedAt?.getTime() ?? now
    const newest = g._max.receivedAt?.getTime() ?? now
    let trigger: CutTrigger | null = null
    if (opts.force) trigger = 'manual'
    else if (count >= s.bundleMaxMessages) trigger = 'size'
    else if (now - newest >= s.bundleQuietSeconds * 1000) trigger = 'quiet'
    else if (now - oldest >= s.bundleMaxWaitSeconds * 1000) trigger = 'age'
    if (!trigger) continue

    const chat = await prisma.chat.findUnique({ where: { id: g.chatId }, select: { tracked: true } })
    if (!chat?.tracked) continue

    const id = await prisma.$transaction(async (tx) => {
      const bundle = await tx.bundle.create({ data: { chatId: g.chatId, trigger, status: 'FILTERING' } })
      const assigned = await tx.message.updateMany({
        where: { chatId: g.chatId, filterStatus: 'PENDING', bundleId: null },
        data: { bundleId: bundle.id },
      })
      await tx.bundle.update({ where: { id: bundle.id }, data: { messageCount: assigned.count } })
      return bundle.id
    })
    cut.push(id)
  }
  return cut
}

async function participantNames(chatId: string): Promise<Map<string, string | null>> {
  const rows = await prisma.participant.findMany({ where: { chatId }, select: { waId: true, name: true } })
  return new Map(rows.map((r) => [r.waId, r.name]))
}

export async function processBundle(bundleId: string): Promise<void> {
  const bundle = await prisma.bundle.findUnique({
    where: { id: bundleId },
    include: { chat: true, messages: { orderBy: { sentAt: 'asc' } } },
  })
  if (!bundle) return
  if (bundle.status === 'DONE') return

  const s = settings()
  const chat = bundle.chat
  const batch = bundle.messages.filter((m) => m.filterStatus === 'PENDING' || m.filterStatus === 'FLAGGED')
  const finish = async (data: Record<string, unknown>) =>
    prisma.bundle.update({ where: { id: bundleId }, data: { ...data, completedAt: new Date() } })

  if (!batch.length) {
    await finish({ status: 'DONE' })
    return
  }

  if (!llmConfigured()) {
    // Leave the messages PENDING-in-bundle so they are processed once a key
    // is added — but say so, loudly, where the operator will look.
    await prisma.bundle.update({ where: { id: bundleId }, data: { status: 'FAILED', error: 'No Anthropic API key is configured. Add one on the Settings screen; these messages will be processed when it is.' } })
    return
  }

  const rules = await prisma.rule.findMany({ where: { chatId: chat.id, active: true }, orderBy: { createdAt: 'asc' } })
  if (!rules.length) {
    await prisma.message.updateMany({
      where: { id: { in: batch.map((m) => m.id) } },
      data: { filterStatus: 'DISMISSED', filterReason: 'No active tracking rules for this chat' },
    })
    await finish({ status: 'DONE', flaggedCount: 0 })
    return
  }

  const participants = await participantNames(chat.id)
  const context = (
    await prisma.message.findMany({
      where: { chatId: chat.id, sentAt: { lt: batch[0].sentAt }, id: { notIn: batch.map((m) => m.id) } },
      orderBy: { sentAt: 'desc' },
      take: s.contextMessages,
    })
  ).reverse()
  const feedback = await prisma.feedback.findMany({ where: { chatId: chat.id }, orderBy: { createdAt: 'desc' }, take: 12 })

  // ── Read the media ──
  // Voice notes and images are read before anyone judges them, so the
  // filter sees words rather than "[voice note]". A read that fails is a
  // note on that message, not a failed bundle.
  const media = await understandMedia(chat, batch)
  if (media.read || media.failed) {
    logLine(`bundle ${bundleId.slice(0, 8)}: read ${media.read} media, ${media.failed} failed`)
    const fresh = await prisma.message.findMany({ where: { id: { in: batch.map((m) => m.id) } } })
    for (const m of batch) {
      const f = fresh.find((x) => x.id === m.id)
      if (f) Object.assign(m, { mediaText: f.mediaText, mediaTextStatus: f.mediaTextStatus, mediaTextError: f.mediaTextError, mediaTextModel: f.mediaTextModel })
    }
  }

  // For the reader, not the models: Chinese originals get a rendering in
  // the output language beside them. Cheap, one call, never blocking.
  const translated = await translateBatch(chat, batch)
  if (translated) logLine(`bundle ${bundleId.slice(0, 8)}: translated ${translated} message(s)`)

  // ── First pass ──
  let flaggedIds: string[]
  try {
    const pending = batch.filter((m) => m.filterStatus === 'PENDING')
    if (pending.length) {
      const decisions = await runFilter({ chat, rules, participants, context, batch: pending, feedback, bundleId })
      for (const m of pending) {
        const d = decisions.get(m.id)!
        await prisma.message.update({
          where: { id: m.id },
          data: { filterStatus: d.flag ? 'FLAGGED' : 'DISMISSED', filterReason: d.reason, filterRuleIds: d.ruleIds },
        })
      }
    }
    flaggedIds = (
      await prisma.message.findMany({ where: { bundleId, filterStatus: 'FLAGGED' }, select: { id: true } })
    ).map((m) => m.id)
    await prisma.bundle.update({ where: { id: bundleId }, data: { status: 'ANALYZING', flaggedCount: flaggedIds.length } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logLine(`filter failed for bundle ${bundleId}`, err)
    await prisma.bundle.update({ where: { id: bundleId }, data: { status: 'FAILED', error: `Filter: ${message}`.slice(0, 1000) } })
    return
  }

  if (!flaggedIds.length) {
    await finish({ status: 'DONE' })
    return
  }

  // ── Second pass ──
  try {
    const flagged = await prisma.message.findMany({ where: { id: { in: flaggedIds } }, orderBy: { sentAt: 'asc' } })
    const openItems = await prisma.item.findMany({
      where: { chatId: chat.id, status: { in: ['NEW', 'IN_PROGRESS', 'DONE'] } },
      orderBy: { lastActivityAt: 'desc' },
      take: 40,
      include: { rules: { select: { ruleId: true } } },
    })
    const analysis = await runAnalysis({
      chat,
      rules,
      participants,
      openItems: openItems.map((i) => ({ id: i.id, title: i.title, brief: i.brief, status: i.status, lastActivityAt: i.lastActivityAt, ruleIds: i.rules.map((r) => r.ruleId) })),
      flagged,
      context,
      bundleId,
    })
    const applied = await applyActions(bundle, chat, rules, flagged, analysis.actions)
    await finish({ status: 'DONE', itemsCreated: applied.created, itemsUpdated: applied.updated })
    logLine(`bundle ${bundleId.slice(0, 8)} for "${chat.name}": ${batch.length} msgs, ${flaggedIds.length} flagged, ${applied.created} created, ${applied.updated} updated`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logLine(`analysis failed for bundle ${bundleId}`, err)
    await prisma.bundle.update({ where: { id: bundleId }, data: { status: 'FAILED', error: `Analysis: ${message}`.slice(0, 1000) } })
  }
}

/// Re-runs a failed bundle. Messages already FLAGGED skip the filter.
export async function retryBundle(bundleId: string) {
  await prisma.bundle.update({ where: { id: bundleId }, data: { status: 'FILTERING', error: null, completedAt: null } })
  await processBundle(bundleId)
}

/// The operator rescued a dismissed message: it goes straight to analysis in
/// a bundle of its own, and the correction is remembered as an example.
export async function rescueMessage(messageId: string): Promise<string> {
  const m = await prisma.message.findUnique({ where: { id: messageId } })
  if (!m) throw Object.assign(new Error('Message not found'), { statusCode: 404 })
  if (m.filterStatus === 'ATTACHED') throw Object.assign(new Error('This message is already part of an item'), { statusCode: 400 })

  const bundle = await prisma.bundle.create({ data: { chatId: m.chatId, trigger: 'rescue', status: 'FILTERING', messageCount: 1 } })
  await prisma.message.update({
    where: { id: m.id },
    data: { bundleId: bundle.id, filterStatus: 'FLAGGED', filterReason: 'Rescued by the operator', rescuedAt: new Date() },
  })
  await prisma.feedback.create({
    data: { chatId: m.chatId, messageId: m.id, kind: 'RESCUED', text: (m.text || (m.mediaTextStatus === 'DONE' && m.mediaText) || `[${m.type.toLowerCase()}]`).slice(0, 500) },
  })
  await processBundle(bundle.id)
  return bundle.id
}
