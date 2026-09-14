import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { str, strOrNull, bool, int, strArray, waDigits, isUsableWaId } from '../lib/input.js'
import { tick } from '../lib/pipeline/scheduler.js'
import { rereadMedia } from '../lib/llm/media.js'
import { isTeam } from '../lib/team.js'
import { translateOne } from '../lib/llm/translate.js'
import { draftSetup, applySetup, suggestedChats } from '../lib/setup.js'

const RULE_FIELDS = { id: true, chatId: true, text: true, extraAsk: true, senderWaIds: true, toDashboard: true, toWhatsapp: true, active: true, createdAt: true, updatedAt: true }

function ruleBody(body: Record<string, unknown>, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) {
  const text = str(body.text)
  if (!text) return { error: reply.status(400).send({ error: 'Describe what to track, in plain language' }) }
  const toWhatsapp = strArray(body.toWhatsapp).map(waDigits)
  const bad = toWhatsapp.find((n) => !isUsableWaId(n))
  if (bad !== undefined) return { error: reply.status(400).send({ error: `"${bad}" is not a WhatsApp number. Use international digits, e.g. 60123456789` }) }
  const toDashboard = bool(body.toDashboard, true)
  if (!toDashboard && !toWhatsapp.length) return { error: reply.status(400).send({ error: 'Results must go somewhere: the dashboard, a WhatsApp number, or both' }) }
  return {
    data: {
      text: text.slice(0, 1000),
      extraAsk: strOrNull(body.extraAsk)?.slice(0, 1000) ?? null,
      senderWaIds: [...new Set(strArray(body.senderWaIds))],
      toDashboard,
      toWhatsapp: [...new Set(toWhatsapp)],
      active: bool(body.active, true),
    },
  }
}

