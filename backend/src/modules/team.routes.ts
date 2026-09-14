import type { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { setTeam, teamIds } from '../lib/team.js'
import { str, bool } from '../lib/input.js'

/// Settings → Your team. The list to choose from is every sender the link
/// has seen across the tracked chats — nobody types a number, and the id
/// matched at ingest is the same id shown here.
export default async function teamRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/team', async () => {
    const [members, participants] = await Promise.all([
      prisma.teamMember.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.participant.findMany({
        select: { waId: true, name: true, messageCount: true, lastSeenAt: true, chat: { select: { id: true, name: true, tracked: true } } },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ])
    // One row per sender id: the names they have used, the chats they are
    // in, how much they have said. Someone in many of your groups is almost
    // certainly staff — the chat count is what makes that visible.
    const byId = new Map<string, { waId: string; names: string[]; chats: { id: string; name: string }[]; messageCount: number; lastSeenAt: Date }>()
    for (const p of participants) {
      const row = byId.get(p.waId) ?? { waId: p.waId, names: [], chats: [], messageCount: 0, lastSeenAt: p.lastSeenAt }
      if (p.name && !row.names.includes(p.name)) row.names.push(p.name)
      row.chats.push({ id: p.chat.id, name: p.chat.name })
      row.messageCount += p.messageCount
      if (p.lastSeenAt > row.lastSeenAt) row.lastSeenAt = p.lastSeenAt
      byId.set(p.waId, row)
    }
    const team = new Set(members.map((m) => m.waId))
    const people: Array<(typeof byId extends Map<string, infer V> ? V : never) & { team: boolean; name: string | null }> = [...byId.values()]
      .map((r) => ({ ...r, team: team.has(r.waId), name: members.find((m) => m.waId === r.waId)?.name ?? r.names[0] ?? null }))
      .sort((a, b) => Number(b.team) - Number(a.team) || b.chats.length - a.chats.length || b.messageCount - a.messageCount)
    // A member who has not spoken since tracking began still counts.
    for (const m of members) {
      if (!byId.has(m.waId)) people.unshift({ waId: m.waId, names: m.name ? [m.name] : [], chats: [], messageCount: 0, lastSeenAt: m.createdAt, team: true, name: m.name })
    }
    return { people, count: team.size }
  })

  app.put('/api/team/:waId', async (request, reply) => {
    const waId = str((request.params as { waId: string }).waId)
    if (!waId) return reply.status(400).send({ error: 'Which person?' })
    const b = (request.body ?? {}) as Record<string, unknown>
    await setTeam(waId, bool(b.team, true), str(b.name) || null)
    return { waId, team: teamIds().has(waId) }
  })
}
