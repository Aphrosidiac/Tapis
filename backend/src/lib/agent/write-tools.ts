import { z } from 'zod'
import prisma from '../prisma.js'
import { defineTool, audited, clip } from './tools.js'
import { setTeam } from '../team.js'
import { tick } from '../pipeline/scheduler.js'
import { retryBundle, rescueMessage } from '../pipeline/bundle.js'
import { rereadMedia } from '../llm/media.js'
import { translateOne } from '../llm/translate.js'
import { saveSettings, settings, type Settings } from '../settings.js'
import { formatNewItem } from '../pipeline/deliver.js'
import { baileysReady, sendText, stop as stopWhatsApp, start as startWhatsApp } from '../whatsapp/baileys.js'
import { isUsableWaId } from '../input.js'
import { assertOperatorNumber, isOperatorNumber, operatorNumber, assertNoOutsideDeliveries } from './guard.js'

/// What the assistant can change. Every write is recorded with what it
/// found and what it left, and reversed from that record; the ones that
/// leave the box or spend real money wait for the operator.

const WHO = 'Assistant'

// ── Items ────────────────────────────────────────────────────────────────

const ItemPatch = z.object({
  itemId: z.string(),
  status: z.enum(['NEW', 'IN_PROGRESS', 'DONE', 'DISMISSED']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  title: z.string().min(1).max(200).optional(),
  note: z.string().min(1).max(2000).optional().describe('A note added to the item timeline, attributed to the assistant'),
})

defineTool({
  name: 'update_item',
  tier: 'write',
  description:
    'Change an item: move its status (NEW → IN_PROGRESS → DONE, or DISMISSED for a false alarm), set its priority, rename it, or add a note to its timeline. Dismissing teaches the filter that the original messages were noise. Undoable.',
  schema: ItemPatch,
  summarize: (i) => `Update item ${i.itemId.slice(0, 8)}: ${[i.status && `status → ${i.status}`, i.priority && `priority → ${i.priority}`, i.title && 'rename', i.note && 'note'].filter(Boolean).join(', ')}`,
  run: async (input) => {
    const existing = await prisma.item.findUnique({ where: { id: input.itemId }, include: { messages: { select: { messageId: true, kind: true } } } })
    if (!existing) return { error: 'No item with that id' }
    const before = { status: existing.status, priority: existing.priority, title: existing.title }
    const data: Record<string, unknown> = {}
    const events: { kind: 'STATUS' | 'NOTE'; detail: string }[] = []
    if (input.status && input.status !== existing.status) {
      data.status = input.status
      events.push({ kind: 'STATUS', detail: `${WHO} moved it from ${existing.status.replace('_', ' ').toLowerCase()} to ${input.status.replace('_', ' ').toLowerCase()}` })
      if (input.status === 'DISMISSED') {
        const origins = await prisma.message.findMany({ where: { id: { in: existing.messages.filter((m) => m.kind === 'ORIGIN').map((m) => m.messageId) } } })
        if (origins.length) {
          await prisma.feedback.createMany({
            data: origins.map((m) => ({ chatId: existing.chatId, messageId: m.id, kind: 'FALSE_POSITIVE' as const, text: (m.text || (m.mediaTextStatus === 'DONE' && m.mediaText) || `[${m.type.toLowerCase()}]`).slice(0, 500) })),
          })
        }
      }
    }
    if (input.priority && input.priority !== existing.priority) {
      data.priority = input.priority
      events.push({ kind: 'STATUS', detail: `${WHO} set priority to ${input.priority.toLowerCase()}` })
    }
    if (input.title && input.title !== existing.title) data.title = input.title
    if (input.note) events.push({ kind: 'NOTE', detail: `${WHO}: ${input.note}` })
    if (!Object.keys(data).length && !events.length) return { result: 'Nothing to change', itemId: existing.id }
    const item = await prisma.item.update({ where: { id: input.itemId }, data: { ...data, events: { create: events } } })
    const after = { status: item.status, priority: item.priority, title: item.title }
    return audited({ ok: true, itemId: item.id, ...after }, before, after)
  },
  undo: async ({ input, before }) => {
    const b = before as { status: string; priority: string; title: string }
    await prisma.item.update({
      where: { id: input.itemId },
      data: { status: b.status as never, priority: b.priority as never, title: b.title, events: { create: { kind: 'STATUS', detail: `${WHO}'s change was undone by the operator` } } },
    })
    return `Item restored to ${b.status}, ${b.priority}`
  },
})

// ── Chats and rules ──────────────────────────────────────────────────────

defineTool({
  name: 'set_chat',
  tier: 'write',
  description: 'Change a chat: switch tracking on or off, set the client name (items group by it on the dashboard), or rewrite the description the models read before every message. Undoable.',
  schema: z.object({
    chatId: z.string(),
    tracked: z.boolean().optional(),
    clientName: z.string().max(200).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
  }),
  summarize: (i) => `Set chat ${i.chatId.slice(0, 8)}: ${[i.tracked !== undefined && `tracked → ${i.tracked}`, i.clientName !== undefined && `client → ${i.clientName ?? '(none)'}`, i.description !== undefined && 'description'].filter(Boolean).join(', ')}`,
  run: async (input) => {
    const chat = await prisma.chat.findUnique({ where: { id: input.chatId } })
    if (!chat) return { error: 'No chat with that id' }
    const before = { tracked: chat.tracked, clientName: chat.clientName, description: chat.description, trackedSince: chat.trackedSince }
    const data: Record<string, unknown> = {}
    if (input.tracked !== undefined && input.tracked !== chat.tracked) {
      if (input.tracked) await assertNoOutsideDeliveries(chat.id)
      data.tracked = input.tracked
      if (input.tracked) data.trackedSince = new Date()
    }
    if (input.clientName !== undefined) data.clientName = input.clientName?.trim() || null
    if (input.description !== undefined) data.description = input.description?.trim() || null
    if (!Object.keys(data).length) return { result: 'Nothing to change' }
    const updated = await prisma.chat.update({ where: { id: input.chatId }, data })
    const after = { tracked: updated.tracked, clientName: updated.clientName, description: updated.description, trackedSince: updated.trackedSince }
    return audited({ ok: true, chat: { id: updated.id, name: updated.name, ...after } }, before, after)
  },
  undo: async ({ input, before }) => {
    const b = before as { tracked: boolean; clientName: string | null; description: string | null; trackedSince: Date | null }
    await prisma.chat.update({ where: { id: input.chatId }, data: { tracked: b.tracked, clientName: b.clientName, description: b.description, trackedSince: b.trackedSince } })
    return 'Chat settings restored'
  },
})

const RuleFields = {
  text: z.string().min(1).max(1000).describe('Plain language: "Track feature requests from this group"'),
  extraAsk: z.string().max(1000).nullable().optional().describe('Something extra the analysis should produce for matches, e.g. "estimated effort"'),
  senderWaIds: z.array(z.string()).optional().describe('Restrict to these senders (wa ids from get_chat). Empty = whole chat.'),
  toDashboard: z.boolean().optional().describe('Default true'),
  toWhatsapp: z.array(z.string()).optional().describe('WhatsApp numbers (international digits) to send matches to'),
}

defineTool({
  name: 'create_rule',
  tier: 'write',
  description: 'Add a tracking rule to a chat. Results must go somewhere: the dashboard (default), WhatsApp numbers, or both. Undoable (the rule is removed).',
  schema: z.object({ chatId: z.string(), ...RuleFields }),
  summarize: (i) => `Add rule to chat ${i.chatId.slice(0, 8)}: "${clip(i.text, 60)}"`,
  run: async (input) => {
    const chat = await prisma.chat.findUnique({ where: { id: input.chatId }, select: { id: true } })
    if (!chat) return { error: 'No chat with that id' }
    const toWhatsapp = (input.toWhatsapp ?? []).map((n) => n.replace(/[^0-9]/g, ''))
    const bad = toWhatsapp.find((n) => !isUsableWaId(n))
    if (bad !== undefined) return { error: `"${bad}" is not a WhatsApp number (international digits, e.g. 60123456789)` }
    const other = toWhatsapp.find((n) => !isOperatorNumber(n))
    if (other !== undefined) return { error: `A rule written by the assistant may only send to the operator's own number (+${operatorNumber() || 'not set'}), not +${other}. The operator can add other numbers on the Chats screen.` }
    const toDashboard = input.toDashboard ?? true
    if (!toDashboard && !toWhatsapp.length) return { error: 'Results must go somewhere: the dashboard, a WhatsApp number, or both' }
    const rule = await prisma.rule.create({
      data: { chatId: input.chatId, text: input.text.trim(), extraAsk: input.extraAsk?.trim() || null, senderWaIds: [...new Set(input.senderWaIds ?? [])], toDashboard, toWhatsapp: [...new Set(toWhatsapp)] },
    })
    return audited({ ok: true, rule: { id: rule.id, text: rule.text } }, null, { ruleId: rule.id })
  },
  undo: async ({ after }) => {
    await prisma.rule.deleteMany({ where: { id: (after as { ruleId: string }).ruleId } })
    return 'Rule removed'
  },
})

defineTool({
  name: 'update_rule',
  tier: 'write',
  description: 'Change a rule: its wording, who it applies to, where results go, or switch it off (active=false) without deleting it. Undoable.',
  schema: z.object({ ruleId: z.string(), active: z.boolean().optional(), ...Object.fromEntries(Object.entries(RuleFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) as { [K in keyof typeof RuleFields]: z.ZodOptional<(typeof RuleFields)[K]> } }),
  summarize: (i) => `Update rule ${i.ruleId.slice(0, 8)}`,
  run: async (input) => {
    const rule = await prisma.rule.findUnique({ where: { id: input.ruleId } })
    if (!rule) return { error: 'No rule with that id' }
    const before = { text: rule.text, extraAsk: rule.extraAsk, senderWaIds: rule.senderWaIds, toDashboard: rule.toDashboard, toWhatsapp: rule.toWhatsapp, active: rule.active }
    const toWhatsapp = input.toWhatsapp ? input.toWhatsapp.map((n) => n.replace(/[^0-9]/g, '')) : rule.toWhatsapp
    const bad = toWhatsapp.find((n) => !isUsableWaId(n))
    if (bad !== undefined) return { error: `"${bad}" is not a WhatsApp number` }
    if (input.toWhatsapp) {
      const other = toWhatsapp.find((n) => !isOperatorNumber(n) && !rule.toWhatsapp.includes(n))
      if (other !== undefined) return { error: `The assistant may not add +${other} as a destination; only the operator's own number (+${operatorNumber() || 'not set'}). The operator can do it on the Chats screen.` }
    }
    if (input.active === true && !rule.active && toWhatsapp.some((n) => !isOperatorNumber(n))) {
      return { error: `Refused: switching this rule on would send its matches to +${toWhatsapp.find((n) => !isOperatorNumber(n))}. The assistant may only cause messages to the operator's own number; the operator can switch it on from the Chats screen.` }
    }
    const toDashboard = input.toDashboard ?? rule.toDashboard
    if (!toDashboard && !toWhatsapp.length) return { error: 'Results must go somewhere: the dashboard, a WhatsApp number, or both' }
    const updated = await prisma.rule.update({
      where: { id: input.ruleId },
      data: {
        ...(input.text ? { text: input.text.trim() } : {}),
        ...(input.extraAsk !== undefined ? { extraAsk: input.extraAsk?.trim() || null } : {}),
        ...(input.senderWaIds ? { senderWaIds: [...new Set(input.senderWaIds)] } : {}),
        toDashboard,
        toWhatsapp: [...new Set(toWhatsapp)],
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    })
    const after = { text: updated.text, extraAsk: updated.extraAsk, senderWaIds: updated.senderWaIds, toDashboard: updated.toDashboard, toWhatsapp: updated.toWhatsapp, active: updated.active }
    return audited({ ok: true, rule: { id: updated.id, ...after } }, before, after)
  },
  undo: async ({ input, before }) => {
    await prisma.rule.update({ where: { id: input.ruleId }, data: before as object })
    return 'Rule restored'
  },
})

defineTool({
  name: 'delete_rule',
  tier: 'write',
  description: 'Delete a rule. Items it produced stay. Undoable (the rule is put back with the same id).',
  schema: z.object({ ruleId: z.string() }),
  summarize: (i) => `Delete rule ${i.ruleId.slice(0, 8)}`,
  run: async ({ ruleId }) => {
    const rule = await prisma.rule.findUnique({ where: { id: ruleId } })
    if (!rule) return { error: 'No rule with that id' }
    await prisma.rule.delete({ where: { id: ruleId } })
    return audited({ ok: true, deleted: rule.text }, rule, null)
  },
  undo: async ({ before }) => {
    const r = before as { id: string; chatId: string; text: string; extraAsk: string | null; senderWaIds: string[]; toDashboard: boolean; toWhatsapp: string[]; active: boolean; createdAt: string }
    await prisma.rule.create({ data: { id: r.id, chatId: r.chatId, text: r.text, extraAsk: r.extraAsk, senderWaIds: r.senderWaIds, toDashboard: r.toDashboard, toWhatsapp: r.toWhatsapp, active: r.active, createdAt: new Date(r.createdAt) } })
    return 'Rule put back'
  },
})

// ── People ───────────────────────────────────────────────────────────────

defineTool({
  name: 'set_team_member',
  tier: 'write',
  description: "Mark a sender as the business's own team (their messages become context, never requests, in every chat), or unmark them. Use the waId from get_chat or list_team. Undoable.",
  schema: z.object({ waId: z.string(), team: z.boolean(), name: z.string().max(100).optional() }),
  summarize: (i) => `${i.team ? 'Mark' : 'Unmark'} ${i.name ?? i.waId} as our team`,
  run: async (input) => {
    const was = !!(await prisma.teamMember.findUnique({ where: { waId: input.waId } }))
    await setTeam(input.waId, input.team, input.name ?? null)
    return audited({ ok: true, waId: input.waId, team: input.team }, { team: was }, { team: input.team })
  },
  undo: async ({ input, before }) => {
    await setTeam(input.waId, (before as { team: boolean }).team, input.name ?? null)
    return `${input.name ?? input.waId} ${(before as { team: boolean }).team ? 'is team again' : 'is no longer marked as team'}`
  },
})

// ── The pipeline ─────────────────────────────────────────────────────────

defineTool({
  name: 'run_pipeline',
  tier: 'write',
  description: 'Bundle and analyse whatever is waiting now, for one chat or all, without waiting for the quiet period. Spends model credit. Not undoable.',
  schema: z.object({ chatId: z.string().optional() }),
  summarize: (i) => `Run the pipeline now${i.chatId ? ` for chat ${i.chatId.slice(0, 8)}` : ''}`,
  run: async ({ chatId }) => {
    await assertNoOutsideDeliveries(chatId)
    return tick({ force: true, ...(chatId ? { chatId } : {}) })
  },
})

defineTool({
  name: 'retry_run',
  tier: 'write',
  description: 'Re-run a failed pipeline run (bundle) — after a key was added, or a transient model error. Messages already flagged skip the filter.',
  schema: z.object({ bundleId: z.string() }),
  summarize: (i) => `Retry run ${i.bundleId.slice(0, 8)}`,
  run: async ({ bundleId }) => {
    const b = await prisma.bundle.findUnique({ where: { id: bundleId } })
    if (!b) return { error: 'No run with that id' }
    await assertNoOutsideDeliveries(b.chatId)
    await retryBundle(bundleId)
    const after = await prisma.bundle.findUnique({ where: { id: bundleId } })
    return { ok: true, status: after?.status, error: after?.error, itemsCreated: after?.itemsCreated, itemsUpdated: after?.itemsUpdated }
  },
})

defineTool({
  name: 'rescue_message',
  tier: 'write',
  description: 'Send a dismissed message straight to the analysis — the operator says it mattered. Creates or updates an item, and the filter is shown it as an example from then on. Spends model credit.',
  schema: z.object({ messageId: z.string() }),
  summarize: (i) => `Rescue message ${i.messageId.slice(0, 8)}`,
  run: async ({ messageId }) => {
    const m = await prisma.message.findUnique({ where: { id: messageId }, select: { chatId: true } })
    if (!m) return { error: 'No message with that id' }
    await assertNoOutsideDeliveries(m.chatId)
    const bundleId = await rescueMessage(messageId)
    const b = await prisma.bundle.findUnique({ where: { id: bundleId } })
    return { ok: true, bundleId, status: b?.status, itemsCreated: b?.itemsCreated, itemsUpdated: b?.itemsUpdated, error: b?.error }
  },
})

defineTool({
  name: 'read_media',
  tier: 'write',
  description: "Transcribe a voice note or describe an image again (or for the first time, if it failed). The reading appears under the message and is translated if it is Chinese. Spends a little model credit.",
  schema: z.object({ messageId: z.string() }),
  summarize: (i) => `Read media of message ${i.messageId.slice(0, 8)}`,
  run: async ({ messageId }) => {
    const m = await rereadMedia(messageId)
    return { status: m.mediaTextStatus, mediaText: m.mediaText, mediaTextTranslation: m.mediaTextTranslation, error: m.mediaTextError }
  },
})

defineTool({
  name: 'translate_message',
  tier: 'write',
  description: 'Translate a message (and its transcript or image reading) into the output language again.',
  schema: z.object({ messageId: z.string() }),
  summarize: (i) => `Translate message ${i.messageId.slice(0, 8)}`,
  run: async ({ messageId }) => {
    const m = await translateOne(messageId)
    return { textTranslation: m.textTranslation, mediaTextTranslation: m.mediaTextTranslation }
  },
})

// ── Settings ─────────────────────────────────────────────────────────────

const SafeSettings = z.object({
  businessName: z.string().max(200).optional(),
  outputLanguage: z.enum(['en', 'ms', 'zh']).optional(),
  timezone: z.string().optional(),
  bundleQuietSeconds: z.number().int().optional(),
  bundleMaxMessages: z.number().int().optional(),
  bundleMaxWaitSeconds: z.number().int().optional(),
  contextMessages: z.number().int().optional(),
  analyzeImages: z.boolean().optional(),
  describeImages: z.boolean().optional(),
  transcribeVoice: z.boolean().optional(),
  translateOriginals: z.boolean().optional(),
})

defineTool({
  name: 'update_settings',
  tier: 'write',
  description: 'Change the everyday settings: business name, output language, timezone, the bundling timings, and the media reading/translation toggles. Provider, models and keys are not changed here (see set_models). Undoable.',
  schema: SafeSettings,
  summarize: (i) => `Update settings: ${Object.keys(i).join(', ')}`,
  run: async (input) => {
    const cur = settings()
    const keys = Object.keys(input) as (keyof typeof input)[]
    if (!keys.length) return { error: 'Nothing to change' }
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone })
      } catch {
        return { error: `"${input.timezone}" is not a valid timezone` }
      }
    }
    const before = Object.fromEntries(keys.map((k) => [k, cur[k]]))
    const next = await saveSettings(input as Partial<Settings>)
    const after = Object.fromEntries(keys.map((k) => [k, next[k]]))
    return audited({ ok: true, ...after }, before, after)
  },
  undo: async ({ before }) => {
    await saveSettings(before as Partial<Settings>)
    return 'Settings restored'
  },
})

