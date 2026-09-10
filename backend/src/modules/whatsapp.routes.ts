import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { baileysStatus, start, stop, logout, refreshGroups, probeInstalled, sessionFileCount } from '../lib/whatsapp/baileys.js'
import { waDigits, isUsableWaId } from '../lib/input.js'

export default async function whatsappRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/whatsapp/status', async () => {
    await probeInstalled()
    return { link: baileysStatus(), sessionFiles: sessionFileCount() }
  })

  app.post('/api/whatsapp/link', async () => ({ link: await start({ pair: true }) }))

  app.post('/api/whatsapp/pair-code', async (request, reply) => {
    const number = waDigits((request.body as Record<string, unknown> | undefined)?.number)
    if (!isUsableWaId(number)) return reply.status(400).send({ error: 'Enter the WhatsApp number in international form, e.g. 60123456789' })
    return { link: await start({ pairWithNumber: number }) }
  })

  app.post('/api/whatsapp/stop', async () => ({ link: await stop() }))

  app.post('/api/whatsapp/unlink', async () => ({ link: await logout() }))

  app.post('/api/whatsapp/refresh-groups', async (request, reply) => {
    try {
      const count = await refreshGroups()
      return { count }
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
