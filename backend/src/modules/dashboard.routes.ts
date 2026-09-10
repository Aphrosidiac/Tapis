import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { baileysStatus } from '../lib/whatsapp/baileys.js'
import { schedulerStatus } from '../lib/pipeline/scheduler.js'
import { settings } from '../lib/settings.js'
import { llmConfigured } from '../lib/llm/client.js'
import { estimateCostUsd } from '../lib/llm/models.js'

export default async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/dashboard', async () => {
    const since7 = new Date(Date.now() - 7 * 86_400_000)
    const since30 = new Date(Date.now() - 30 * 86_400_000)
    const [byStatus, trackedChats, pendingMessages, dismissed7, stored7, failedBundles, pendingDeliveries, calls30, recentFailed] = await Promise.all([
      prisma.item.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.chat.count({ where: { tracked: true } }),
      prisma.message.count({ where: { filterStatus: 'PENDING' } }),
      prisma.message.count({ where: { filterStatus: 'DISMISSED', receivedAt: { gte: since7 } } }),
      prisma.message.count({ where: { receivedAt: { gte: since7 }, fromMe: false } }),
      prisma.bundle.count({ where: { status: 'FAILED' } }),
      prisma.delivery.count({ where: { status: 'PENDING' } }),
      prisma.llmCall.findMany({ where: { createdAt: { gte: since30 } }, select: { kind: true, model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, ok: true, createdAt: true } }),
      prisma.bundle.findMany({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 3, include: { chat: { select: { name: true } } } }),
    ])

    const cost = { d7: 0, d30: 0, calls7: 0, calls30: 0, filter30: 0, analyze30: 0 }
    for (const c of calls30) {
      const usd = estimateCostUsd(c.model, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens)
      cost.d30 += usd
      cost.calls30 += 1
      if (c.kind === 'FILTER') cost.filter30 += usd
      else cost.analyze30 += usd
      if (c.createdAt >= since7) {
        cost.d7 += usd
        cost.calls7 += 1
      }
    }

    const counts: Record<string, number> = { NEW: 0, IN_PROGRESS: 0, DONE: 0, DISMISSED: 0 }
    for (const s of byStatus) counts[s.status] = s._count._all

    const link = baileysStatus()
    return {
      items: counts,
      trackedChats,
      pendingMessages,
      messages7: stored7,
      dismissed7,
      failedBundles,
      pendingDeliveries,
      cost,
      link: { state: link.state, ready: link.ready, me: link.me, action: link.action, lastInboundAt: link.lastInboundAt },
      llmConfigured: llmConfigured(),
      provider: settings().provider,
      scheduler: schedulerStatus(),
      recentFailed: recentFailed.map((b) => ({ id: b.id, chat: b.chat.name, error: b.error, createdAt: b.createdAt })),
    }
  })
}
