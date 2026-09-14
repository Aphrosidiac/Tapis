import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { str, int } from '../lib/input.js'
import { startTurn, subscribe, stopRun, activeRun, approveAction, declineAction, undoAction, actionView, type AgentEvent } from '../lib/agent/run.js'
import { allTools } from '../lib/agent/tools.js'
import { settings } from '../lib/settings.js'

/// The assistant's API: threads, turns, and a stream of what a turn is
/// doing. The stream is plain SSE over a fetch with the normal auth header
/// — not EventSource, which cannot carry one — with event ids so a client
/// that drops mid-turn picks up where it left off.
export default async function agentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/agent/threads', async (request) => {
    const q = request.query as Record<string, string>
    const threads = await prisma.agentThread.findMany({ orderBy: { lastMessageAt: 'desc' }, take: int(q.limit, 50, 1, 200) })
    return { threads: threads.map((t) => ({ ...t, running: !!activeRun(t.id) })) }
  })

  app.post('/api/agent/threads', async () => {
    const thread = await prisma.agentThread.create({ data: { model: settings().agentModel } })
    return { thread }
  })

  app.get('/api/agent/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const thread = await prisma.agentThread.findUnique({ where: { id }, include: { messages: { orderBy: { seq: 'asc' } }, actions: { orderBy: { createdAt: 'asc' } } } })
    if (!thread) return reply.status(404).send({ error: 'Conversation not found' })
    return {
      thread: {
        ...thread,
        running: !!activeRun(id),
        messages: thread.messages.map((m) => ({ id: m.id, seq: m.seq, role: m.role, content: m.content, createdAt: m.createdAt })),
        actions: thread.actions.map(actionView),
      },
    }
  })

  app.put('/api/agent/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const title = str((request.body as Record<string, unknown> | undefined)?.title).slice(0, 120)
    if (!title) return reply.status(400).send({ error: 'Give it a title' })
    const thread = await prisma.agentThread.update({ where: { id }, data: { title } })
    return { thread }
  })

  app.delete('/api/agent/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (activeRun(id)) return reply.status(409).send({ error: 'Stop the assistant first' })
    await prisma.agentThread.delete({ where: { id } })
    return { ok: true }
  })

  app.post('/api/agent/threads/:id/turns', async (request, reply) => {
    const { id } = request.params as { id: string }
    const text = str((request.body as Record<string, unknown> | undefined)?.text).slice(0, 20_000)
    if (!text) return reply.status(400).send({ error: 'Say something' })
    try {
      const { userMessage } = await startTurn(id, text)
      return { userMessage }
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.status(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  app.post('/api/agent/threads/:id/stop', async (request) => {
    const { id } = request.params as { id: string }
    return { stopped: stopRun(id) }
  })

  /// Events of the current (or just-finished) run, from `since` onward.
  app.get('/api/agent/threads/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string }
    const since = int((request.query as Record<string, string>).since, 0, 0)
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const send = (eventId: number, event: AgentEvent) => {
      raw.write(`id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (event.type === 'done' || event.type === 'error') raw.end()
    }
    const unsubscribe = subscribe(id, since, send)
    if (!unsubscribe) {
      raw.write(`event: idle\ndata: {}\n\n`)
      raw.end()
      return
    }
    // A finished run past its last event: nothing more will come.
    if (!activeRun(id) && !raw.writableEnded) raw.end()
    const ping = setInterval(() => {
      if (!raw.writableEnded) raw.write(': ping\n\n')
    }, 15_000)
    request.raw.on('close', () => {
      clearInterval(ping)
      unsubscribe()
    })
  })

  const act = (fn: (id: string, body: Record<string, unknown>) => Promise<unknown>) => async (request: { params: unknown; body: unknown }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    const { id } = request.params as { id: string }
    try {
      return await fn(id, (request.body ?? {}) as Record<string, unknown>)
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.status(e.statusCode ?? 500).send({ error: e.message })
    }
  }
  app.post('/api/agent/actions/:id/approve', act(async (id) => ({ action: await approveAction(id) })))
  app.post('/api/agent/actions/:id/decline', act(async (id, body) => ({ action: await declineAction(id, str(body.reason) || undefined) })))
  app.post('/api/agent/actions/:id/undo', act(async (id) => undoAction(id)))

  app.get('/api/agent/tools', async () => ({ tools: allTools().map((t) => ({ name: t.name, tier: t.tier, description: t.description })) }))
}
