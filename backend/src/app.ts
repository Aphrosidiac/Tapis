import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'fs'
import { join } from 'path'
import { loadSettings } from './lib/settings.js'
import { ensureDirs } from './lib/paths.js'
import { setBaileysLogger, start as startWhatsApp, stop as stopWhatsApp } from './lib/whatsapp/baileys.js'
import { setIngestLogger } from './lib/whatsapp/ingest.js'
import { startScheduler, stopScheduler } from './lib/pipeline/scheduler.js'
import authRoutes from './modules/auth.routes.js'
import whatsappRoutes from './modules/whatsapp.routes.js'
import chatRoutes from './modules/chats.routes.js'
import itemRoutes from './modules/items.routes.js'
import reviewRoutes from './modules/review.routes.js'
import settingsRoutes from './modules/settings.routes.js'
import dashboardRoutes from './modules/dashboard.routes.js'
import noticeRoutes from './modules/notices.routes.js'
import devRoutes from './modules/dev.routes.js'

export interface BuildOptions {
  /// Connect the WhatsApp link and run the pipeline. Only the one serving
  /// process passes this; tests and scripts must never hold the session.
  serve?: boolean
}

export async function buildApp(opts: BuildOptions = {}) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info', transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } : undefined },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  })

  await app.register(cors, { origin: process.env.NODE_ENV === 'production' ? false : true })
  await app.register(helmet, { contentSecurityPolicy: false })

  app.setErrorHandler((err, _request, reply) => {
    const e = err as Error & { statusCode?: number }
    const status = e.statusCode ?? 500
    if (status >= 500) app.log.error(err)
    reply.status(status).send({ error: status >= 500 ? 'Something went wrong on the server' : e.message })
  })

  ensureDirs()
  await loadSettings()

  const log = (msg: string, err?: unknown) => (err ? app.log.warn({ err }, msg) : app.log.info(msg))
  setBaileysLogger(log)
  setIngestLogger(log)

  app.get('/api/health', async () => ({ ok: true }))
  await app.register(authRoutes)
  await app.register(whatsappRoutes)
  await app.register(chatRoutes)
  await app.register(itemRoutes)
  await app.register(reviewRoutes)
  await app.register(settingsRoutes)
  await app.register(dashboardRoutes)
  await app.register(noticeRoutes)
  await app.register(devRoutes)

  // The built frontend, when it exists. Any non-API path is the SPA.
  const dist = join(process.cwd(), '..', 'frontend', 'dist')
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' })
      return reply.sendFile('index.html')
    })
  }

  if (opts.serve) {
    app.addHook('onReady', async () => {
      startScheduler(log)
      // Resume a saved link; never sit generating QR codes nobody sees.
      void startWhatsApp({ resumeOnly: true }).catch((err) => app.log.error({ err }, 'could not resume the WhatsApp link'))
    })
    app.addHook('onClose', async () => {
      stopScheduler()
      await stopWhatsApp('shutting down')
    })
  }

  return app
}