// ── Outward: the operator confirms first ─────────────────────────────────

/// The fixed rule, stated where the model reads it: the assistant messages
/// the operator's own number and nobody else. The check is in the tool, not
/// only the approval: a wrong number is an error result, never a pending
/// action for someone to approve by mistake.
defineTool({
  name: 'send_whatsapp',
  tier: 'outward',
  description:
    "Send a WhatsApp message from the linked account to the OPERATOR'S OWN NUMBER — a summary, a reminder, a draft for them to forward. This is the only number the assistant may ever message; a client's or a team member's number is refused outright, with no approval that lifts it. If the operator wants a client messaged, write the draft in your reply for them to send themselves. The operator approves the exact text before it goes.",
  schema: z.object({ to: z.string().describe("The operator's own number, international digits. Any other number is refused."), body: z.string().min(1).max(4000) }),
  summarize: (i) => `Send WhatsApp to +${i.to.replace(/[^0-9]/g, '')}: "${clip(i.body, 80)}"`,
  run: async (input, ctx) => {
    let to: string
    try {
      to = assertOperatorNumber(input.to)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!ctx.approved) return { error: 'Not approved' }
    if (!baileysReady()) return { error: 'WhatsApp is not connected, so nothing was sent' }
    const id = await sendText(to, input.body)
    return { ok: true, to, waMessageId: id }
  },
})

