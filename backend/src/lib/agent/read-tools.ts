import { z } from 'zod'
import type { Prisma, ItemStatus } from '@prisma/client'
import prisma from '../prisma.js'
import { defineTool, clip } from './tools.js'
import { baileysStatus } from '../whatsapp/baileys.js'
import { publicSettings, settings } from '../settings.js'
import { llmConfigured } from '../llm/client.js'
import { estimateCostUsd } from '../llm/models.js'
import { isTeam } from '../team.js'

/// What the assistant can look at. Everything the screens show, plus a
/// read-only SQL door for the questions nobody wrote a tool for.

const LIMIT = z.number().int().min(1).max(100).optional().describe('Rows to return. Default 25, max 100.')

function messageRow(m: {
  id: string
  chatId: string
  senderName: string | null
  senderWaId: string
  fromMe: boolean
  type: string
  text: string | null
  mediaText: string | null
  mediaTextStatus: string
  textTranslation: string | null
  mediaTextTranslation: string | null
  filterStatus: string
  filterReason: string | null
  sentAt: Date
}) {
  return {
    id: m.id,
    chatId: m.chatId,
    sentAt: m.sentAt.toISOString(),
    sender: m.fromMe ? 'me' : m.senderName || m.senderWaId,
    senderWaId: m.senderWaId,
    side: m.fromMe || isTeam(m.senderWaId) ? 'our team' : 'client',
    type: m.type,
    text: clip(m.text),
    ...(m.textTranslation ? { textTranslation: clip(m.textTranslation) } : {}),
    ...(m.mediaTextStatus === 'DONE' && m.mediaText ? { mediaText: clip(m.mediaText), ...(m.mediaTextTranslation ? { mediaTextTranslation: clip(m.mediaTextTranslation) } : {}) } : {}),
    filterStatus: m.filterStatus,
    ...(m.filterReason ? { filterReason: m.filterReason } : {}),
  }
}

defineTool({
  name: 'get_status',
  tier: 'read',
  description:
    'The state of the whole system right now: the WhatsApp link, whether a model key is configured, what is waiting in the pipeline, recent failures, and the triage counts (open, chased, left sitting, urgent). Call this first when asked "how are things" or before diagnosing why something is not arriving.',
  schema: z.object({}),
  run: async () => {
    const link = baileysStatus()
    const dayAgo = new Date(Date.now() - 86_400_000)
    const staleBefore = new Date(Date.now() - 48 * 3_600_000)
    const [pending, bundles, failedBundles, open, chased, stale, urgent, tracked] = await Promise.all([
      prisma.message.count({ where: { filterStatus: 'PENDING' } }),
      prisma.bundle.groupBy({ by: ['status'], where: { createdAt: { gte: dayAgo } }, _count: { _all: true } }),
      prisma.bundle.findMany({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, error: true, createdAt: true, chat: { select: { name: true } } } }),
      prisma.item.count({ where: { status: { in: ['NEW', 'IN_PROGRESS'] } } }),
      prisma.item.count({ where: { status: { in: ['NEW', 'IN_PROGRESS'] }, messages: { some: { kind: 'STATUS_CHECK' } } } }),
      prisma.item.count({ where: { status: { in: ['NEW', 'IN_PROGRESS'] }, lastActivityAt: { lt: staleBefore } } }),
      prisma.item.count({ where: { status: { in: ['NEW', 'IN_PROGRESS'] }, priority: { in: ['HIGH', 'URGENT'] } } }),
      prisma.chat.count({ where: { tracked: true } }),
    ])
    const s = settings()
    return {
      whatsapp: { state: link.state, ready: link.ready, account: link.me?.id ?? null, lastInboundAt: link.lastInboundAt, lastError: link.lastError, action: link.action },
      models: { provider: s.provider, keyConfigured: llmConfigured(), filterModel: s.filterModel, analyzeModel: s.analyzeModel },
      pipeline: {
        messagesWaiting: pending,
        bundlesLast24h: Object.fromEntries(bundles.map((b) => [b.status, b._count._all])),
        recentFailures: failedBundles.map((b) => ({ bundleId: b.id, chat: b.chat.name, error: clip(b.error, 200), at: b.createdAt.toISOString() })),
      },
      triage: { openItems: open, chasingYou: chased, leftSitting48h: stale, urgentOrHigh: urgent },
      trackedChats: tracked,
    }
  },
})

