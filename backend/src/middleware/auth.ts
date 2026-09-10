import type { FastifyRequest, FastifyReply } from 'fastify'
import { verify } from '../lib/jwt.js'
import prisma from '../lib/prisma.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; name: string }
  }
}

function tokenFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  // Images in <img src> cannot carry a header.
  const q = (request.query as Record<string, unknown> | undefined)?.token
  return typeof q === 'string' && q ? q : null
}

export const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const token = tokenFrom(request)
    if (!token) return reply.status(401).send({ error: 'Sign in first' })
    const decoded = verify(token)
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { id: true, email: true, name: true } })
    if (!user) return reply.status(401).send({ error: 'This account no longer exists' })
    request.user = user
  } catch {
    return reply.status(401).send({ error: 'Your session has expired. Sign in again.' })
  }
}