defineTool({
  name: 'send_item',
  tier: 'outward',
  description: "Send an item (title, brief, suggestion, the original messages) in the standard format to the OPERATOR'S OWN NUMBER — the only number the assistant may message. The operator approves first.",
  schema: z.object({ itemId: z.string(), to: z.string().describe("The operator's own number. Any other number is refused.") }),
  summarize: (i) => `Send item ${i.itemId.slice(0, 8)} to +${i.to.replace(/[^0-9]/g, '')}`,
  run: async (input, ctx) => {
    let to: string
    try {
      to = assertOperatorNumber(input.to)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!ctx.approved) return { error: 'Not approved' }
    const item = await prisma.item.findUnique({
      where: { id: input.itemId },
      include: { chat: true, rules: { select: { rule: true } }, messages: { include: { message: true }, orderBy: { message: { sentAt: 'asc' } } } },
    })
    if (!item) return { error: 'No item with that id' }
    const body = formatNewItem(item, item.chat, item.rules.map((r) => r.rule), item.messages.map((l) => l.message))
    const delivery = await prisma.delivery.create({ data: { itemId: item.id, toWaId: to, body } })
    return { ok: true, deliveryId: delivery.id, note: 'Queued; the pipeline sends it within seconds while WhatsApp is connected' }
  },
})

