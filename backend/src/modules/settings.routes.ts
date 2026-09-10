import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { publicSettings, saveSettings, saveSecret, clearSecret, settings, mockAllowed, type Settings, type SecretName } from '../lib/settings.js'
import { testProvider, modelCatalogue } from '../lib/llm/client.js'
import { str, bool, int } from '../lib/input.js'

const SECRET_NAMES: Record<string, SecretName> = { anthropic: 'anthropicApiKey', openrouter: 'openrouterApiKey' }

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/settings', async () => ({ settings: publicSettings(), models: modelCatalogue() }))

  app.put('/api/settings', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const cur = settings()
    const patch: Partial<Settings> = {}
    if (body.businessName !== undefined) patch.businessName = str(body.businessName).slice(0, 200)
    if (body.provider !== undefined) {
      const p = str(body.provider)
      if (!['anthropic', 'openrouter', 'mock'].includes(p)) return reply.status(400).send({ error: 'Unknown provider' })
      if (p === 'mock' && !mockAllowed()) return reply.status(400).send({ error: 'The mock provider is only available in development' })
      patch.provider = p as Settings['provider']
    }
    if (body.outputLanguage !== undefined) {
      const l = str(body.outputLanguage)
      if (!['en', 'ms', 'zh'].includes(l)) return reply.status(400).send({ error: 'Unknown output language' })
      patch.outputLanguage = l as Settings['outputLanguage']
    }
    if (body.timezone !== undefined) {
      const tz = str(body.timezone)
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz })
      } catch {
        return reply.status(400).send({ error: `"${tz}" is not a valid timezone` })
      }
      patch.timezone = tz
    }
    if (body.filterModel !== undefined) patch.filterModel = str(body.filterModel).slice(0, 100) || cur.filterModel
    if (body.analyzeModel !== undefined) patch.analyzeModel = str(body.analyzeModel).slice(0, 100) || cur.analyzeModel
    if (body.bundleQuietSeconds !== undefined) patch.bundleQuietSeconds = int(body.bundleQuietSeconds, cur.bundleQuietSeconds)
    if (body.bundleMaxMessages !== undefined) patch.bundleMaxMessages = int(body.bundleMaxMessages, cur.bundleMaxMessages)
    if (body.bundleMaxWaitSeconds !== undefined) patch.bundleMaxWaitSeconds = int(body.bundleMaxWaitSeconds, cur.bundleMaxWaitSeconds)
    if (body.contextMessages !== undefined) patch.contextMessages = int(body.contextMessages, cur.contextMessages)
    if (body.allowSimulation !== undefined) patch.allowSimulation = bool(body.allowSimulation, cur.allowSimulation)
    if (body.analyzeImages !== undefined) patch.analyzeImages = bool(body.analyzeImages, cur.analyzeImages)
    await saveSettings(patch)
    return { settings: publicSettings() }
  })

  app.post('/api/settings/keys/:provider', async (request, reply) => {
    const name = SECRET_NAMES[(request.params as { provider: string }).provider]
    if (!name) return reply.status(404).send({ error: 'Unknown provider' })
    const key = str((request.body as Record<string, unknown> | undefined)?.key)
    if (!key) return reply.status(400).send({ error: 'Paste the API key first' })
    await saveSecret(name, key)
    return { settings: publicSettings() }
  })

  app.delete('/api/settings/keys/:provider', async (request, reply) => {
    const name = SECRET_NAMES[(request.params as { provider: string }).provider]
    if (!name) return reply.status(404).send({ error: 'Unknown provider' })
    await clearSecret(name)
    return { settings: publicSettings() }
  })

  app.post('/api/settings/test', async () => testProvider())
}