defineTool({
  name: 'list_chats',
  tier: 'read',
  description:
    'Chats the WhatsApp link can see. By default only the tracked ones (the chats Tapis reads). Pass tracked=false for the untracked ones, or q to search by name, client or number. Returns ids you can pass to get_chat and search_messages.',
  schema: z.object({
    tracked: z.boolean().optional().describe('true (default) = chats being read; false = the rest'),
    q: z.string().optional().describe('Search in chat name, client name or WhatsApp id'),
    limit: LIMIT,
  }),
  run: async (input) => {
    const tracked = input.tracked ?? true
    const chats = await prisma.chat.findMany({
      where: {
        tracked,
        ...(input.q ? { OR: [{ name: { contains: input.q, mode: 'insensitive' } }, { clientName: { contains: input.q, mode: 'insensitive' } }, { jid: { contains: input.q } }] } : {}),
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
      take: input.limit ?? 25,
      include: { _count: { select: { rules: { where: { active: true } }, items: { where: { status: { in: ['NEW', 'IN_PROGRESS'] } } }, messages: true } } },
    })
    return chats.map((c) => ({
      id: c.id,
      name: c.name,
      client: c.clientName,
      isGroup: c.isGroup,
      tracked: c.tracked,
      description: clip(c.description, 200),
      activeRules: c._count.rules,
      openItems: c._count.items,
      storedMessages: c._count.messages,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    }))
  },
})

defineTool({
  name: 'get_chat',
  tier: 'read',
  description: 'One chat in full: its context, tracking rules, the people in it (with who is on our team), and message/item counts.',
  schema: z.object({ chatId: z.string().describe('From list_chats') }),
  run: async ({ chatId }) => {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { rules: { orderBy: { createdAt: 'asc' } }, participants: { orderBy: { messageCount: 'desc' }, take: 50 } },
    })
    if (!chat) return { error: 'No chat with that id' }
    const [pending, dismissed, attached, openItems] = await Promise.all([
      prisma.message.count({ where: { chatId, filterStatus: 'PENDING' } }),
      prisma.message.count({ where: { chatId, filterStatus: 'DISMISSED' } }),
      prisma.message.count({ where: { chatId, filterStatus: 'ATTACHED' } }),
      prisma.item.count({ where: { chatId, status: { in: ['NEW', 'IN_PROGRESS'] } } }),
    ])
    return {
      id: chat.id,
      name: chat.name,
      client: chat.clientName,
      description: chat.description,
      tracked: chat.tracked,
      trackedSince: chat.trackedSince?.toISOString() ?? null,
      rules: chat.rules.map((r) => ({ id: r.id, text: r.text, active: r.active, onlyFrom: r.senderWaIds, toDashboard: r.toDashboard, toWhatsapp: r.toWhatsapp, extraAsk: r.extraAsk })),
      people: chat.participants.map((p) => ({ waId: p.waId, name: p.name, messages: p.messageCount, side: isTeam(p.waId) ? 'our team' : 'client' })),
      counts: { pending, dismissed, attached, openItems },
    }
  },
})