defineTool({
  name: 'whatsapp_link',
  tier: 'outward',
  description: 'Pause the WhatsApp link (keeps the session; messages stop arriving) or reconnect a paused one. Unlinking is not offered here — the operator does that on the WhatsApp screen.',
  schema: z.object({ action: z.enum(['pause', 'reconnect']) }),
  summarize: (i) => (i.action === 'pause' ? 'Pause the WhatsApp link' : 'Reconnect the WhatsApp link'),
  run: async ({ action }, ctx) => {
    if (!ctx.approved) return { error: 'Not approved' }
    const status = action === 'pause' ? await stopWhatsApp() : await startWhatsApp({ pair: true })
    return { ok: true, state: status.state, ready: status.ready }
  },
})

defineTool({
  name: 'set_models',
  tier: 'outward',
  description: 'Change which provider and models the pipeline and the assistant use. Costs change with it, so the operator approves first. Keys are never set here.',
  schema: z.object({
    provider: z.enum(['anthropic', 'openrouter']).optional(),
    filterModel: z.string().max(100).optional(),
    analyzeModel: z.string().max(100).optional(),
    transcribeModel: z.string().max(100).optional(),
    agentModel: z.string().max(100).optional(),
    agentEscalationModel: z.string().max(100).optional(),
    agentEffort: z.enum(['low', 'medium', 'high']).optional(),
  }),
  summarize: (i) => `Change models: ${Object.entries(i).map(([k, v]) => `${k} → ${v}`).join(', ')}`,
  run: async (input, ctx) => {
    if (!ctx.approved) return { error: 'Not approved' }
    const cur = settings()
    const keys = Object.keys(input) as (keyof typeof input)[]
    if (!keys.length) return { error: 'Nothing to change' }
    const before = Object.fromEntries(keys.map((k) => [k, cur[k]]))
    const next = await saveSettings(input as Partial<Settings>)
    const after = Object.fromEntries(keys.map((k) => [k, next[k]]))
    return audited({ ok: true, ...after }, before, after)
  },
  undo: async ({ before }) => {
    await saveSettings(before as Partial<Settings>)
    return 'Models restored'
  },
})
