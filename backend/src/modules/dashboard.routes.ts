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
    const OPEN = { in: ['NEW', 'IN_PROGRESS'] as never[] }
    // 48 hours: a client who asked on Monday and hears nothing by Wednesday
    // has been ignored, whatever the ticket says.
    const staleBefore = new Date(Date.now() - 48 * 3_600_000)
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

    /// Triage. Three questions an owner actually has, each one a filter you
    /// can click, rather than six numbers about the machine.
    const [chasedItems, staleItems, urgentItems, readyItems] = await Promise.all([
      // Someone came back to ask whether it is done yet. The single highest
      // signal event in the product: the client is already unhappy enough to
      // chase, and we still have it open.
      prisma.item.findMany({
        where: { status: OPEN, messages: { some: { kind: 'STATUS_CHECK' } } },
        orderBy: { lastActivityAt: 'desc' },
        select: { id: true, title: true, lastActivityAt: true, chat: { select: { name: true, clientName: true } } },
        take: 50,
      }),
      prisma.item.findMany({
        where: { status: OPEN, lastActivityAt: { lt: staleBefore } },
        orderBy: { lastActivityAt: 'asc' },
        select: { id: true, title: true, lastActivityAt: true, chat: { select: { name: true, clientName: true } } },
        take: 50,
      }),
      prisma.item.findMany({
        where: { status: OPEN, priority: { in: ['HIGH', 'URGENT'] } },
        orderBy: [{ priority: 'desc' }, { lastActivityAt: 'desc' }],
        select: { id: true, title: true, priority: true, chat: { select: { name: true, clientName: true } } },
        take: 50,
      }),
      // Our own side said it is done and the item is still open: the one
      // kind of open item that costs nothing but a click.
      prisma.item.findMany({
        where: { status: OPEN, teamStatus: 'RESOLVED' },
        orderBy: { teamAt: 'desc' },
        select: { id: true, title: true, teamBy: true, chat: { select: { name: true, clientName: true } } },
        take: 50,
      }),
    ])

    const who = (rows: { chat: { name: string; clientName: string | null } }[]) => [
      ...new Set(rows.map((r) => r.chat.clientName || r.chat.name)),
    ]

    const triage = {
      chased: {
        count: chasedItems.length,
        clients: who(chasedItems).slice(0, 3),
        moreClients: Math.max(0, who(chasedItems).length - 3),
      },
      stale: {
        count: staleItems.length,
        clients: who(staleItems).slice(0, 3),
        moreClients: Math.max(0, who(staleItems).length - 3),
        // The age of the worst one, which is the number that shames you.
        oldestHours: staleItems.length ? Math.floor((Date.now() - staleItems[0].lastActivityAt.getTime()) / 3_600_000) : 0,
      },
      urgent: {
        count: urgentItems.length,
        urgentCount: urgentItems.filter((i) => i.priority === 'URGENT').length,
        clients: who(urgentItems).slice(0, 3),
        moreClients: Math.max(0, who(urgentItems).length - 3),
      },
      ready: {
        count: readyItems.length,
        clients: who(readyItems).slice(0, 3),
        moreClients: Math.max(0, who(readyItems).length - 3),
        by: [...new Set(readyItems.map((i) => i.teamBy).filter(Boolean))].slice(0, 2) as string[],
      },
    }

    const link = baileysStatus()
    // The first-run checklist: five things that make the product work, in
    // order. Shown on the dashboard until all are done.
    const [teamCount, chatsWithRules] = await Promise.all([prisma.teamMember.count(), prisma.chat.count({ where: { tracked: true, rules: { some: { active: true } } } })])
    const setup = {
      link: link.ready,
      key: llmConfigured(),
      chats: chatsWithRules > 0,
      team: teamCount > 0,
      operator: !!settings().operatorWaId,
    }
    return {
      setup,
      items: counts,
      triage,
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
