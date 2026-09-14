import prisma from '../prisma.js'
import { cutBundles, processBundle, setPipelineLogger } from './bundle.js'
import { sendPendingDeliveries } from './deliver.js'
import { maybeReflect } from '../agent/reflect.js'
import { maybeDigest } from '../agent/digest.js'

/// The clock. One tick every few seconds: cut bundles that are due, run
/// each through the two passes, send whatever is queued for WhatsApp.
/// Bundles run one at a time so the model calls never stampede.

const TICK_MS = Number(process.env.PIPELINE_TICK_MS) || 10_000

let timer: NodeJS.Timeout | null = null
let running = false
let lastTickAt: Date | null = null
let lastError: string | null = null
let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(`[pipeline] ${m}`, e ?? '')

export function startScheduler(log?: typeof logLine) {
  if (log) {
    logLine = log
    setPipelineLogger(log)
  }
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref?.()
  void tick()
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

export function schedulerStatus() {
  return { running, lastTickAt: lastTickAt?.toISOString() ?? null, lastError, tickMs: TICK_MS }
}

export async function tick(opts: { force?: boolean; chatId?: string } = {}): Promise<{ cut: number; processed: number; sent: number }> {
  if (running) return { cut: 0, processed: 0, sent: 0 }
  running = true
  lastTickAt = new Date()
  const out = { cut: 0, processed: 0, sent: 0 }
  try {
    const cut = await cutBundles(opts)
    out.cut = cut.length
    // Anything left half-done by a crash or an earlier failure with a key
    // now present is picked up too.
    const due = await prisma.bundle.findMany({
      where: { status: { in: ['FILTERING', 'ANALYZING'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: 10,
    })
    for (const b of due) {
      await processBundle(b.id)
      out.processed += 1
    }
    out.sent = await sendPendingDeliveries(logLine)
    if (!opts.force) {
      await maybeReflect().catch((err) => logLine('nightly reflection failed', err))
      await maybeDigest().catch((err) => logLine('morning brief failed', err))
    }
    lastError = null
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    logLine('tick failed', err)
  } finally {
    running = false
  }
  return out
}
