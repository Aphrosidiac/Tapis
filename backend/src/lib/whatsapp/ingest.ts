import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import prisma from '../prisma.js'
import { MEDIA_DIR } from '../paths.js'
import { mediaReadable } from '../llm/media.js'
import { isTeam } from '../team.js'
import type { ParsedInbound } from './inbound.js'

/// Where an inbound message goes once parsed. Two rules:
///  1. An untracked chat keeps nothing but its name and when it last spoke.
///     "Everything not selected is ignored completely" is a promise, and
///     the row count in `messages` is how it is kept.
///  2. The text stored is the text sent. Nothing here rewrites it.

let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(m, e ?? '')
export function setIngestLogger(fn: typeof logLine) {
  logLine = fn
}

export interface DiscoveredChat {
  jid: string
  name: string | null
  isGroup: boolean
  participantCount?: number | null
  lastMessageAt?: Date | null
}

/// Remembers a saved contact name, and gives it to the chat if one exists.
///
/// Stored whether or not a chat exists yet: the app-state sync that carries
/// the address book runs BEFORE the history sync creates the chats, so
/// anything applied only to existing rows is thrown away.
export async function rememberContact(jid: string, name: string): Promise<void> {
  const clean = name.trim()
  if (!jid || !clean) return
  await prisma.contact.upsert({ where: { jid }, create: { jid, name: clean }, update: { name: clean } })
  const chat = await prisma.chat.findUnique({ where: { jid } })
  if (chat && isFallbackName(chat.name)) await prisma.chat.update({ where: { id: chat.id }, data: { name: clean } })
}

/// Applies every known contact name to the chats still carrying a fallback.
/// Used after an address-book resync, when the names arrive long after the
/// chats they belong to.
export async function applyContactNames(): Promise<number> {
  const contacts = await prisma.contact.findMany()
  let applied = 0
  for (const c of contacts) {
    const chat = await prisma.chat.findUnique({ where: { jid: c.jid } })
    if (!chat || !isFallbackName(chat.name)) continue
    await prisma.chat.update({ where: { id: chat.id }, data: { name: c.name } })
    applied += 1
  }
  return applied
}

function fallbackName(jid: string): string {
  if (jid.endsWith('@g.us')) return `Group ${jid.split('@')[0].slice(-6)}`
  if (jid.endsWith('@lid')) return `Unknown contact (${jid.split('@')[0].slice(-6)})`
  return `+${jid.split('@')[0]}`
}

function isFallbackName(name: string): boolean {
  return name.startsWith('Group ') || name.startsWith('Unknown contact') || name.startsWith('+')
}

/// Upserts the chat's identity. A real name never gets overwritten by a
/// fallback one; a fallback is replaced the moment a real one appears.
export async function discoverChat(d: DiscoveredChat) {
  const existing = await prisma.chat.findUnique({ where: { jid: d.jid } })
  // A saved contact name beats anything the chat record carries: WhatsApp
  // shows you the name you gave someone, not their push name.
  const saved = d.isGroup ? null : (await prisma.contact.findUnique({ where: { jid: d.jid } }))?.name ?? null
  const incoming = saved || d.name?.trim() || null
  if (!existing) {
    return prisma.chat.create({
      data: {
        jid: d.jid,
        name: incoming || fallbackName(d.jid),
        isGroup: d.isGroup,
        participantCount: d.participantCount ?? null,
        lastSeenAt: new Date(),
        lastMessageAt: d.lastMessageAt ?? null,
      },
    })
  }
  const name = incoming && (isFallbackName(existing.name) || d.isGroup) ? incoming : existing.name
  return prisma.chat.update({
    where: { id: existing.id },
    data: {
      name,
      lastSeenAt: new Date(),
      ...(d.participantCount !== undefined && d.participantCount !== null ? { participantCount: d.participantCount } : {}),
      ...(d.lastMessageAt && (!existing.lastMessageAt || d.lastMessageAt > existing.lastMessageAt)
        ? { lastMessageAt: d.lastMessageAt }
        : {}),
    },
  })
}

export type MediaDownloader = (parsed: ParsedInbound) => Promise<{ buffer: Buffer; mime: string; ext: string } | null>

export interface IngestResult {
  stored: boolean
  reason: string
  messageId?: string
  chatId?: string
}

export async function handleInbound(parsed: ParsedInbound, download?: MediaDownloader, simulated = false): Promise<IngestResult> {
  const chat = await discoverChat({
    jid: parsed.chatJid,
    name: parsed.isGroup ? null : parsed.fromMe ? null : parsed.senderName,
    isGroup: parsed.isGroup,
    lastMessageAt: parsed.timestamp,
  })

  if (!chat.tracked) {
    return { stored: false, reason: 'chat is not tracked', chatId: chat.id }
  }
  if (chat.trackedSince && parsed.timestamp < chat.trackedSince && !simulated) {
    return { stored: false, reason: 'sent before tracking was switched on', chatId: chat.id }
  }

  const dup = await prisma.message.findUnique({
    where: { chatId_waMessageId: { chatId: chat.id, waMessageId: parsed.waMessageId } },
    select: { id: true },
  })
  if (dup) return { stored: false, reason: 'already stored', chatId: chat.id, messageId: dup.id }

  if (!parsed.fromMe) {
    await prisma.participant.upsert({
      where: { chatId_waId: { chatId: chat.id, waId: parsed.senderWaId } },
      create: { chatId: chat.id, waId: parsed.senderWaId, name: parsed.senderName, messageCount: 1 },
      update: {
        ...(parsed.senderName ? { name: parsed.senderName } : {}),
        messageCount: { increment: 1 },
        lastSeenAt: new Date(),
      },
    })
  }

  let mediaPath: string | null = null
  let mediaMime: string | null = null
  if (parsed.hasMedia && download) {
    try {
      const media = await download(parsed)
      if (media) {
        const dir = join(MEDIA_DIR, chat.id)
        await mkdir(dir, { recursive: true })
        const safeId = parsed.waMessageId.replace(/[^A-Za-z0-9_-]/g, '_')
        mediaPath = join(dir, `${safeId}.${media.ext}`)
        await writeFile(mediaPath, media.buffer)
        mediaMime = media.mime
      }
    } catch (err) {
      logLine(`could not download media for ${parsed.waMessageId}`, err)
    }
  }

  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      waMessageId: parsed.waMessageId,
      senderWaId: parsed.senderWaId,
      senderName: parsed.senderName,
      fromMe: parsed.fromMe,
      type: parsed.type,
      text: parsed.text,
      mediaPath,
      mediaMime,
      // Read before it is judged — see lib/llm/media.ts.
      mediaTextStatus: mediaPath && mediaReadable(parsed.type, mediaMime) ? 'PENDING' : 'NONE',
      quotedWaMessageId: parsed.quotedWaMessageId,
      sentAt: parsed.timestamp,
      simulated,
      // Our own messages — from this phone or from anyone on the team
      // roster — are context, never candidates.
      filterStatus: parsed.fromMe || isTeam(parsed.senderWaId) ? 'SKIPPED' : 'PENDING',
      filterReason: parsed.fromMe ? 'Sent by us' : isTeam(parsed.senderWaId) ? 'Sent by our team' : null,
    },
  })

  await prisma.chat.update({ where: { id: chat.id }, data: { lastMessageAt: parsed.timestamp } })
  return { stored: true, reason: 'stored', chatId: chat.id, messageId: message.id }
}
