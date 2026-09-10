import type { FastifyInstance } from 'fastify'
import { createReadStream, existsSync } from 'fs'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { simulationAllowed } from '../lib/settings.js'
import { handleInbound } from '../lib/whatsapp/ingest.js'
import { tick } from '../lib/pipeline/scheduler.js'
import { str, bool, waDigits } from '../lib/input.js'

/// The simulator: feeds a message through the real ingest and pipeline as if
/// a phone had sent it. How the system is exercised without a WhatsApp link,
/// and how a rule is checked before real traffic arrives.
export default async function devRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.post('/api/simulate', async (request, reply) => {
    if (!simulationAllowed()) return reply.status(403).send({ error: 'Simulation is switched off. Enable it on the Settings screen.' })
    const b = (request.body ?? {}) as Record<string, unknown>
    const text = str(b.text)
    if (!text) return reply.status(400).send({ error: 'Type a message' })

    let chatJid = str(b.chatJid)
    let isGroup = bool(b.isGroup, true)
    if (b.chatId) {
      const chat = await prisma.chat.findUnique({ where: { id: str(b.chatId) } })
      if (!chat) return reply.status(404).send({ error: 'Chat not found' })
      chatJid = chat.jid
      isGroup = chat.isGroup
    }
    if (!chatJid) {
      const name = str(b.chatName) || 'Simulated group'
      chatJid = `sim-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@g.us`
      isGroup = true
    }
    const senderWaId = waDigits(b.senderWaId) || '60100000001'
    const sentAt = b.sentAt ? new Date(String(b.sentAt)) : new Date()

    const result = await handleInbound(
      {
        waMessageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatJid,
        isGroup,
        senderWaId,
        senderName: str(b.senderName) || null,
        fromMe: bool(b.fromMe, false),
        type: 'TEXT',
        text,
        quotedWaMessageId: null,
        timestamp: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
        hasMedia: false,
        content: null,
        raw: null,
      },
      undefined,
      true,
    )
    if (!result.stored && result.reason === 'chat is not tracked') {
      // A brand-new simulated chat is only useful if it is tracked.
      const chat = await prisma.chat.findUnique({ where: { jid: chatJid } })
      if (chat && str(b.chatName)) {
        await prisma.chat.update({ where: { id: chat.id }, data: { name: str(b.chatName) } })
      }
    }
    return { result }
  })

  app.post('/api/pipeline/run', async (request) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const result = await tick({ force: true, ...(str(b.chatId) ? { chatId: str(b.chatId) } : {}) })
    return { result }
  })

  /// Media behind auth. Never a static mount — see lib/paths.ts.
  app.get('/api/media/:messageId', async (request, reply) => {
    const { messageId } = request.params as { messageId: string }
    const m = await prisma.message.findUnique({ where: { id: messageId }, select: { mediaPath: true, mediaMime: true } })
    if (!m?.mediaPath || !existsSync(m.mediaPath)) return reply.status(404).send({ error: 'No media stored for this message' })
    reply.header('Content-Type', m.mediaMime ?? 'application/octet-stream')
    reply.header('Cache-Control', 'private, max-age=3600')
    return reply.send(createReadStream(m.mediaPath))
  })
}
