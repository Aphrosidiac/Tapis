import prisma from '../prisma.js'
import { settings } from '../settings.js'
import type { ParsedInbound } from '../whatsapp/inbound.js'
import { meInfo, sendText } from '../whatsapp/baileys.js'
import { startTurn, stopRun, activeRun, subscribe, approveAction, declineAction, type AgentEvent } from './run.js'
import { operatorNumber, assertOperatorNumber } from './guard.js'

/// The assistant over WhatsApp. One door: the operator messages their own
/// number (WhatsApp's "You" chat) on the linked account, and the answer
/// comes back there as plain text from the same account. The number is the
/// one on Settings — the only number the assistant may ever message (see
/// guard.ts) — so nothing here can reach anyone else. Nothing in this chat
/// reaches the pipeline: not stored, not judged.
///
/// Outward actions still park. The reply carries a four-digit code; "YES
/// 4821" runs it, "NO 4821" declines, a bare "yes"/"no" acts on the one
/// pending action when there is exactly one.

const CONTROL_KIND = 'whatsapp'
const REPLY_MAX = 3500
const sentIds = new Set<string>()
const codes = new Map<string, { actionId: string; threadId: string; number: string }>()

let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(`[agent] ${m}`, e ?? '')
export function setControlLogger(fn: typeof logLine) {
  logLine = fn
}

function remember(id: string | null) {
  if (!id) return
  sentIds.add(id)
  if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value as string)
}

/// Returns true when the message was a control message (handled or
/// deliberately ignored), so ingest must not store it.
const CONTROL_MAX_AGE_MS = 15 * 60_000

export async function handleControlMessage(parsed: ParsedInbound): Promise<boolean> {
  const s = settings()
  if (!s.agentWhatsapp || parsed.isGroup) return false
  const me = meInfo()?.id
  const number = parsed.chatJid.split('@')[0]
  // The self chat, and only when the linked account IS the operator's
  // number: a link on someone else's phone gets no control channel.
  const selfChat = !!me && parsed.chatJid === `${me}@s.whatsapp.net` && me === operatorNumber()
  if (!selfChat) return false
  // Our own replies come back through the socket as fromMe too.
  if (sentIds.has(parsed.waMessageId)) return true
  if (!parsed.fromMe) return true
  // An instruction typed while the link was down arrives with the backlog,
  // hours or days late. Running it then is a surprise, not a service.
  if (Date.now() - parsed.timestamp.getTime() > CONTROL_MAX_AGE_MS) {
    logLine(`ignoring an instruction from ${parsed.timestamp.toISOString()}: it arrived after the link was down`)
    return true
  }

  const reply = async (body: string) => {
    try {
      remember(await sendText(assertOperatorNumber(number), body.slice(0, REPLY_MAX)))
    } catch (err) {
      logLine(`could not reply on WhatsApp to +${number}`, err)
    }
  }

  if (parsed.type !== 'TEXT' || !parsed.text?.trim()) {
    await reply('Text only for now — type what you want me to do.')
    return true
  }
  const text = parsed.text.trim()

  // ── Commands ──
  if (/^(new|baru|reset)$/i.test(text)) {
    await prisma.agentThread.create({ data: { kind: CONTROL_KIND, title: `WhatsApp · +${number}`, model: s.agentModel } })
    await reply('Fresh conversation. What do you need?')
    return true
  }
  if (/^stop$/i.test(text)) {
    const t = await controlThread(number, s.agentModel)
    await reply(stopRun(t.id) ? 'Stopped.' : 'Nothing was running.')
    return true
  }
  const decision = /^(yes|ya|ok|approve|no|tak|decline)\b\s*(\d{4})?$/i.exec(text)
  if (decision) {
    const approve = /^(yes|ya|ok|approve)$/i.test(decision[1])
    const code = decision[2]
    let target = code ? codes.get(code) : null
    if (!target && !code) {
      const t = await controlThread(number, s.agentModel)
      const pending = await prisma.agentAction.findMany({ where: { threadId: t.id, status: 'pending' } })
      if (pending.length === 1) target = { actionId: pending[0].id, threadId: t.id, number }
      else if (pending.length > 1) {
        await reply(`There are ${pending.length} things waiting. Reply with the code, e.g. YES ${[...codes.entries()].find(([, v]) => v.threadId === t.id)?.[0] ?? '1234'}.`)
        return true
      }
    }
    if (!target) {
      await reply(code ? `No pending action with code ${code}.` : 'Nothing is waiting for a decision.')
      return true
    }
    if (activeRun(target.threadId)) {
      await reply('Still working — try again in a moment.')
      return true
    }
    for (const [k, v] of codes) if (v.actionId === target.actionId) codes.delete(k)
    try {
      if (approve) await approveAction(target.actionId)
      else await declineAction(target.actionId, 'declined over WhatsApp')
    } catch (err) {
      await reply(`Could not ${approve ? 'approve' : 'decline'}: ${err instanceof Error ? err.message : String(err)}`)
      return true
    }
    // The thread resumed; relay what it says next.
    relay(target.threadId, number, reply)
    return true
  }

  // ── A message for the assistant ──
  const thread = await controlThread(number, s.agentModel)
  if (activeRun(thread.id)) {
    await reply('Still working on your last message — reply "stop" to cancel it.')
    return true
  }
  try {
    await startTurn(thread.id, text)
  } catch (err) {
    await reply(`Could not start: ${err instanceof Error ? err.message : String(err)}`)
    return true
  }
  relay(thread.id, number, reply)
  return true
}

/// The current thread for a number: the most recent of its kind, created
/// on first contact.
async function controlThread(number: string, model: string) {
  const title = `WhatsApp · +${number}`
  const existing = await prisma.agentThread.findFirst({ where: { kind: CONTROL_KIND, title }, orderBy: { createdAt: 'desc' } })
  return existing ?? prisma.agentThread.create({ data: { kind: CONTROL_KIND, title, model } })
}

/// Watches a run and sends its outcome: the final answer as plain text,
/// and a coded prompt for each action that parks.
function relay(threadId: string, number: string, reply: (body: string) => Promise<void>) {
  let last = ''
  const off = subscribe(threadId, 0, (_, e: AgentEvent) => {
    if (e.type === 'message' && e.message.role === 'assistant' && 'text' in e.message.content && e.message.content.text) last = e.message.content.text
    if (e.type === 'approval') {
      const code = String(Math.floor(1000 + Math.random() * 9000))
      codes.set(code, { actionId: e.action.id, threadId, number })
      void reply(`⚠️ Needs your OK: ${e.action.summary ?? e.action.tool}\n\nReply YES ${code} to do it, or NO ${code}.`)
    }
    if (e.type === 'done') {
      off?.()
      if (last) void reply(plain(last))
    }
    if (e.type === 'error') {
      off?.()
      void reply(`Something went wrong: ${String(e.message).slice(0, 300)}`)
    }
  })
}

/// Markdown to something WhatsApp shows well: bold kept as WhatsApp bold,
/// headings as bold lines, tables as rows, code and links unwrapped.
export function plain(md: string): string {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1')
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/^\s*\|?\s*:?-{2,}[-|: ]*$/gm, '')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' — '))
    .replace(/^\s*[-*•]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
