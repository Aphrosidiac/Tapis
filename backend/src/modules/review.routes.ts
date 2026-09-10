import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { int } from '../lib/input.js'
import { rescueMessage, retryBundle } from '../lib/pipeline/bundle.js'

/// What the filter threw away, and the means to disagree with it.
export default async function reviewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/review/dismissed', async (request) => {
    const q = request.query as Record<string, string>
    const page = int(q.page, 1, 1)
    const limit = int(q.limit, 50, 1, 200)
    const where = {
      filterStatus: 'DISMISSED' as const,
      ...(q.chatId ? { chatId: q.chatId } : {}),
      ...(q.q ? { text: { contains: q.q, mode: 'insensitive' as const } } : {}),
    }
    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { chat: { select: { id: true, name: true, clientName: true } } },
      }),
      prisma.message.count({ where }),
    ])
    return { messages, total, page, limit }
  })

  app.post('/api/review/rescue/:messageId', async (request, reply) => {
    const { messageId } = request.params as { messageId: string }
    try {
      const bundleId = await rescueMessage(messageId)
      const bundle = await prisma.bundle.findUnique({ where: { id: bundleId } })
      const message = await prisma.message.findUnique({ where: { id: messageId }, include: { itemLinks: { select: { itemId: true } } } })
      return { bundle, message }
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.status(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  app.get('/api/review/bundles', async (request) => {
    const q = request.query as Record<string, string>
    const bundles = await prisma.bundle.findMany({
      where: { ...(q.chatId ? { chatId: q.chatId } : {}), ...(q.status ? { status: q.status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: int(q.limit, 50, 1, 200),
      include: { chat: { select: { id: true, name: true, clientName: true } }, llmCalls: { select: { kind: true, model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, latencyMs: true, ok: true } } },
    })
    return { bundles }
  })

  app.post('/api/review/bundles/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string }
    const bundle = await prisma.bundle.findUnique({ where: { id } })
    if (!bundle) return reply.status(404).send({ error: 'Bundle not found' })
    await retryBundle(id)
    return { bundle: await prisma.bundle.findUnique({ where: { id } }) }
  })

  app.get('/api/review/feedback', async (request) => {
    const q = request.query as Record<string, string>
    const feedback = await prisma.feedback.findMany({
      where: q.chatId ? { chatId: q.chatId } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { chat: { select: { id: true, name: true } } },
    })
    return { feedback }
  })

  app.delete('/api/review/feedback/:id', async (request) => {
    const { id } = request.params as { id: string }
    await prisma.feedback.deleteMany({ where: { id } })
    return { ok: true }
  })
}
