import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import prisma from '../lib/prisma.js'
import { sign } from '../lib/jwt.js'
import { authenticate } from '../middleware/auth.js'
import { str } from '../lib/input.js'

/// Single-operator auth. The first visit creates the account; there is no
/// seeded default password to forget to change.
export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async () => {
    const count = await prisma.user.count()
    return { needsSetup: count === 0 }
  })

  // Ten tries a minute per address is generous for a person and useless
  // for a password list. Both routes that take a password get it.
  const guarded = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }

  app.post('/api/auth/setup', guarded, async (request, reply) => {
    const count = await prisma.user.count()
    if (count > 0) return reply.status(409).send({ error: 'Setup has already been completed' })
    const { email, password, name } = (request.body ?? {}) as Record<string, unknown>
    const e = str(email).toLowerCase()
    const p = str(password)
    const n = str(name)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return reply.status(400).send({ error: 'Enter a valid email address' })
    if (p.length < 8) return reply.status(400).send({ error: 'Use a password of at least 8 characters' })
    if (!n) return reply.status(400).send({ error: 'Enter your name' })
    const user = await prisma.user.create({ data: { email: e, password: await bcrypt.hash(p, 12), name: n } })
    return { token: sign({ id: user.id, v: user.tokenVersion }), user: { id: user.id, email: user.email, name: user.name } }
  })

  app.post('/api/auth/login', guarded, async (request, reply) => {
    const { email, password } = (request.body ?? {}) as Record<string, unknown>
    const user = await prisma.user.findUnique({ where: { email: str(email).toLowerCase() } })
    if (!user || !(await bcrypt.compare(str(password), user.password))) {
      return reply.status(401).send({ error: 'Wrong email or password' })
    }
    return { token: sign({ id: user.id, v: user.tokenVersion }), user: { id: user.id, email: user.email, name: user.name } }
  })

  app.get('/api/auth/me', { preHandler: authenticate }, async (request) => ({ user: request.user }))

  app.put('/api/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const { name, password, currentPassword } = (request.body ?? {}) as Record<string, unknown>
    const data: { name?: string; password?: string } = {}
    if (str(name)) data.name = str(name)
    if (str(password)) {
      const user = await prisma.user.findUnique({ where: { id: request.user.id } })
      if (!user || !(await bcrypt.compare(str(currentPassword), user.password))) {
        return reply.status(400).send({ error: 'The current password is wrong' })
      }
      if (str(password).length < 8) return reply.status(400).send({ error: 'Use a password of at least 8 characters' })
      data.password = await bcrypt.hash(str(password), 12)
    }
    // A new password retires every token signed under the old one — including
    // the caller's, so a fresh one goes back with the reply.
    const user = await prisma.user.update({
      where: { id: request.user.id },
      data: { ...data, ...(data.password ? { tokenVersion: { increment: 1 } } : {}) },
      select: { id: true, email: true, name: true, tokenVersion: true },
    })
    return { user: { id: user.id, email: user.email, name: user.name }, ...(data.password ? { token: sign({ id: user.id, v: user.tokenVersion }) } : {}) }
  })
}
