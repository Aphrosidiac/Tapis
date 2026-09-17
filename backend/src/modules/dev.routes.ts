import type { FastifyInstance } from 'fastify'
import { createReadStream, existsSync } from 'fs'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { simulationAllowed } from '../lib/settings.js'
import { handleInbound } from '../lib/whatsapp/ingest.js'
import { tick } from '../lib/pipeline/scheduler.js'
import { str, bool, waDigits } from '../lib/input.js'
import { fetchChatHistory } from '../lib/whatsapp/baileys.js'
import { ON_DEMAND_HISTORY_WORKS, ON_DEMAND_HISTORY_DOWN } from './whatsapp.routes.js'
import { MEDIA_DIR } from '../lib/paths.js'
import { join, resolve, sep, basename } from 'path'

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
    if (!resolve(m.mediaPath).startsWith(resolve(MEDIA_DIR) + sep)) return reply.status(404).send({ error: 'No media stored for this message' })
    // The stored mime is whatever the sender's phone claimed. Served on the
    // app's own origin, a "document" declared text/html would run as the
    // operator — so only types a browser renders harmlessly keep their name,
    // everything else downloads as bytes, and nothing served here may script.
    const mime = m.mediaMime ?? ''
    const renderable = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4)|video\/mp4|application\/pdf)$/.test(mime)
    reply.header('Content-Type', renderable ? mime : 'application/octet-stream')
    reply.header('Content-Disposition', renderable ? 'inline' : `attachment; filename="${basename(m.mediaPath)}"`)
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'")
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Cache-Control', 'private, max-age=3600')
    return reply.send(createReadStream(m.mediaPath))
  })
  /// Reads one chat's recent messages straight from the phone. A one-off
  /// read for a person, not an ingest: nothing lands in the database or the
  /// pipeline, and media goes to a scratch folder under media/history.
  app.get('/api/dev/history', async (request, reply) => {
    if (!simulationAllowed()) return reply.status(403).send({ error: 'Developer tools are switched off. Enable simulation on the Settings screen.' })
    const q = (request.query ?? {}) as Record<string, unknown>
    let jid = str(q.jid)
    if (q.chatId) {
      const chat = await prisma.chat.findUnique({ where: { id: str(q.chatId) } })
      if (!chat) return reply.status(404).send({ error: 'Chat not found' })
      jid = chat.jid
    }
    if (!jid) return reply.status(400).send({ error: 'Pass chatId or jid' })
    if (!ON_DEMAND_HISTORY_WORKS) return reply.status(409).send({ error: ON_DEMAND_HISTORY_DOWN })
    const days = Math.min(Math.max(Number(q.days) || 3, 1), 30)
    const since = new Date(Date.now() - days * 86_400_000)
    const withMedia = bool(q.media, true)
    try {
      const messages = await fetchChatHistory(jid, since, {
        pageSize: Math.min(Number(q.pageSize) || 50, 200),
        maxPages: Math.min(Number(q.maxPages) || 10, 40),
        mediaDir: withMedia ? join(MEDIA_DIR, 'history', jid.replace(/[^a-z0-9]/gi, '_')) : null,
      })
      return { jid, since, count: messages.length, messages }
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
