import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { isTeam } from '../lib/team.js'
import { str, int, waDigits, isUsableWaId } from '../lib/input.js'
import { formatNewItem } from '../lib/pipeline/deliver.js'

const STATUSES = ['NEW', 'IN_PROGRESS', 'DONE', 'DISMISSED'] as const
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

const LIST_INCLUDE = {
  chat: { select: { id: true, name: true, clientName: true, isGroup: true } },
  rules: { select: { rule: { select: { id: true, text: true } } } },
  _count: { select: { messages: true, deliveries: true } },
  /// Whether the client has come back to ask whether this is done. One row
  /// is enough — the list only needs to know that it happened and when.
  messages: { where: { kind: 'STATUS_CHECK' as const }, orderBy: { createdAt: 'desc' as const }, take: 1, select: { createdAt: true } },
} as const

const OPEN = ['NEW', 'IN_PROGRESS'] as const

export default async function itemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/items', async (request) => {
    const q = request.query as Record<string, string>
    const page = int(q.page, 1, 1)
    const limit = int(q.limit, 100, 1, 500)
    const statuses = (q.status ?? '').split(',').filter((s) => (STATUSES as readonly string[]).includes(s))
    const priorities = (q.priority ?? '').split(',').filter((p) => (PRIORITIES as readonly string[]).includes(p))

    /// The three triage views. Each one answers a question an owner actually
    /// has — who is chasing me, what have I left sitting, what is on fire —
    /// and each is a filter over OPEN items, because a done item cannot need
    /// anything.
    const view = q.view
    const staleBefore = new Date(Date.now() - int(q.staleHours, 48, 1, 24 * 365) * 3_600_000)
    const viewWhere =
      view === 'chased'
        ? { status: { in: OPEN as unknown as never[] }, messages: { some: { kind: 'STATUS_CHECK' as never } } }
        : view === 'stale'
          ? { status: { in: OPEN as unknown as never[] }, lastActivityAt: { lt: staleBefore } }
          : view === 'urgent'
            ? { status: { in: OPEN as unknown as never[] }, priority: { in: ['HIGH', 'URGENT'] as never[] } }
            : view === 'ready'
              ? { status: { in: OPEN as unknown as never[] }, teamStatus: 'RESOLVED' as never }
              : {}

    const where = {
      // A view is about open work, so it wins over whichever tab was left on.
      ...(statuses.length && !view ? { status: { in: statuses as never[] } } : {}),
      ...viewWhere,
      ...(q.chatId ? { chatId: q.chatId } : {}),
      ...(q.client ? { chat: { clientName: q.client } } : {}),
      ...(q.ruleId ? { rules: { some: { ruleId: q.ruleId } } } : {}),
      ...(priorities.length && !view ? { priority: { in: priorities as never[] } } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' as const } }, { brief: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
    }

    // Stalest first when triaging by age: the point of the view is the top row.
    const orderBy = view === 'stale' ? { lastActivityAt: 'asc' as const } : { lastActivityAt: 'desc' as const }

    const [items, total] = await Promise.all([
      prisma.item.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, include: LIST_INCLUDE }),
      prisma.item.count({ where }),
    ])
    const links = await prisma.itemMessage.findMany({ where: { itemId: { in: items.map((i) => i.id) } }, select: { itemId: true, createdAt: true } })
    const linksByItem = new Map<string, Date[]>()
    for (const l of links) linksByItem.set(l.itemId, [...(linksByItem.get(l.itemId) ?? []), l.createdAt])
    return {
      items: items.map((i) => ({
        ...i,
        rules: i.rules.map((r) => r.rule),
        counts: i._count,
        chasedAt: i.messages[0]?.createdAt ?? null,
        // What happened since the operator last opened it: attached
        // messages and our side's word. Nothing until it has been opened
        // once — a never-opened item is already marked New.
        unread: i.lastViewedAt
          ? {
              messages: (linksByItem.get(i.id) ?? []).filter((t) => t > i.lastViewedAt!).length,
              team: !!i.teamAt && i.teamAt > i.lastViewedAt,
              activity: i.lastActivityAt > i.lastViewedAt,
            }
          : null,
        _count: undefined,
        messages: undefined,
      })),
      total,
      page,
      limit,
    }
  })

  app.get('/api/items/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const item = await prisma.item.findUnique({
      where: { id },
      include: {
        chat: true,
        rules: { select: { rule: true } },
        messages: { include: { message: true }, orderBy: { message: { sentAt: 'asc' } } },
        events: { orderBy: { createdAt: 'asc' } },
        deliveries: { orderBy: { createdAt: 'desc' } },
      },
    })
    if (!item) return reply.status(404).send({ error: 'Item not found' })
    return {
      item: {
        ...item,
        rules: item.rules.map((r) => r.rule),
        messages: item.messages.map((l) => ({ link: { id: l.id, kind: l.kind, note: l.note }, ...l.message, team: isTeam(l.message.senderWaId) })),
      },
    }
  })

  /// The operator opened it: everything up to now has been seen.
  app.post('/api/items/:id/viewed', async (request, reply) => {
    const { id } = request.params as { id: string }
    const item = await prisma.item.findUnique({ where: { id }, select: { id: true } })
    if (!item) return reply.status(404).send({ error: 'Item not found' })
    await prisma.item.update({ where: { id }, data: { lastViewedAt: new Date() } })
    return { ok: true }
  })

  app.put('/api/items/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as Record<string, unknown>
    const existing = await prisma.item.findUnique({ where: { id }, include: { messages: { select: { messageId: true, kind: true } } } })
    if (!existing) return reply.status(404).send({ error: 'Item not found' })

    const data: Record<string, unknown> = {}
    const events: { kind: 'STATUS' | 'NOTE'; detail: string }[] = []
    if (body.status !== undefined) {
      const s = str(body.status)
      if (!(STATUSES as readonly string[]).includes(s)) return reply.status(400).send({ error: 'Unknown status' })
      if (s !== existing.status) {
        data.status = s
        events.push({ kind: 'STATUS', detail: `${request.user.name} moved it from ${existing.status.replace('_', ' ').toLowerCase()} to ${s.replace('_', ' ').toLowerCase()}` })
        // Dismissing an item teaches the filter what noise looks like here.
        if (s === 'DISMISSED') {
          const origins = await prisma.message.findMany({ where: { id: { in: existing.messages.filter((m) => m.kind === 'ORIGIN').map((m) => m.messageId) } } })
          if (origins.length) {
            await prisma.feedback.createMany({
              data: origins.map((m) => ({ chatId: existing.chatId, messageId: m.id, kind: 'FALSE_POSITIVE' as const, text: (m.text || (m.mediaTextStatus === 'DONE' && m.mediaText) || `[${m.type.toLowerCase()}]`).slice(0, 500) })),
            })
          }
        }
      }
    }
    if (body.priority !== undefined) {
      const p = str(body.priority)
      if (!(PRIORITIES as readonly string[]).includes(p)) return reply.status(400).send({ error: 'Unknown priority' })
      if (p !== existing.priority) {
        data.priority = p
        events.push({ kind: 'STATUS', detail: `${request.user.name} set priority to ${p.toLowerCase()}` })
      }
    }
    if (body.title !== undefined && str(body.title)) data.title = str(body.title).slice(0, 200)
    // A status the operator chose answers whatever our side suggested;
    // "keep open" answers it too, without moving anything.
    if (data.status !== undefined || body.clearTeamStatus === true) Object.assign(data, { teamStatus: 'NONE', teamNote: null, teamBy: null, teamAt: null })
    if (body.note !== undefined && str(body.note)) events.push({ kind: 'NOTE', detail: `${request.user.name}: ${str(body.note).slice(0, 2000)}` })

    const item = await prisma.item.update({
      where: { id },
      data: { ...data, events: { create: events } },
    })
    return { item }
  })

  /// Sends the item to a WhatsApp number now, whatever the rules say.
  app.post('/api/items/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string }
    const to = waDigits((request.body as Record<string, unknown> | undefined)?.to)
    if (!isUsableWaId(to)) return reply.status(400).send({ error: 'Enter the WhatsApp number in international form, e.g. 60123456789' })
    const item = await prisma.item.findUnique({
      where: { id },
      include: { chat: true, rules: { select: { rule: true } }, messages: { include: { message: true }, orderBy: { message: { sentAt: 'asc' } } } },
    })
    if (!item) return reply.status(404).send({ error: 'Item not found' })
    const body = formatNewItem(item, item.chat, item.rules.map((r) => r.rule), item.messages.map((l) => l.message))
    const delivery = await prisma.delivery.create({ data: { itemId: id, toWaId: to, body } })
    return { delivery }
  })
}