defineTool({
  name: 'search_messages',
  tier: 'read',
  description:
    'Stored messages from tracked chats, newest first. Filter by chat, sender, filter status (PENDING, DISMISSED, FLAGGED, ATTACHED, SKIPPED), text, or a time window. Voice notes carry their transcript in mediaText, images their description; Chinese text carries an English translation. Use this to read what a client actually said.',
  schema: z.object({
    chatId: z.string().optional(),
    q: z.string().optional().describe('Substring to find in the text or transcript'),
    senderWaId: z.string().optional(),
    status: z.enum(['PENDING', 'DISMISSED', 'FLAGGED', 'ATTACHED', 'SKIPPED']).optional(),
    since: z.string().optional().describe('ISO date/time, inclusive'),
    until: z.string().optional().describe('ISO date/time, exclusive'),
    limit: LIMIT,
  }),
  run: async (input) => {
    const since = input.since ? new Date(input.since) : null
    const until = input.until ? new Date(input.until) : null
    const rows = await prisma.message.findMany({
      where: {
        ...(input.chatId ? { chatId: input.chatId } : {}),
        ...(input.senderWaId ? { senderWaId: input.senderWaId } : {}),
        ...(input.status ? { filterStatus: input.status } : {}),
        ...(input.q ? { OR: [{ text: { contains: input.q, mode: 'insensitive' } }, { mediaText: { contains: input.q, mode: 'insensitive' } }] } : {}),
        ...(since && !Number.isNaN(since.getTime()) ? { sentAt: { gte: since, ...(until && !Number.isNaN(until.getTime()) ? { lt: until } : {}) } } : until && !Number.isNaN(until.getTime()) ? { sentAt: { lt: until } } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: input.limit ?? 25,
      include: { chat: { select: { name: true } }, itemLinks: { select: { itemId: true, kind: true } } },
    })
    return rows.map((m) => ({ ...messageRow(m), chat: m.chat.name, items: m.itemLinks.map((l) => ({ itemId: l.itemId, kind: l.kind })) }))
  },
})

defineTool({
  name: 'list_items',
  tier: 'read',
  description:
    'Tracked items (the requests, complaints and bug reports the pipeline produced). Filter by status (NEW, IN_PROGRESS, DONE, DISMISSED), a triage view (chased = client asked again; stale = open with no activity for 48h; urgent = HIGH/URGENT), chat, client or text. Default: open items, most recent activity first.',
  schema: z.object({
    status: z.array(z.enum(['NEW', 'IN_PROGRESS', 'DONE', 'DISMISSED'])).optional(),
    view: z.enum(['chased', 'stale', 'urgent']).optional(),
    chatId: z.string().optional(),
    client: z.string().optional().describe('Exact client name as set on the chat'),
    q: z.string().optional().describe('Substring in title or brief'),
    limit: LIMIT,
  }),
  run: async (input) => {
    const OPEN: ItemStatus[] = ['NEW', 'IN_PROGRESS']
    const staleBefore = new Date(Date.now() - 48 * 3_600_000)
    const viewWhere: Prisma.ItemWhereInput =
      input.view === 'chased'
        ? { status: { in: OPEN }, messages: { some: { kind: 'STATUS_CHECK' } } }
        : input.view === 'stale'
          ? { status: { in: OPEN }, lastActivityAt: { lt: staleBefore } }
          : input.view === 'urgent'
            ? { status: { in: OPEN }, priority: { in: ['HIGH', 'URGENT'] } }
            : {}
    const items = await prisma.item.findMany({
      where: {
        ...(input.status?.length && !input.view ? { status: { in: input.status } } : !input.view && !input.status ? { status: { in: OPEN } } : {}),
        ...viewWhere,
        ...(input.chatId ? { chatId: input.chatId } : {}),
        ...(input.client ? { chat: { clientName: input.client } } : {}),
        ...(input.q ? { OR: [{ title: { contains: input.q, mode: 'insensitive' } }, { brief: { contains: input.q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { lastActivityAt: input.view === 'stale' ? 'asc' : 'desc' },
      take: input.limit ?? 25,
      include: {
        chat: { select: { name: true, clientName: true } },
        _count: { select: { messages: true } },
        messages: { where: { kind: 'STATUS_CHECK' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      },
    })
    return items.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      priority: i.priority,
      chat: i.chat.name,
      client: i.chat.clientName,
      brief: clip(i.brief, 300),
      messages: i._count.messages,
      lastActivityAt: i.lastActivityAt.toISOString(),
      chasedAt: i.messages[0]?.createdAt.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
    }))
  },
})

defineTool({
  name: 'get_item',
  tier: 'read',
  description: 'One item in full: brief, suggestion, the exact client messages attached to it (with transcripts and translations), its timeline of events, rules, and WhatsApp deliveries.',
  schema: z.object({ itemId: z.string() }),
  run: async ({ itemId }) => {
    const item = await prisma.item.findUnique({
      where: { id: itemId },
      include: {
        chat: { select: { id: true, name: true, clientName: true } },
        rules: { select: { rule: { select: { id: true, text: true } } } },
        messages: { include: { message: true }, orderBy: { message: { sentAt: 'asc' } } },
        events: { orderBy: { createdAt: 'asc' }, take: 50 },
        deliveries: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    })
    if (!item) return { error: 'No item with that id' }
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      brief: item.brief,
      suggestion: item.suggestion,
      extra: item.extra,
      chat: item.chat,
      rules: item.rules.map((r) => r.rule),
      createdAt: item.createdAt.toISOString(),
      lastActivityAt: item.lastActivityAt.toISOString(),
      messages: item.messages.map((l) => ({ link: l.kind, note: l.note, ...messageRow(l.message) })),
      events: item.events.map((e) => ({ kind: e.kind, at: e.createdAt.toISOString(), detail: clip(e.detail, 200) })),
      deliveries: item.deliveries.map((d) => ({ to: d.toWaId, status: d.status, at: d.createdAt.toISOString(), error: d.error })),
    }
  },
})

defineTool({
  name: 'list_dismissed',
  tier: 'read',
  description: 'Messages the first-pass filter dismissed as noise, newest first, with its reason. Where to look when a client says "I told you already" and nothing was tracked.',
  schema: z.object({ chatId: z.string().optional(), q: z.string().optional(), limit: LIMIT }),
  run: async (input) => {
    const rows = await prisma.message.findMany({
      where: { filterStatus: 'DISMISSED', ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.q ? { text: { contains: input.q, mode: 'insensitive' } } : {}) },
      orderBy: { sentAt: 'desc' },
      take: input.limit ?? 25,
      include: { chat: { select: { name: true } } },
    })
    return rows.map((m) => ({ ...messageRow(m), chat: m.chat.name }))
  },
})

defineTool({
  name: 'list_pipeline_runs',
  tier: 'read',
  description: 'Recent pipeline runs (bundles): which chat, what triggered it, how many messages, how many flagged, items created/updated, and the error if it failed.',
  schema: z.object({ status: z.enum(['FILTERING', 'ANALYZING', 'DONE', 'FAILED']).optional(), chatId: z.string().optional(), limit: LIMIT }),
  run: async (input) => {
    const rows = await prisma.bundle.findMany({
      where: { ...(input.status ? { status: input.status } : {}), ...(input.chatId ? { chatId: input.chatId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: input.limit ?? 25,
      include: { chat: { select: { name: true } } },
    })
    return rows.map((b) => ({ id: b.id, chat: b.chat.name, trigger: b.trigger, status: b.status, messages: b.messageCount, flagged: b.flaggedCount, created: b.itemsCreated, updated: b.itemsUpdated, error: clip(b.error, 300), at: b.createdAt.toISOString() }))
  },
})

defineTool({
  name: 'list_team',
  tier: 'read',
  description: "The people marked as the business's own team (their messages are context, never requests), and every other sender seen across chats.",
  schema: z.object({}),
  run: async () => {
    const [members, participants] = await Promise.all([
      prisma.teamMember.findMany(),
      prisma.participant.findMany({ select: { waId: true, name: true, messageCount: true, chat: { select: { name: true } } } }),
    ])
    const seen = new Map<string, { waId: string; name: string | null; chats: string[]; messages: number }>()
    for (const p of participants) {
      const r = seen.get(p.waId) ?? { waId: p.waId, name: p.name, chats: [], messages: 0 }
      r.chats.push(p.chat.name)
      r.messages += p.messageCount
      if (!r.name && p.name) r.name = p.name
      seen.set(p.waId, r)
    }
    return {
      team: members.map((m) => ({ waId: m.waId, name: m.name })),
      others: [...seen.values()].filter((r) => !members.some((m) => m.waId === r.waId)).slice(0, 60),
    }
  },
})

defineTool({
  name: 'get_settings',
  tier: 'read',
  description: 'The operator settings: business name, output language, provider and models, bundling timings, which keys are configured (never the keys themselves), media reading and translation toggles.',
  schema: z.object({}),
  run: async () => publicSettings(),
})

defineTool({
  name: 'cost_report',
  tier: 'read',
  description: 'Model spend over the last N days, by kind of call (FILTER, ANALYZE, MEDIA, TRANSLATE, AGENT) and by model, with call counts and failures.',
  schema: z.object({ days: z.number().int().min(1).max(90).optional().describe('Default 7') }),
  run: async ({ days }) => {
    const since = new Date(Date.now() - (days ?? 7) * 86_400_000)
    const calls = await prisma.llmCall.findMany({ where: { createdAt: { gte: since } }, select: { kind: true, model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, ok: true } })
    const byKind: Record<string, { calls: number; failed: number; usd: number }> = {}
    const byModel: Record<string, { calls: number; usd: number; inputTokens: number; outputTokens: number }> = {}
    let total = 0
    for (const c of calls) {
      const usd = estimateCostUsd(c.model, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens)
      total += usd
      const k = (byKind[c.kind] ??= { calls: 0, failed: 0, usd: 0 })
      k.calls += 1
      if (!c.ok) k.failed += 1
      k.usd += usd
      const m = (byModel[c.model] ??= { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 })
      m.calls += 1
      m.usd += usd
      m.inputTokens += c.inputTokens
      m.outputTokens += c.outputTokens
    }
    const round = (n: number) => Math.round(n * 10000) / 10000
    return {
      days: days ?? 7,
      totalUsd: round(total),
      byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { ...v, usd: round(v.usd) }])),
      byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { ...v, usd: round(v.usd) }])),
    }
  },
})

// ── The long tail: read-only SQL ────────────────────────────────────────

/// Tables the assistant may query, with the columns worth knowing. The two
/// it may not: users (password hashes) and app_settings (encrypted keys).
const SCHEMA: Record<string, string> = {
  chats: 'id, jid, name, is_group, tracked, client_name, description, tracked_since, participant_count, last_message_at, created_at',
  participants: 'id, chat_id, wa_id, name, message_count, last_seen_at',
  contacts: 'jid, name',
  team_members: 'wa_id, name, created_at',
  rules: 'id, chat_id, text, extra_ask, sender_wa_ids (text[]), to_dashboard, to_whatsapp (text[]), active, created_at',
  messages:
    'id, chat_id, wa_message_id, sender_wa_id, sender_name, from_me, type (TEXT|IMAGE|VIDEO|AUDIO|DOCUMENT|STICKER|LOCATION|CONTACT), text, media_mime, media_text, media_text_status, text_translation, media_text_translation, sent_at, received_at, simulated, filter_status (PENDING|DISMISSED|FLAGGED|ATTACHED|SKIPPED), filter_reason, filter_rule_ids, bundle_id, rescued_at',
  bundles: 'id, chat_id, trigger, status (FILTERING|ANALYZING|DONE|FAILED), message_count, flagged_count, items_created, items_updated, error, created_at, completed_at',
  items: 'id, chat_id, title, brief, suggestion, extra (json), priority (LOW|NORMAL|HIGH|URGENT), status (NEW|IN_PROGRESS|DONE|DISMISSED), first_message_at, last_activity_at, created_at, updated_at',
  item_messages: 'id, item_id, message_id, kind (ORIGIN|FOLLOW_UP|STATUS_CHECK|DETAIL), note, created_at',
  item_rules: 'item_id, rule_id',
  item_events: 'id, item_id, kind, detail, created_at',
  deliveries: 'id, item_id, rule_id, to_wa_id, body, status, attempts, error, wa_message_id, created_at, sent_at',
  feedback: 'id, chat_id, message_id, kind (RESCUED|FALSE_POSITIVE), text, created_at',
  llm_calls: 'id, kind, model, bundle_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, ok, error, created_at',
  agent_threads: 'id, title, status, model, input_tokens, output_tokens, cost_usd, turns, last_message_at, created_at',
  agent_actions: 'id, thread_id, call_id, tool, tier, status (done|pending|declined|undone|failed), summary, input, output, before, after, ok, error, latency_ms, undone_at, created_at',
  agent_messages: 'id, thread_id, seq, role (user|assistant|tool|system), content (json: text / toolCalls / toolResults), created_at',
  agent_memory: 'path, content, created_at, updated_at',
}

defineTool({
  name: 'describe_schema',
  tier: 'read',
  description: 'The database tables and columns the assistant may query with sql_query. Read this before writing SQL.',
  schema: z.object({}),
  run: async () => SCHEMA,
})

const FORBIDDEN = /\b(users|app_settings|pg_\w+|information_schema)\b/i

defineTool({
  name: 'sql_query',
  tier: 'read',
  description:
    'Run one read-only SQL SELECT against the database (PostgreSQL) for anything the other tools cannot answer — counts, joins, trends, "which client sent the most messages in August". Only SELECT or WITH…SELECT; one statement; at most 200 rows come back; 5-second limit. Call describe_schema first for table and column names.',
  schema: z.object({ sql: z.string().describe('A single SELECT statement. Column names are snake_case.') }),
  run: async ({ sql }) => {
    const q = sql.trim().replace(/;\s*$/, '')
    if (!/^(select|with)\b/i.test(q)) return { error: 'Only a SELECT (or WITH … SELECT) is allowed' }
    if (q.includes(';')) return { error: 'One statement only' }
    if (FORBIDDEN.test(q)) return { error: 'That table is not available to the assistant' }
    if (/\b(insert|update|delete|drop|alter|truncate|grant|create|copy|call|do)\b/i.test(q)) return { error: 'Only reads are allowed' }
    try {
      const rows = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 5000')
          return tx.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM (${q}) AS q LIMIT 200`)
        },
        { timeout: 8000 },
      )
      // BigInt from count(*) has no JSON form.
      const plain = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v])))
      return { rows: plain, count: plain.length, truncated: plain.length === 200 }
    } catch (err) {
      return { error: `The query failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 400)}` }
    }
  },
})
