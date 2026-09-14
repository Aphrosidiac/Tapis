import type { FastifyRequest, FastifyReply } from 'fastify'
import { verify } from '../lib/jwt.js'
import prisma from '../lib/prisma.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; name: string }
  }
}

/// Header only. Media used to ride the token in a query string for <img>;
/// it now arrives as a blob fetched with the header, so a token never sits
/// in a URL, a proxy log, or a browser history.
function tokenFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return null
}

export const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const token = tokenFrom(request)
    if (!token) return reply.status(401).send({ error: 'Sign in first' })
    const decoded = verify(token)
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { id: true, email: true, name: true, tokenVersion: true } })
    if (!user) return reply.status(401).send({ error: 'This account no longer exists' })
    if ((decoded.v ?? 0) !== user.tokenVersion) return reply.status(401).send({ error: 'The password was changed. Sign in again.' })
    request.user = { id: user.id, email: user.email, name: user.name }
  } catch {
    return reply.status(401).send({ error: 'Your session has expired. Sign in again.' })
  }
}
