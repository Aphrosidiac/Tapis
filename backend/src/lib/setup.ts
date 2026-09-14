import { z } from 'zod'
import prisma from './prisma.js'
import { settings } from './settings.js'
import { callParsed } from './llm/client.js'
import { fetchChatHistory, membersOf, groupsWith, baileysReady, meInfo } from './whatsapp/baileys.js'
import { teamIds } from './team.js'
import { isUsableWaId } from './input.js'

/// Setting up a chat without typing everything. Switching a chat on used
/// to mean: toggle, open it, invent a client name, write a description
/// from memory, add rules one by one. Now the phone is asked for the last
/// few days of the chat — a one-off read, nothing stored — and a cheap
/// model drafts the client name, the description, the rules worth having
/// and who on our side is in it. The operator edits and presses one button.

const PEEK_DAYS = 3
const PEEK_MESSAGES = 80

const Draft = z.object({
  clientName: z.string().describe('Short name of the client or project, e.g. "Harvestgrow". Empty if this is not a client chat.'),
  description: z.string().describe('2-4 sentences: who the client is, what the project or product is, who the people are and their roles. Written for a model that will read it before every message.'),
  languages: z.string().describe('e.g. "Chinese and English, some Malay"'),
  kind: z.enum(['client', 'internal', 'personal', 'other']).describe('client = a client or customer chat worth tracking'),
  rules: z.array(z.object({ text: z.string(), why: z.string() })).describe('2-5 tracking rules in plain language, each one a sentence like "Track complaints and bug reports", with a one-line reason from what was seen'),
  team: z.array(z.object({ waId: z.string(), name: z.string(), why: z.string() })).describe('Senders who are on OUR side (the business), with the reason'),
})
export type SetupDraft = z.infer<typeof Draft> & { peeked: number; source: 'history' | 'name-only'; suggestedTeam: { waId: string; name: string | null; why: string }[] }

const SYSTEM = `You help set up a WhatsApp chat in Tapis, a system that reads chosen chats and turns client requests, complaints and bug reports into tracked items. You are shown the chat's name, its people, and a sample of recent messages. Draft the setup an operator would otherwise type by hand.

Be concrete and short. The description is read by models before every message: say who the client is, what the product/project is, and who each named person is. The client is the OTHER party — never our own business, whose name often appears in the group name too ("Lewix AI & ANK PET" → the client is ANK PET). Rules are plain sentences the filter will apply; pick the ones this chat actually needs from what you saw (requests, complaints, bugs, payments, deliveries, schedules, change requests) — not a generic list. Rules describe what the CLIENT raises; never write a rule about our own team's replies, fixes or confirmations — those are recorded automatically. For team, name only people who are clearly on the business's side (they answer, fix, deploy, commit).

Never invent facts. When there is NO message sample: keep the description to one or two sentences that the name and people support, say nothing about roles you cannot see, and return exactly these two rules — "Track feature requests from this group" (why: "the usual starting point") and "Track complaints and bug reports" (why: "the usual starting point") — nothing else.`

