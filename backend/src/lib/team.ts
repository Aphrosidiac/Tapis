import prisma from './prisma.js'

/// Who is on our side, by sender id. Loaded once and kept in memory: it is
/// consulted on every inbound and every transcript line, and it changes when
/// a person clicks. Matching is exact on the stored sender id — a number for
/// most senders, `lid:…` for one that never carried a number — never on a
/// name, which changes with every push-name edit.

let cached = new Set<string>()

export async function loadTeam(): Promise<void> {
  const rows = await prisma.teamMember.findMany({ select: { waId: true } })
  cached = new Set(rows.map((r) => r.waId))
}

export function isTeam(waId: string | null | undefined): boolean {
  return !!waId && cached.has(waId)
}

export function teamIds(): ReadonlySet<string> {
  return cached
}

export async function setTeam(waId: string, on: boolean, name?: string | null): Promise<void> {
  if (on) {
    await prisma.teamMember.upsert({ where: { waId }, create: { waId, name: name ?? null }, update: { ...(name ? { name } : {}) } })
    cached.add(waId)
    // Anything from them still waiting to be judged is context now, not a
    // candidate. Already-judged messages keep their history.
    await prisma.message.updateMany({
      where: { senderWaId: waId, fromMe: false, filterStatus: 'PENDING' },
      data: { filterStatus: 'SKIPPED', filterReason: 'Sent by our team' },
    })
  } else {
    await prisma.teamMember.deleteMany({ where: { waId } })
    cached.delete(waId)
  }
}
