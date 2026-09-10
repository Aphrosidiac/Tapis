import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { str, int, waDigits, isUsableWaId } from '../lib/input.js'
import { formatNewItem } from '../lib/pipeline/deliver.js'

const STATUSES = ['NEW', 'IN_PROGRESS', 'DONE', 'DISMISSED'] as const
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

const LIST_INCLUDE = {
  chat: { select: { id: true, name: true, clientName: true, isGroup: true } },
  rules: { select: { rule: { select: { id: true, text: true } } } },
  _count: { select: { messages: true, deliveries: true } },
} as const

export default async function itemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/items', async (request) => {
    const q = request.query as Record<string, string>
    const page = int(q.page, 1, 1)
    const limit = int(q.limit, 100, 1, 500)
    const statuses = (q.status ?? '').split(',').filter((s) => (STATUSES as readonly string[]).includes(s))
    const where = {
      ...(statuses.length ? { status: { in: statuses as never[] } } : {}),
      ...(q.chatId ? { chatId: q.chatId } : {}),
      ...(q.client ? { chat: { clientName: q.client } } : {}),
      ...(q.ruleId ? { rules: { some: { ruleId: q.ruleId } } } : {}),
      ...(q.priority && (PRIORITIES as readonly string[]).includes(q.priority) ? { priority: q.priority as never } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' as const } }, { brief: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
    }
    const [items, total] = await Promise.all([
      prisma.item.findMany({ where, orderBy: { lastActivityAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: LIST_INCLUDE }),
      prisma.item.count({ where }),
    ])
    return {
      items: items.map((i) => ({ ...i, rules: i.rules.map((r) => r.rule), counts: i._count, _count: undefined })),
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
        messages: item.messages.map((l) => ({ link: { id: l.id, kind: l.kind, note: l.note }, ...l.message })),
      },
    }
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
              data: origins.map((m) => ({ chatId: existing.chatId, messageId: m.id, kind: 'FALSE_POSITIVE' as const, text: (m.text || `[${m.type.toLowerCase()}]`).slice(0, 500) })),
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
