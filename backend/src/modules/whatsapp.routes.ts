import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { baileysStatus, start, stop, logout, refreshGroups, resyncContacts, probeInstalled, sessionFileCount, catchUpTrackedChats } from '../lib/whatsapp/baileys.js'
import { waDigits, isUsableWaId } from '../lib/input.js'

/// Asking the phone for history (HISTORY_SYNC_ON_DEMAND) is switched off.
/// With Baileys 6.7.24 on a LID-addressed account the phone's answer comes
/// back under its LID on a Signal session this side does not hold: Bad MAC,
/// then a retry request per failure, then the phone syncs and notifies the
/// operator once per retry. Verified 2026-09-17 on a fresh pairing, so it is
/// not a stale session. Tracked chats catch up from the pairing history sync
/// and the reconnect backlog instead, neither of which asks the phone.
export const ON_DEMAND_HISTORY_WORKS = false
export const ON_DEMAND_HISTORY_DOWN =
  'Reading history from the phone is switched off: its answers cannot be decrypted on this Baileys version and each attempt makes the phone re-sync and notify you. Tracked chats catch up from the pairing sync and the reconnect backlog instead.'

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

  /// Pulls the saved contact names again. Separate from the group refresh
  /// because they come from different places: groups from a direct query,
  /// names from the app-state sync.
  app.post('/api/whatsapp/resync-contacts', async (request, reply) => {
    try {
      return await resyncContacts()
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /// Reads every tracked chat back from the phone to its newest stored
  /// message and stores what is missing. Runs on its own after a backlog;
  /// this is the button for when the phone was unreachable then.
  app.post('/api/whatsapp/catch-up', async (request, reply) => {
    if (!ON_DEMAND_HISTORY_WORKS) return reply.status(409).send({ error: ON_DEMAND_HISTORY_DOWN })
    try {
      return await catchUpTrackedChats('requested')
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/whatsapp/refresh-groups', async (request, reply) => {
    try {
      const count = await refreshGroups()
      return { count }
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
