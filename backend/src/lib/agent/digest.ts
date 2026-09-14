import prisma from '../prisma.js'
import { settings } from '../settings.js'
import { startTurn, subscribe } from './run.js'
import { baileysReady, sendText } from '../whatsapp/baileys.js'
import { operatorNumber, assertOperatorNumber } from './guard.js'

/// The morning brief. Once a day, after the configured hour, the assistant
/// writes what needs the operator today — in its own thread, read-only in
/// practice because the prompt says so — and the text goes to the
/// operator's WhatsApp. The send is the harness's, not the model's: no
/// outward tool is involved, so nothing waits for an approval nobody is
/// awake to give.

const KEY = 'agent_digest'

let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(`[agent] ${m}`, e ?? '')
export function setDigestLogger(fn: typeof logLine) {
  logLine = fn
}

function local(d: Date, tz: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}

export async function maybeDigest(now = new Date()): Promise<boolean> {
  const s = settings()
  if (!s.agentDigest || !operatorNumber()) return false
  const { day, hour } = local(now, s.timezone)
  if (hour < s.agentDigestHour) return false
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  if ((row?.value as { day?: string } | null)?.day === day) return false
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: { day } }, update: { value: { day } } })
  await runDigest(day)
  return true
}

/// Writes the brief and sends it. Resolves when the WhatsApp is queued or
/// the run failed; the thread stays on the panel either way.
export async function runDigest(day: string): Promise<{ threadId: string; sent: boolean }> {
  const s = settings()
  // A manual run counts as today's, so the scheduler does not send a second.
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: { day } }, update: { value: { day } } })
  const thread = await prisma.agentThread.create({ data: { kind: 'digest', title: `Morning brief · ${day}`, model: s.agentModel } })
  const prompt = [
    `Write the morning brief for ${day}, to be sent as one WhatsApp message to the operator.`,
    'Check the state and the open items (chasing, left sitting, urgent), the failures, and anything that arrived overnight. Read memory for how the operator wants things.',
    'Then write ONLY the message, nothing before or after it: under 1200 characters, plain text (no markdown, no headings), short lines, the most urgent thing first, each open item on one line with who is waiting and what is needed. If nothing needs attention, say so in one line. Do not change anything and do not send anything yourself.',
  ].join('\n')
  const text = await new Promise<string>(async (resolve) => {
    let last = ''
    try {
      await startTurn(thread.id, prompt)
    } catch (err) {
      logLine('digest could not start', err)
      return resolve('')
    }
    const off = subscribe(thread.id, 0, (_, e) => {
      if (e.type === 'message' && e.message.role === 'assistant' && 'text' in e.message.content && e.message.content.text) last = e.message.content.text
      if (e.type === 'done' || e.type === 'error') {
        off?.()
        resolve(last)
      }
    })
    if (!off) resolve('')
  })
  const body = text.trim()
  if (!body) return { threadId: thread.id, sent: false }
  if (!baileysReady()) {
    logLine('digest written but WhatsApp is not connected; not sent')
    return { threadId: thread.id, sent: false }
  }
  try {
    const to = assertOperatorNumber(operatorNumber())
    await sendText(to, body.slice(0, 3500))
    logLine(`morning brief sent to +${to}`)
    return { threadId: thread.id, sent: true }
  } catch (err) {
    logLine('morning brief could not be sent', err)
    return { threadId: thread.id, sent: false }
  }
}
