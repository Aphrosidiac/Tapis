import type { z } from 'zod'

/// A stand-in for the model, for development only. Keyword heuristics, no
/// network, no cost. It exists so the pipeline's mechanics — bundling, items,
/// follow-ups, deliveries, rescue — can be exercised on a machine with no API
/// credit. Its briefs say MOCK in capitals so nobody mistakes them for
/// analysis. Never offered in production.

const NOISE = /^(ok|okay|okey|oke|noted|noted\.|thanks|thank you|tq|ty|boss|hi|hello|hey|yes|no|ya|yup|sure|good|nice|great|done|👍|🙏|ok noted|ok noted thanks|noted thanks|ok thanks|baik|terima kasih|好的|谢谢|收到)[.!\s]*$/i
const SIGNAL = /(boleh|tambah|nak|mahu|minta|request|bug|error|tak boleh|cannot|can't|cant|please|tolong|\?|invoice|payment|bayar|complain|slow|lambat|siap|update|export|add|fix|rosak|broken|not working|masalah|problem|issue|change|tukar|when|bila|问题|可以|需要|加|报错|不能|什么时候|发票|付款)/i

export function mockFilter(text: string, batch: { id: string; text: string | null; type: string }[], rules: { id: string; text: string }[]) {
  const decisions = batch.map((m) => {
    const t = (m.text ?? '').trim()
    if (m.type !== 'TEXT') return { id: m.id, flag: false, reason: 'mock: non-text message', ruleIds: [] as string[] }
    if (!t || NOISE.test(t)) return { id: m.id, flag: false, reason: 'mock: acknowledgement / greeting', ruleIds: [] as string[] }
    if (SIGNAL.test(t) || t.length > 60) return { id: m.id, flag: true, reason: 'mock: request-like wording', ruleIds: rules.slice(0, 1).map((r) => r.id) }
    return { id: m.id, flag: false, reason: 'mock: no request wording', ruleIds: [] as string[] }
  })
  void text
  return { decisions }
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/)
      .filter((w) => w.length >= 5),
  )
}

export function mockAnalyze(
  flagged: { id: string; text: string | null; senderName: string | null }[],
  openItems: { id: string; title: string; brief: string }[],
  rules: { id: string }[],
) {
  const actions: Record<string, unknown>[] = []
  const remaining: typeof flagged = []
  const statusCheck = /(siap|done|update|boleh ke|dah|sudah|ready|status|any news|bila|when|怎么样|好了吗)/i
  for (const m of flagged) {
    const w = words(m.text ?? '')
    const hit = openItems.find((i) => [...words(`${i.title} ${i.brief}`)].some((x) => w.has(x)))
    if (hit) {
      actions.push({
        kind: 'attach',
        messageIds: [m.id],
        itemId: hit.id,
        attachKind: statusCheck.test(m.text ?? '') ? 'STATUS_CHECK' : 'DETAIL',
        teamStatus: 'NONE',
        teamNote: '',
        note: `MOCK: ${m.senderName ?? 'Someone'} wrote about this again: "${(m.text ?? '').slice(0, 80)}"`,
        title: '',
        brief: '',
        suggestion: '',
        priority: 'NORMAL',
        ruleIds: [],
        extra: [],
      })
    } else remaining.push(m)
  }
  if (remaining.length) {
    const longest = remaining.reduce((a, b) => ((b.text?.length ?? 0) > (a.text?.length ?? 0) ? b : a), remaining[0])
    actions.push({
      kind: 'create',
      messageIds: remaining.map((m) => m.id),
      itemId: '',
      attachKind: 'NONE',
      teamStatus: 'NONE',
      teamNote: '',
      note: '',
      title: `MOCK: ${(longest.text ?? 'Untitled').slice(0, 90)}`,
      brief: `MOCK ANALYSIS — no model was called. ${remaining.map((m) => `${m.senderName ?? 'Someone'} wrote "${(m.text ?? '').slice(0, 120)}"`).join('; ')}.`,
      suggestion: 'MOCK: read the original messages and decide. Switch the provider to Anthropic or OpenRouter for real analysis.',
      priority: 'NORMAL',
      ruleIds: rules.slice(0, 1).map((r) => r.id),
      extra: [],
    })
  }
  return { actions }
}

/// The mock answers whichever schema it is handed by shape.
export function mockCall<T>(schema: z.ZodType<T>, produce: () => unknown): T {
  const check = schema.safeParse(produce())
  if (!check.success) throw new Error(`mock output did not match the schema: ${check.error.issues[0]?.message}`)
  return check.data
}
