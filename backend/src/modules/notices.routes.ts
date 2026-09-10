import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { baileysStatus } from '../lib/whatsapp/baileys.js'
import { llmConfigured } from '../lib/llm/client.js'
import { settings } from '../lib/settings.js'

/// Everything that currently needs a person, in one call.
///
/// These used to be banners on the dashboard, which meant a dead WhatsApp
/// link was invisible from every other screen — including the Chats screen
/// where you would be wondering why no messages had arrived. They belong to
/// the app, not to one page.

export type NoticeTone = 'danger' | 'warning' | 'info'

export interface Notice {
  /// Stable across polls, so the panel does not re-animate every 20 seconds.
  id: string
  tone: NoticeTone
  title: string
  body: string
  to?: string
  action?: string
}

export default async function noticeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/notices', async () => {
    const s = settings()
    const link = baileysStatus()
    const notices: Notice[] = []

    // ── The pipeline cannot run at all ──
    if (!llmConfigured()) {
      notices.push({
        id: 'no-key',
        tone: 'danger',
        title: 'No model key is configured',
        body: 'Nothing is being analysed. Messages are still being stored, and they will be processed as soon as a key is added.',
        to: '/settings',
        action: 'Add a key',
      })
    } else if (s.provider === 'mock') {
      notices.push({
        id: 'mock-provider',
        tone: 'warning',
        title: 'The mock provider is selected',
        body: 'No model is called and every brief says MOCK. Choose a real provider before trusting anything here.',
        to: '/settings',
        action: 'Choose a provider',
      })
    }

    // ── Nothing is arriving ──
    if (link.ghostDevice) {
      notices.push({ id: 'ghost-device', tone: 'danger', title: 'A device was left on the phone', body: link.ghostDevice, to: '/whatsapp', action: 'Open the link page' })
    } else if (!link.ready) {
      const stopped = ['failed', 'logged-out'].includes(link.state)
      notices.push({
        id: 'link-down',
        tone: stopped ? 'danger' : 'warning',
        title: `WhatsApp is ${link.state.replace('-', ' ')}`,
        body: link.action ?? 'No messages are arriving from WhatsApp.',
        to: '/whatsapp',
        action: 'Open the link page',
      })
    }

    const [failedBundles, latestFailed, failedDeliveries, trackedNoRules, oldestPending] = await Promise.all([
      prisma.bundle.count({ where: { status: 'FAILED' } }),
      prisma.bundle.findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, include: { chat: { select: { name: true } } } }),
      prisma.delivery.count({ where: { status: 'FAILED' } }),
      prisma.chat.count({ where: { tracked: true, rules: { none: { active: true } } } }),
      prisma.message.findFirst({ where: { filterStatus: 'PENDING' }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }),
    ])

    if (failedBundles) {
      notices.push({
        id: 'failed-bundles',
        tone: 'danger',
        title: `${failedBundles} pipeline run${failedBundles === 1 ? '' : 's'} failed`,
        body: latestFailed ? `Latest — ${latestFailed.chat.name}: ${latestFailed.error ?? 'no reason recorded'}` : 'Messages in those runs have not been analysed.',
        to: '/review',
        action: 'Review and retry',
      })
    }

    if (failedDeliveries) {
      notices.push({
        id: 'failed-deliveries',
        tone: 'warning',
        title: `${failedDeliveries} WhatsApp delivery${failedDeliveries === 1 ? '' : 'ies'} gave up`,
        body: 'An item was never sent to the number its rule names. Open the item to see the reason and send it again.',
        to: '/',
        action: 'Open the dashboard',
      })
    }

    // A tracked chat with no rule stores every message and then dismisses
    // all of them — which looks exactly like the filter being too harsh.
    if (trackedNoRules) {
      notices.push({
        id: 'chats-without-rules',
        tone: 'info',
        title: `${trackedNoRules} tracked chat${trackedNoRules === 1 ? ' has' : 's have'} no rules`,
        body: 'Their messages are stored and then dismissed, because there is nothing to match them against.',
        to: '/chats',
        action: 'Add a rule',
      })
    }

    // Bundles are cut on quiet, size or age, so a backlog older than an hour
    // means the scheduler or the model is not keeping up.
    if (oldestPending && Date.now() - oldestPending.receivedAt.getTime() > 3_600_000) {
      notices.push({
        id: 'stale-backlog',
        tone: 'warning',
        title: 'Messages have been waiting over an hour',
        body: 'They should have been bundled by now. Check the most recent pipeline runs for a failure.',
        to: '/review',
        action: 'See the runs',
      })
    }

    return { notices, count: notices.length, worst: notices.some((n) => n.tone === 'danger') ? 'danger' : notices.length ? 'warning' : 'none' }
  })
}