export default async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/chats', async (request) => {
    const q = request.query as Record<string, string>
    const chats = await prisma.chat.findMany({
      where: {
        ...(q.tracked === 'true' ? { tracked: true } : q.tracked === 'false' ? { tracked: false } : {}),
        ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { clientName: { contains: q.q, mode: 'insensitive' } }, { jid: { contains: q.q } }] } : {}),
      },
      // Most recent first, full stop. Pinning tracked chats to the top put a
      // chat that last spoke 14 hours ago above one that spoke 6 minutes ago,
      // which is backwards when the list's job is "who just said something,
      // should I be reading them". The Reading tab is how you get back to the
      // tracked ones. Chats that have never spoken sort last, then by name so
      // the tail is alphabetical rather than arbitrary.
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
      // Was 500 while the account held 922 chats, so the screen said
      // "1 of 500" and 422 conversations simply did not exist as far as
      // anyone using it could tell.
      take: 2000,
      include: {
        _count: { select: { rules: { where: { active: true } }, items: { where: { status: { in: ['NEW', 'IN_PROGRESS'] } } }, messages: true } },
      },
    })
    const total = await prisma.chat.count()
    return { chats: chats.map((c) => ({ ...c, counts: c._count, _count: undefined })), total }
  })

  /// Untracked groups worth reading, ranked. Before the :id route, or the
  /// word "suggested" would be taken for an id.
  app.get('/api/chats/suggested', async () => ({ chats: await suggestedChats() }))

  /// A drafted setup for one chat: peeks at the last days on the phone
  /// (nothing stored), then a cheap model writes what the operator would
  /// have typed. `?peek=false` drafts from the name and people alone.
  app.post('/api/chats/:id/setup-draft', async (request, reply) => {
    const { id } = request.params as { id: string }
    const peek = bool((request.body as Record<string, unknown> | undefined)?.peek, true)
    try {
      return { draft: await draftSetup(id, { peek }) }
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.status(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  /// Applies a setup in one go and switches the chat on.
  app.post('/api/chats/:id/setup', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as Record<string, unknown>
    const rules = Array.isArray(b.rules) ? (b.rules as Record<string, unknown>[]).map((r) => ({ text: str(r.text), toWhatsapp: strArray(r.toWhatsapp) })) : []
    const team = Array.isArray(b.team) ? (b.team as Record<string, unknown>[]).map((t) => ({ waId: str(t.waId), name: strOrNull(t.name) })) : []
    try {
      const chat = await applySetup(id, { clientName: b.clientName === undefined ? undefined : strOrNull(b.clientName), description: b.description === undefined ? undefined : strOrNull(b.description), rules, team })
      return { chat }
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.status(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  app.get('/api/chats/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const chat = await prisma.chat.findUnique({
      where: { id },
      include: {
        rules: { orderBy: { createdAt: 'asc' }, select: RULE_FIELDS },
        participants: { orderBy: { messageCount: 'desc' }, take: 100 },
      },
    })
    if (!chat) return reply.status(404).send({ error: 'Chat not found' })
    const [pending, dismissed, flagged, attached, items, openItems] = await Promise.all([
      prisma.message.count({ where: { chatId: id, filterStatus: 'PENDING' } }),
      prisma.message.count({ where: { chatId: id, filterStatus: 'DISMISSED' } }),
      prisma.message.count({ where: { chatId: id, filterStatus: 'FLAGGED' } }),
      prisma.message.count({ where: { chatId: id, filterStatus: 'ATTACHED' } }),
      prisma.item.count({ where: { chatId: id } }),
      prisma.item.count({ where: { chatId: id, status: { in: ['NEW', 'IN_PROGRESS'] } } }),
    ])
    return {
      chat: {
        ...chat,
        participants: chat.participants.map((p) => ({ ...p, team: isTeam(p.waId) })),
        counts: { pending, dismissed, flagged, attached, items, openItems },
      },
    }
  })

  app.put('/api/chats/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as Record<string, unknown>
    const existing = await prisma.chat.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: 'Chat not found' })
    const data: Record<string, unknown> = {}
    if (body.tracked !== undefined) {
      const tracked = bool(body.tracked, existing.tracked)
      data.tracked = tracked
      if (tracked && !existing.tracked) data.trackedSince = new Date()
    }
    if (body.clientName !== undefined) data.clientName = strOrNull(body.clientName)?.slice(0, 200) ?? null
    if (body.description !== undefined) data.description = strOrNull(body.description)?.slice(0, 4000) ?? null
    if (body.name !== undefined && str(body.name)) data.name = str(body.name).slice(0, 200)
    const chat = await prisma.chat.update({ where: { id }, data })
    return { chat }
  })

  app.get('/api/chats/:id/messages', async (request) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, string>
    const page = int(q.page, 1, 1)
    const limit = int(q.limit, 50, 1, 200)
    const where = {
      chatId: id,
      ...(q.status && ['PENDING', 'DISMISSED', 'FLAGGED', 'ATTACHED', 'SKIPPED'].includes(q.status) ? { filterStatus: q.status as never } : {}),
      ...(q.q ? { text: { contains: q.q, mode: 'insensitive' as const } } : {}),
    }
    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { itemLinks: { select: { itemId: true, kind: true, item: { select: { title: true, status: true } } } } },
      }),
      prisma.message.count({ where }),
    ])
    return { messages: messages.map((m) => ({ ...m, team: isTeam(m.senderWaId) })), total, page, limit }
  })

  app.post('/api/chats/:id/rules', async (request, reply) => {
    const { id } = request.params as { id: string }
    const chat = await prisma.chat.findUnique({ where: { id }, select: { id: true } })
    if (!chat) return reply.status(404).send({ error: 'Chat not found' })
    const parsed = ruleBody((request.body ?? {}) as Record<string, unknown>, reply)
    if ('error' in parsed) return parsed.error
    const rule = await prisma.rule.create({ data: { chatId: id, ...parsed.data }, select: RULE_FIELDS })
    return { rule }
  })

  app.put('/api/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.rule.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: 'Rule not found' })
    const body = (request.body ?? {}) as Record<string, unknown>
    // A toggle alone should not need the whole rule re-sent.
    if (Object.keys(body).length === 1 && body.active !== undefined) {
      const rule = await prisma.rule.update({ where: { id }, data: { active: bool(body.active, true) }, select: RULE_FIELDS })
      return { rule }
    }
    const parsed = ruleBody(body, reply)
    if ('error' in parsed) return parsed.error
    const rule = await prisma.rule.update({ where: { id }, data: parsed.data, select: RULE_FIELDS })
    return { rule }
  })

  app.delete('/api/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.rule.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: 'Rule not found' })
    await prisma.rule.delete({ where: { id } })
    return { ok: true }
  })

  /// Transcribes or describes one message's media again — after a key was
  /// added, a model changed, or a read failed.
  app.post('/api/messages/:id/read-media', async (request) => {
    const { id } = request.params as { id: string }
    const message = await rereadMedia(id)
    return { message }
  })

  /// Renders one message's original (and reading) into the output language
  /// again — after the language setting changed, or when one was missed.
  app.post('/api/messages/:id/translate', async (request) => {
    const { id } = request.params as { id: string }
    const message = await translateOne(id)
    return { message }
  })

  /// Bundle whatever is waiting in this chat now, without waiting for quiet.
  app.post('/api/chats/:id/run', async (request) => {
    const { id } = request.params as { id: string }
    const result = await tick({ force: true, chatId: id })
    return { result }
  })
}
