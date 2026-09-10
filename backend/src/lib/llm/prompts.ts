import type { Chat, Message, Rule, Feedback } from '@prisma/client'
import { settings, LANGUAGE_NAMES } from '../settings.js'

/// Prompt text and the transcript format both models read. Short ids (m1,
/// r1) stand in for uuids inside the prompt: cheaper, and a model cannot
/// mangle a uuid it never sees.

export interface IdMap {
  toShort: Map<string, string>
  toLong: Map<string, string>
}

export function mapIds(prefix: string, ids: string[]): IdMap {
  const toShort = new Map<string, string>()
  const toLong = new Map<string, string>()
  ids.forEach((id, i) => {
    const s = `${prefix}${i + 1}`
    toShort.set(id, s)
    toLong.set(s, id)
  })
  return { toShort, toLong }
}

export function formatTime(d: Date): string {
  const tz = settings().timezone
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(d)
      .replace(',', '')
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

export function senderLabel(m: Pick<Message, 'senderName' | 'senderWaId' | 'fromMe'>): string {
  if (m.fromMe) return 'Me (the business)'
  const who = m.senderName || m.senderWaId
  return m.senderName && !m.senderWaId.startsWith('lid:') ? `${who} (${m.senderWaId})` : who
}

/// What a non-text message looks like in the transcript. Never invents
/// content: an image with no caption is exactly that.
export function messageBody(m: Message): string {
  const text = m.text?.trim()
  switch (m.type) {
    case 'TEXT':
      return text || '(empty)'
    case 'IMAGE':
      return text ? `[image] ${text}` : '[image, no caption]'
    case 'VIDEO':
      return text ? `[video] ${text}` : '[video, no caption]'
    case 'AUDIO':
      return '[voice note — not transcribed]'
    case 'DOCUMENT':
      return text ? `[document] ${text}` : '[document]'
    case 'STICKER':
      return '[sticker]'
    case 'LOCATION':
      return '[location]'
    case 'CONTACT':
      return '[contact card]'
    default:
      return text || '[unsupported message]'
  }
}

export function transcriptLine(m: Message, short?: string): string {
  const id = short ? `[${short}] ` : ''
  const quoted = m.quotedWaMessageId ? ' (replying to an earlier message)' : ''
  return `${id}${formatTime(m.sentAt)} ${senderLabel(m)}${quoted}: ${messageBody(m)}`
}

export function chatContextBlock(chat: Chat): string {
  const lines = [`Chat: ${chat.name}${chat.isGroup ? ' (group)' : ' (private chat)'}`]
  if (chat.clientName) lines.push(`Client: ${chat.clientName}`)
  if (chat.description) lines.push(`About: ${chat.description}`)
  const biz = settings().businessName
  if (biz) lines.push(`We are: ${biz}`)
  return lines.join('\n')
}

export function rulesBlock(rules: Rule[], ids: IdMap, participants: Map<string, string | null>): string {
  if (!rules.length) return '(no rules)'
  return rules
    .map((r) => {
      const who = r.senderWaIds.length
        ? ` — applies only to messages from: ${r.senderWaIds.map((w) => participants.get(w) ? `${participants.get(w)} (${w})` : w).join(', ')}`
        : ''
      const extra = r.extraAsk ? `\n    Also produce: ${r.extraAsk}` : ''
      return `${ids.toShort.get(r.id)}: ${r.text}${who}${extra}`
    })
    .join('\n')
}

export function feedbackBlock(feedback: Feedback[]): string {
  if (!feedback.length) return ''
  const rescued = feedback.filter((f) => f.kind === 'RESCUED')
  const noise = feedback.filter((f) => f.kind === 'FALSE_POSITIVE')
  const parts: string[] = []
  if (rescued.length) {
    parts.push(
      'Messages like these were dismissed before and the operator said they MATTERED — flag similar ones:\n' +
        rescued.map((f) => `  - "${f.text.slice(0, 200)}"`).join('\n'),
    )
  }
  if (noise.length) {
    parts.push(
      'Items built from messages like these were dismissed by the operator as NOISE — do not flag similar ones unless the context clearly differs:\n' +
        noise.map((f) => `  - "${f.text.slice(0, 200)}"`).join('\n'),
    )
  }
  return parts.join('\n\n')
}

export function outputLanguageName(): string {
  return LANGUAGE_NAMES[settings().outputLanguage]
}

export const FILTER_SYSTEM = `You are the first-pass filter for Tapis, a system that watches a business's WhatsApp chats and turns the real requests buried in them into tracked items.

You receive one chat's context, its tracking rules, some recent conversation for context, and a batch of NEW messages to judge. For each new message decide: could this be part of something a tracking rule asks for?

How to judge:
- Messages come in Malay, English, Chinese, or a mix in one sentence. Judge the meaning, not the language.
- Most messages are noise: greetings, "ok", "noted", "thanks", "boss", emoji, stickers, small talk, logistics like "call me". Dismiss those.
- A message counts when it states, asks for, complains about, follows up on, or adds detail to something a rule covers. Short follow-ups count too: "dah siap ke?" or "any update?" after an earlier request is part of that request.
- A message can be split across several short lines from the same sender within a minute. Judge each line, but let the neighbours inform it.
- An image or document with no caption: flag it when the surrounding messages suggest it belongs to a tracked matter (a screenshot after "got error"). A voice note cannot be heard here; flag it only when its neighbours show it is part of a tracked matter.
- Messages from "Me (the business)" are context only. Never flag them.
- Rules that name specific senders apply only to messages from those senders.
- When unsure, FLAG. A missed client complaint costs far more than a false alarm. The second pass will double-check.

Return exactly one decision per new message id, with a short reason (a few words, in English) and the ids of the rules it may match (empty if none — you may still flag it with an empty list when it looks important).`

export const ANALYZE_SYSTEM = `You are the analyst for Tapis, a system that watches a business's WhatsApp chats and turns real client requests, complaints, bug reports and change requests into tracked items.

You receive one chat's context, its tracking rules, the items already open for this chat, a set of flagged messages quoted exactly as sent (with the first-pass filter's reason), and the surrounding conversation.

Decide what to do with the flagged messages. Produce a list of actions:
- "attach": the message is about an issue already in the open items list — a follow-up ("is this done yet?"), a status check, more detail, or a repeat of the same request. Give the item id, the kind of attachment, and a one-line note (in the output language) saying what the message adds.
- "create": the messages describe an issue that is NOT in the open items list. Combine every flagged message about the same issue into ONE item. Several requests in one breath about the same feature are one item; two unrelated problems are two.
- "ignore": on reflection the message is not actionable under any rule. Give the reason in the note.
Every flagged message id must appear in exactly one action.

For a created item write, in the output language named below:
- title: one clear line, specific enough to tell items apart.
- brief: what the client actually wants or is unhappy about, in plain words, 1–3 sentences. Say who asked. Do not pad.
- suggestion: concrete next steps for the business — what to build, check, reply, or decide. 1–4 sentences or short lines.
- priority: URGENT only for outages, lost money, or an angry client; HIGH for blocking problems; NORMAL for ordinary requests; LOW for nice-to-haves.
- ruleIds: the rules this item satisfies.
- extra: when a matched rule says "Also produce: …", answer it as label/value pairs. Otherwise an empty list.

Never invent facts. The original messages are attached to the item by the system; you do not need to quote them. If something is unclear, say so in the brief rather than guessing.`