export async function draftSetup(chatId: string, opts: { peek?: boolean } = {}): Promise<SetupDraft> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, include: { participants: { orderBy: { messageCount: 'desc' }, take: 30 } } })
  if (!chat) throw Object.assign(new Error('Chat not found'), { statusCode: 404 })
  const s = settings()
  const team = teamIds()
  const me = meInfo()?.id
  const teamNames = new Map((await prisma.teamMember.findMany()).map((t) => [t.waId, t.name]))

  // Who is in it, from any source we have: stored participants for a chat
  // that has spoken, the group list for one that has not.
  const contacts = await prisma.contact.findMany({ select: { jid: true, name: true } })
  const nameOf = new Map(contacts.map((c) => [c.jid.split('@')[0], c.name]))
  const memberIds = chat.isGroup ? membersOf(chat.jid) : [chat.jid.split('@')[0]]
  const people = new Map<string, { waId: string; name: string | null; messages: number }>()
  for (const id of memberIds) people.set(id, { waId: id, name: teamNames.get(id) ?? nameOf.get(id) ?? null, messages: 0 })
  for (const p of chat.participants) people.set(p.waId, { waId: p.waId, name: p.name ?? nameOf.get(p.waId) ?? null, messages: p.messageCount })

  let sample: { who: string; side: string; text: string; at: Date }[] = []
  let peeked = 0
  // A chat already being read has its recent messages stored: the sure
  // source. Otherwise the phone is asked (best effort — many phones never
  // answer an on-demand history request), and failing that, the name.
  if (chat.tracked) {
    const stored = await prisma.message.findMany({ where: { chatId, simulated: false }, orderBy: { sentAt: 'desc' }, take: PEEK_MESSAGES })
    for (const m of stored.reverse()) {
      const text = (m.mediaTextStatus === 'DONE' && m.mediaText ? `${m.text ? `${m.text} ` : ''}[${m.type === 'AUDIO' ? 'voice note' : 'image'}: ${m.mediaText}]` : m.text?.trim()) || `[${m.type.toLowerCase()}]`
      sample.push({ who: m.fromMe ? 'Me (the business)' : m.senderName || m.senderWaId, side: m.fromMe || team.has(m.senderWaId) ? 'our team' : 'unknown', text: text.slice(0, 300), at: m.sentAt })
    }
    peeked = sample.length
  }
  if (!sample.length && opts.peek !== false && baileysReady()) {
    try {
      const history = await fetchChatHistory(chat.jid, new Date(Date.now() - PEEK_DAYS * 86_400_000), { pageSize: 50, maxPages: 2, mediaDir: null })
      const recent = history.slice(-PEEK_MESSAGES)
      peeked = recent.length
      for (const m of recent) {
        const cur = people.get(m.senderWaId) ?? { waId: m.senderWaId, name: m.senderName, messages: 0 }
        cur.messages += 1
        if (!cur.name && m.senderName) cur.name = m.senderName
        people.set(m.senderWaId, cur)
        const text = m.text?.trim() || (m.type === 'AUDIO' ? '[voice note]' : m.type === 'IMAGE' ? '[image]' : `[${m.type.toLowerCase()}]`)
        sample.push({ who: m.fromMe ? 'Me (the business)' : m.senderName || m.senderWaId, side: m.fromMe || team.has(m.senderWaId) ? 'our team' : 'unknown', text: text.slice(0, 300), at: m.sentAt })
      }
    } catch {
      /* no anchor yet, or the phone did not answer: draft from the name */
    }
  }

  // Known team members in it are a fact, not a guess.
  const suggestedTeam = [...people.values()]
    .filter((p) => p.waId !== me && team.has(p.waId))
    .map((p) => ({ waId: p.waId, name: p.name ?? teamNames.get(p.waId) ?? null, why: 'Already on your team' }))

  const peopleBlock = [...people.values()]
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 25)
    .map((p) => `- ${p.name ?? '(no name)'} · ${p.waId}${team.has(p.waId) ? ' · OUR TEAM' : ''}${p.waId === me ? ' · the linked phone (us)' : ''}${p.messages ? ` · ${p.messages} msgs` : ''}`)
    .join('\n')
  const tracked = await prisma.chat.findMany({ where: { tracked: true, id: { not: chatId }, description: { not: null } }, select: { name: true, clientName: true, description: true }, take: 3 })
  const examples = tracked.length ? `\n\n## How this operator describes other chats (match the style)\n${tracked.map((t) => `${t.clientName ?? t.name}: ${t.description}`).join('\n')}` : ''
  const text = [
    `Our business: ${s.businessName || '(not set — infer it from the names of the chats and the team)'}. Output language: ${s.outputLanguage}.`,
    `Chat: "${chat.name}" (${chat.isGroup ? 'group' : 'private chat'}).`,
    `## People\n${peopleBlock || '(none known)'}`,
    sample.length
      ? `## Last ${PEEK_DAYS} days (${sample.length} messages, oldest first)\n${sample.map((m) => `${m.at.toISOString().slice(5, 16).replace('T', ' ')} ${m.who}${m.side === 'our team' ? ' [our team]' : ''}: ${m.text}`).join('\n')}`
      : '## No message sample was available — draft from the name and people only, and say so in the description if it is thin.',
    examples,
  ].join('\n\n')

  const out = await callParsed({
    kind: 'FILTER',
    model: s.filterModel,
    system: SYSTEM,
    text,
    schema: Draft,
    maxTokens: 2500,
    mock: () => ({ clientName: chat.name, description: `MOCK description of ${chat.name}`, languages: 'mock', kind: 'client', rules: [{ text: 'Track complaints and bug reports', why: 'mock' }], team: [] }),
  })
  // The model may name a team member we did not know; a person confirms.
  const digits = (id: string) => id.replace(/^lid:/, '')
  const known = new Set(suggestedTeam.map((t) => digits(t.waId)))
  const modelTeam = out.team
    .filter((t) => people.has(t.waId) && t.waId !== me && !team.has(t.waId) && !known.has(digits(t.waId)))
    .map((t) => ({ waId: t.waId, name: people.get(t.waId)?.name ?? t.name, why: t.why }))
  return { ...out, peeked, source: sample.length ? 'history' : 'name-only', suggestedTeam: [...suggestedTeam, ...modelTeam] }
}

