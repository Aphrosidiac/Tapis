import prisma from '../prisma.js'
import { settings } from '../settings.js'
import { startTurn, activeRun } from './run.js'

/// The nightly pass over memory. Once a day, in the quiet hours, the
/// assistant re-reads what happened — the day's conversations, its own
/// actions, what the pipeline produced — and tidies its files: merges
/// duplicates, drops what expired, writes down what it would want to know
/// tomorrow. Same loop, same tools, a thread of its own kind so it shows
/// on the panel and never mixes with the operator's.

const KEY = 'agent_reflect'
const HOUR = 3
const KEEP_THREADS = 14

let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(`[agent] ${m}`, e ?? '')
export function setReflectLogger(fn: typeof logLine) {
  logLine = fn
}

function localDateKey(d: Date, tz: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}

/// Called from the pipeline tick. Runs at most once per local day, after
/// the configured hour, and never while another run is on the thread.
export async function maybeReflect(now = new Date()): Promise<boolean> {
  const s = settings()
  if (!s.agentReflect) return false
  const { day, hour } = localDateKey(now, s.timezone)
  if (hour < HOUR) return false
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  const last = (row?.value as { day?: string } | null)?.day
  if (last === day) return false
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: { day } }, update: { value: { day } } })
  await runReflection(day)
  return true
}

export async function runReflection(day: string): Promise<string> {
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: { day } }, update: { value: { day } } })
  const thread = await prisma.agentThread.create({ data: { kind: 'reflect', title: `Nightly reflection · ${day}`, model: settings().agentModel } })
  const prompt = [
    `It is the nightly reflection for ${day}. Nobody is waiting on you; take the steps in order and keep the writing short.`,
    '',
    '1. Read your memory directory and operator.md.',
    "2. Look at yesterday's work: your conversations (sql_query over agent_threads and agent_actions for the last 36 hours — you may read agent_messages content for kind = chat), the items created or changed (list_items, list_pipeline_runs), and anything that failed.",
    '3. Update memory: merge duplicate notes, remove anything that has expired or was corrected, add what you would want to know tomorrow — a client habit, a preference the operator showed, a procedure that worked, a mistake not to repeat. Keep each file short; log.md holds at most the last 14 dated entries.',
    '4. End with a five-line note of what changed in memory. Do not send anything, do not change items or settings.',
  ].join('\n')
  try {
    await startTurn(thread.id, prompt)
  } catch (err) {
    logLine('reflection could not start', err)
  }
  // Old reflections are noise on the panel.
  const old = await prisma.agentThread.findMany({ where: { kind: 'reflect' }, orderBy: { createdAt: 'desc' }, skip: KEEP_THREADS, select: { id: true } })
  for (const t of old) if (!activeRun(t.id)) await prisma.agentThread.delete({ where: { id: t.id } }).catch(() => {})
  return thread.id
}