export interface SetupInput {
  clientName?: string | null
  description?: string | null
  rules: { text: string; toWhatsapp?: string[] }[]
  team: { waId: string; name?: string | null }[]
}

/// Applies a setup in one go: context, rules, team, and tracking on.
export async function applySetup(chatId: string, input: SetupInput) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!chat) throw Object.assign(new Error('Chat not found'), { statusCode: 404 })
  const rules = input.rules.map((r) => ({ text: r.text.trim().slice(0, 1000), toWhatsapp: (r.toWhatsapp ?? []).map((n) => n.replace(/[^0-9]/g, '')).filter(isUsableWaId) })).filter((r) => r.text)
  const { setTeam } = await import('./team.js')
  for (const t of input.team) if (t.waId) await setTeam(t.waId, true, t.name ?? null)
  await prisma.$transaction(async (tx) => {
    await tx.chat.update({
      where: { id: chatId },
      data: {
        tracked: true,
        ...(chat.tracked ? {} : { trackedSince: new Date() }),
        ...(input.clientName !== undefined ? { clientName: input.clientName?.trim() || null } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      },
    })
    const existing = await tx.rule.findMany({ where: { chatId }, select: { text: true } })
    const have = new Set(existing.map((r) => r.text.trim().toLowerCase()))
    for (const r of rules) if (!have.has(r.text.toLowerCase())) await tx.rule.create({ data: { chatId, text: r.text, toWhatsapp: r.toWhatsapp, toDashboard: true } })
  })
  return prisma.chat.findUnique({ where: { id: chatId }, include: { rules: true } })
}

/// Untracked groups worth a look, best first: your team is in them, they
/// talk, and they look like client groups rather than family.
export async function suggestedChats(limit = 6) {
  const team = [...teamIds()]
  const me = meInfo()?.id
  const chats = await prisma.chat.findMany({ where: { tracked: false, isGroup: true }, orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } }, take: 400 })
  const weekAgo = Date.now() - 7 * 86_400_000
  const scored = chats.map((c) => {
    const members = membersOf(c.jid)
    const teamIn = members.filter((m) => team.includes(m) && m !== me)
    const small = (c.participantCount ?? members.length) <= 40
    const active = !!c.lastMessageAt && c.lastMessageAt.getTime() > weekAgo
    const score = (teamIn.length ? 3 : 0) + (active ? 2 : 0) + (small ? 1 : 0)
    return { chat: c, teamIn, active, score }
  })
  return scored
    .filter((x) => x.score >= 3 && x.teamIn.length)
    .sort((a, b) => b.score - a.score || (b.chat.lastMessageAt?.getTime() ?? 0) - (a.chat.lastMessageAt?.getTime() ?? 0))
    .slice(0, limit)
    .map((x) => ({
      id: x.chat.id,
      name: x.chat.name,
      participantCount: x.chat.participantCount,
      lastMessageAt: x.chat.lastMessageAt?.toISOString() ?? null,
      why: `${x.teamIn.length === 1 ? 'A team member is' : `${x.teamIn.length} team members are`} in it${x.active ? ' · active this week' : ''}`,
    }))
}

export function teamGroupCount(memberId: string): number {
  return groupsWith(memberId).length
}
