import { z } from 'zod'
import prisma from '../prisma.js'
import { settings } from '../settings.js'
import { estimateCostUsd } from '../llm/models.js'
import { streamCompletion, type WireMessage, type ToolCall } from './provider.js'
import { allTools, getTool, wireTools, isAudited, type AgentTool } from './tools.js'
import { staticSystemPrompt, liveBrief } from './prompt.js'
import './read-tools.js'
import './write-tools.js'
import './memory.js'
import { memoryContext } from './memory.js'

/// The loop. One turn = the operator says something; the model reasons,
/// calls tools, reads results, and answers — every step persisted as it
/// happens, every event pushed to whoever is watching.
///
/// Reliability is the harness's job, not the model's:
///   - the transcript is append-only and stored before the next request;
///   - tool inputs are validated; a bad call becomes an error result;
///   - a step limit and an output-token budget end a runaway turn, with a
///     nudge to wrap up before the hard stop;
///   - two consecutive steps of invalid tool calls hand the turn to the
///     escalation model; a provider error is retried once on it too;
///   - one run per thread, and a stop button that actually stops.

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; callId: string; name: string; input: unknown }
  | { type: 'tool_end'; callId: string; name: string; ok: boolean; ms: number; preview: string }
  | { type: 'approval'; action: ActionView }
  | { type: 'step'; step: number; model: string }
  | { type: 'message'; message: StoredMessage }
  | { type: 'done'; usage: { input: number; output: number; costUsd: number } }
  | { type: 'error'; message: string }

export interface StoredMessage {
  id: string
  seq: number
  role: string
  content: MessageContent
  createdAt: string
}

export interface ActionView {
  id: string
  callId: string | null
  tool: string
  tier: string
  status: string
  summary: string | null
  input: unknown
  output: unknown
  undoable: boolean
  createdAt: string
}

export function actionView(a: { id: string; callId: string | null; tool: string; tier: string; status: string; summary: string | null; input: unknown; output: unknown; before: unknown; createdAt: Date }): ActionView {
  const tool = getTool(a.tool)
  return { id: a.id, callId: a.callId, tool: a.tool, tier: a.tier, status: a.status, summary: a.summary, input: a.input, output: a.output, undoable: a.status === 'done' && !!tool?.undo && a.before !== null && a.before !== undefined, createdAt: a.createdAt.toISOString() }
}

export type MessageContent =
  | { text: string }
  | { text?: string; reasoning?: string; toolCalls: { id: string; name: string; input: unknown; raw?: string }[]; reasoningDetails?: unknown[] }
  | { toolResults: { id: string; name: string; output: unknown; isError: boolean; ms: number }[] }
  | { summary: string; replaces: [number, number] }

interface Run {
  threadId: string
  events: { id: number; event: AgentEvent }[]
  subscribers: Set<(id: number, event: AgentEvent) => void>
  abort: AbortController
  done: boolean
}

const runs = new Map<string, Run>()
const MAX_STEPS = 24
const OUTPUT_BUDGET = 40_000
const TOOL_TIMEOUT_MS = 30_000
const MAX_HISTORY_CHARS = 160_000

let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(`[agent] ${m}`, e ?? '')
export function setAgentLogger(fn: typeof logLine) {
  logLine = fn
}

export function activeRun(threadId: string): Run | undefined {
  const r = runs.get(threadId)
  return r && !r.done ? r : undefined
}

export function subscribe(threadId: string, since: number, fn: (id: number, event: AgentEvent) => void): (() => void) | null {
  const r = runs.get(threadId)
  if (!r) return null
  for (const e of r.events) if (e.id > since) fn(e.id, e.event)
  if (r.done) return () => {}
  r.subscribers.add(fn)
  return () => r.subscribers.delete(fn)
}

export function stopRun(threadId: string): boolean {
  const r = activeRun(threadId)
  if (!r) return false
  r.abort.abort()
  return true
}

function emit(run: Run, event: AgentEvent) {
  const id = run.events.length + 1
  run.events.push({ id, event })
  for (const fn of run.subscribers) fn(id, event)
}

async function append(threadId: string, role: string, content: MessageContent): Promise<StoredMessage> {
  const last = await prisma.agentMessage.findFirst({ where: { threadId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  const row = await prisma.agentMessage.create({ data: { threadId, seq: (last?.seq ?? 0) + 1, role, content: content as object } })
  return { id: row.id, seq: row.seq, role: row.role, content: row.content as MessageContent, createdAt: row.createdAt.toISOString() }
}

/// Starts a turn. Returns once the user message is stored and the run is
/// registered; the work continues in the background and streams events.
export async function startTurn(threadId: string, text: string): Promise<{ userMessage: StoredMessage }> {
  const { userMessage } = await beginRun(threadId, { text })
  return { userMessage: userMessage! }
}

/// Resumes a thread with no new operator message — after an approval or a
/// decline, the model picks up from the system row that records it.
export async function continueTurn(threadId: string): Promise<void> {
  await beginRun(threadId, {})
}

async function beginRun(threadId: string, opts: { text?: string }): Promise<{ userMessage: StoredMessage | null }> {
  if (activeRun(threadId)) throw Object.assign(new Error('The assistant is still working on the last message'), { statusCode: 409 })
  const thread = await prisma.agentThread.findUnique({ where: { id: threadId } })
  if (!thread) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })

  const userMessage = opts.text ? await append(threadId, 'user', { text: opts.text }) : null
  const run: Run = { threadId, events: [], subscribers: new Set(), abort: new AbortController(), done: false }
  runs.set(threadId, run)
  await prisma.agentThread.update({
    where: { id: threadId },
    data: { status: 'running', lastMessageAt: new Date(), ...(thread.turns === 0 && opts.text ? { title: titleFrom(opts.text) } : {}) },
  })
  if (userMessage) emit(run, { type: 'message', message: userMessage })

  void runTurn(run)
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err)
      logLine(`turn failed on thread ${threadId}`, err)
      emit(run, { type: 'error', message })
    })
    .finally(async () => {
      run.done = true
      await prisma.agentThread.update({ where: { id: threadId }, data: { status: 'idle', turns: { increment: 1 } } }).catch(() => {})
      // Keep the event log around briefly for a reconnecting client.
      setTimeout(() => {
        if (runs.get(threadId) === run) runs.delete(threadId)
      }, 60_000).unref?.()
    })
  return { userMessage }
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || 'New conversation'
}

async function runTurn(run: Run) {
  const s = settings()
  const tools = allTools()
  const wire = wireTools(tools)
  await compactIfNeeded(run.threadId)
  const history = await prisma.agentMessage.findMany({ where: { threadId: run.threadId }, orderBy: { seq: 'asc' } })
  const messages: WireMessage[] = [
    { role: 'system', content: staticSystemPrompt() },
    { role: 'system', content: await memoryContext() },
    { role: 'system', content: await liveBrief() },
    ...toWire(history.map((m) => ({ seq: m.seq, role: m.role, content: m.content as MessageContent }))),
  ]

  let model = s.agentModel
  let escalated = false
  let invalidStreak = 0
  let outputTokens = 0
  let inputTokens = 0
  let costUsd = 0
  let nudged = false

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (run.abort.signal.aborted) break
    emit(run, { type: 'step', step, model })

    if (outputTokens > OUTPUT_BUDGET && !nudged) {
      nudged = true
      messages.push({ role: 'system', content: 'You are near the limit for this turn. Finish with what you have: answer the operator now, briefly, and say what was left undone.' })
    }

    let result
    try {
      result = await streamCompletion({
        model,
        messages,
        tools: wire,
        effort: s.agentEffort,
        maxTokens: 8000,
        signal: run.abort.signal,
        handlers: {
          onText: (delta) => emit(run, { type: 'text', delta }),
          onReasoning: (delta) => emit(run, { type: 'reasoning', delta }),
        },
      })
    } catch (err) {
      if (run.abort.signal.aborted) break
      // One provider failure is a retry on the escalation model — it is a
      // different provider pool as often as not — and a second one is the
      // operator's to see.
      if (!escalated && s.agentEscalationModel && s.agentEscalationModel !== model) {
        logLine(`step ${step} failed on ${model}; retrying on ${s.agentEscalationModel}`, err)
        model = s.agentEscalationModel
        escalated = true
        continue
      }
      throw err
    }

    inputTokens += result.usage.input + result.usage.cacheRead
    outputTokens += result.usage.output
    costUsd += estimateCostUsd(result.model, result.usage.input, result.usage.output, result.usage.cacheRead, 0)

    // Persist what the model said before doing anything it asked for.
    const calls = result.toolCalls.map((c) => ({ id: c.id, name: c.name, input: parseArgs(c), raw: c.arguments }))
    const assistantContent: MessageContent = calls.length
      ? { ...(result.text ? { text: result.text } : {}), ...(result.reasoning ? { reasoning: result.reasoning } : {}), toolCalls: calls, ...(result.reasoningDetails ? { reasoningDetails: result.reasoningDetails } : {}) }
      : { text: result.text, ...(result.reasoning ? { reasoning: result.reasoning } : {}) }
    const stored = await append(run.threadId, 'assistant', assistantContent)
    emit(run, { type: 'message', message: stored })
    messages.push({
      role: 'assistant',
      content: result.text || null,
      ...(calls.length ? { tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}),
      ...(result.reasoningDetails ? { reasoning_details: result.reasoningDetails } : {}),
    })

    if (!calls.length) break
    if (result.finishReason === 'length') {
      messages.push({ role: 'system', content: 'Your last reply was cut off by the length limit. Continue, more briefly.' })
    }

    // Run the tools — all of them together, each on its own clock.
    const results = await Promise.all(calls.map((c) => executeTool(run, c)))
    const invalid = results.filter((r) => r.invalid).length
    invalidStreak = invalid === calls.length && calls.length > 0 ? invalidStreak + 1 : 0
    const toolContent: MessageContent = { toolResults: results.map((r) => ({ id: r.id, name: r.name, output: r.output, isError: r.isError, ms: r.ms })) }
    const storedTools = await append(run.threadId, 'tool', toolContent)
    emit(run, { type: 'message', message: storedTools })
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.output) })

    if (invalidStreak >= 2 && !escalated && s.agentEscalationModel && s.agentEscalationModel !== model) {
      logLine(`two steps of invalid tool calls on ${model}; escalating to ${s.agentEscalationModel}`)
      model = s.agentEscalationModel
      escalated = true
      messages.push({ role: 'system', content: 'Your previous tool calls did not match the tool schemas. Read the schemas again and call the tools with exactly the fields they define.' })
    }

    trimHistory(messages)
  }

  await prisma.agentThread.update({
    where: { id: run.threadId },
    data: { model, inputTokens: { increment: inputTokens }, outputTokens: { increment: outputTokens }, costUsd: { increment: costUsd }, lastMessageAt: new Date() },
  })
  emit(run, { type: 'done', usage: { input: inputTokens, output: outputTokens, costUsd } })
}

function parseArgs(c: ToolCall): unknown {
  if (!c.arguments.trim()) return {}
  try {
    return JSON.parse(c.arguments)
  } catch {
    return { __unparsable: c.arguments.slice(0, 500) }
  }
}

interface ToolOutcome {
  id: string
  name: string
  output: unknown
  isError: boolean
  invalid: boolean
  ms: number
}

async function executeTool(run: Run, call: { id: string; name: string; input: unknown }): Promise<ToolOutcome> {
  const started = Date.now()
  const tool: AgentTool | undefined = getTool(call.name)
  const finish = async (output: unknown, isError: boolean, invalid = false, audit: { before?: unknown; after?: unknown } = {}): Promise<ToolOutcome> => {
    const ms = Date.now() - started
    await prisma.agentAction
      .create({
        data: {
          threadId: run.threadId,
          callId: call.id,
          tool: call.name,
          tier: tool?.tier ?? 'read',
          status: isError ? 'failed' : 'done',
          summary: tool?.summarize ? safeSummary(tool, call.input) : null,
          input: (call.input ?? {}) as object,
          output: output as object,
          before: audit.before === undefined ? undefined : (audit.before as object),
          after: audit.after === undefined ? undefined : (audit.after as object),
          ok: !isError,
          error: isError ? String((output as any)?.error ?? '').slice(0, 500) : null,
          latencyMs: ms,
        },
      })
      .catch((err) => logLine('could not record an agent action', err))
    emit(run, { type: 'tool_end', callId: call.id, name: call.name, ok: !isError, ms, preview: preview(output) })
    return { id: call.id, name: call.name, output, isError, invalid, ms }
  }

  emit(run, { type: 'tool_start', callId: call.id, name: call.name, input: call.input })
  if (!tool) return finish({ error: `No tool named "${call.name}". The available tools are: ${allTools().map((t) => t.name).join(', ')}` }, true, true)
  if (call.input && typeof call.input === 'object' && '__unparsable' in (call.input as object)) {
    return finish({ error: 'The arguments were not valid JSON' }, true, true)
  }
  const parsed = (tool.schema as z.ZodTypeAny).safeParse(call.input ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return finish({ error: `Invalid arguments: ${issue?.message ?? 'schema mismatch'}${issue?.path.length ? ` at ${issue.path.join('.')}` : ''}` }, true, true)
  }

  // Outward tools never run from here. The call is parked for the operator;
  // the model is told to say what it asked for and stop, and the thread
  // resumes when the person decides.
  if (tool.tier === 'outward') {
    const action = await prisma.agentAction.create({
      data: { threadId: run.threadId, callId: call.id, tool: call.name, tier: 'outward', status: 'pending', summary: safeSummary(tool, parsed.data), input: parsed.data as object, latencyMs: 0 },
    })
    emit(run, { type: 'approval', action: actionView(action) })
    const output = { pending: true, actionId: action.id, note: 'This needs the operator\'s approval. Tell the operator exactly what you asked to do and why, then end your turn — you will be resumed once they approve or decline. Do not call this tool again for the same action.' }
    emit(run, { type: 'tool_end', callId: call.id, name: call.name, ok: true, ms: Date.now() - started, preview: 'awaiting approval' })
    return { id: call.id, name: call.name, output, isError: false, invalid: false, ms: Date.now() - started }
  }

  try {
    const raw = await runWithTimeout(tool, parsed.data, { threadId: run.threadId, approved: false, log: (m) => logLine(`${call.name}: ${m}`) })
    const { output, before, after } = isAudited(raw) ? { output: raw.result, before: raw.before, after: raw.after } : { output: raw, before: undefined, after: undefined }
    const isError = !!output && typeof output === 'object' && 'error' in (output as object) && Object.keys(output as object).length === 1
    return finish(output ?? { ok: true }, isError, false, { before, after })
  } catch (err) {
    return finish({ error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }, true)
  }
}

function runWithTimeout(tool: AgentTool, input: unknown, ctx: { threadId: string; approved: boolean; log: (m: string) => void }): Promise<unknown> {
  return Promise.race([
    tool.run(input, ctx),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${tool.name} took longer than ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)),
  ])
}

function safeSummary(tool: AgentTool, input: unknown): string | null {
  try {
    return tool.summarize?.(input) ?? null
  } catch {
    return null
  }
}

// ── The operator's side of an action ─────────────────────────────────────

/// Runs a parked outward call. The result becomes a system row the model
/// reads when the thread resumes.
export async function approveAction(actionId: string): Promise<ActionView> {
  const action = await prisma.agentAction.findUnique({ where: { id: actionId } })
  if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 })
  if (action.status !== 'pending') throw Object.assign(new Error('This action is not waiting for approval'), { statusCode: 409 })
  if (activeRun(action.threadId)) throw Object.assign(new Error('Wait for the assistant to finish its turn first'), { statusCode: 409 })
  const tool = getTool(action.tool)
  if (!tool) throw Object.assign(new Error('That tool no longer exists'), { statusCode: 410 })
  const started = Date.now()
  let output: unknown
  let before: unknown
  let after: unknown
  let ok = true
  try {
    const raw = await runWithTimeout(tool, action.input, { threadId: action.threadId, approved: true, log: (m) => logLine(`${tool.name}: ${m}`) })
    ;({ output, before, after } = isAudited(raw) ? { output: raw.result, before: raw.before, after: raw.after } : { output: raw, before: undefined, after: undefined })
    ok = !(output && typeof output === 'object' && 'error' in (output as object) && Object.keys(output as object).length === 1)
  } catch (err) {
    output = { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }
    ok = false
  }
  const updated = await prisma.agentAction.update({
    where: { id: actionId },
    data: { status: ok ? 'done' : 'failed', ok, output: output as object, before: before === undefined ? undefined : (before as object), after: after === undefined ? undefined : (after as object), error: ok ? null : String((output as any)?.error ?? ''), latencyMs: Date.now() - started },
  })
  await append(action.threadId, 'system', { text: `The operator APPROVED "${action.summary ?? action.tool}". It has been carried out. Result: ${JSON.stringify(output).slice(0, 1500)}. Continue from here — tell the operator it is done, and finish anything that depended on it.` })
  await continueTurn(action.threadId)
  return actionView(updated)
}

export async function declineAction(actionId: string, reason?: string): Promise<ActionView> {
  const action = await prisma.agentAction.findUnique({ where: { id: actionId } })
  if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 })
  if (action.status !== 'pending') throw Object.assign(new Error('This action is not waiting for approval'), { statusCode: 409 })
  if (activeRun(action.threadId)) throw Object.assign(new Error('Wait for the assistant to finish its turn first'), { statusCode: 409 })
  const updated = await prisma.agentAction.update({ where: { id: actionId }, data: { status: 'declined', ok: false, error: reason?.slice(0, 500) ?? null } })
  await append(action.threadId, 'system', { text: `The operator DECLINED "${action.summary ?? action.tool}"${reason ? ` — ${reason}` : ''}. Do not retry it. Acknowledge briefly and offer what else you can do.` })
  await continueTurn(action.threadId)
  return actionView(updated)
}

/// Reverses a done write from its audit record.
export async function undoAction(actionId: string): Promise<{ action: ActionView; note: string }> {
  const action = await prisma.agentAction.findUnique({ where: { id: actionId } })
  if (!action) throw Object.assign(new Error('Action not found'), { statusCode: 404 })
  if (action.status !== 'done') throw Object.assign(new Error('Only a completed action can be undone'), { statusCode: 409 })
  const tool = getTool(action.tool)
  if (!tool?.undo || action.before === null || action.before === undefined) throw Object.assign(new Error('This action cannot be undone'), { statusCode: 400 })
  const note = await tool.undo({ input: action.input, before: action.before, after: action.after })
  const updated = await prisma.agentAction.update({ where: { id: actionId }, data: { status: 'undone', undoneAt: new Date() } })
  await append(action.threadId, 'system', { text: `The operator UNDID "${action.summary ?? action.tool}": ${note}.` })
  return { action: actionView(updated), note }
}

function preview(output: unknown): string {
  try {
    const s = JSON.stringify(output)
    return s.length > 160 ? `${s.slice(0, 157)}…` : s
  } catch {
    return ''
  }
}

/// The stored transcript, in the wire shape. Tool results are re-serialised
/// exactly as they were given, so what the model saw is what it sees again.
/// A compaction row stands in for the range it replaced: those rows stay in
/// the table for the operator, and leave the model's view.
export function toWire(rows: { seq: number; role: string; content: MessageContent }[]): WireMessage[] {
  const out: WireMessage[] = []
  const hidden = new Set<number>()
  for (const r of rows) {
    if (r.role === 'system' && 'replaces' in r.content) for (let s = r.content.replaces[0]; s <= r.content.replaces[1]; s++) hidden.add(s)
  }
  rows.forEach(({ seq, role, content: c }) => {
    if (hidden.has(seq)) return
    if (role === 'system' && 'replaces' in c) {
      out.push({ role: 'system', content: `Earlier in this conversation (summarised, the details are no longer shown):\n${c.summary}` })
      return
    }
    if (role === 'user') out.push({ role: 'user', content: (c as { text: string }).text })
    else if (role === 'assistant') {
      const a = c as Extract<MessageContent, { toolCalls: unknown }> & { text?: string }
      out.push({
        role: 'assistant',
        content: a.text || null,
        ...(a.toolCalls?.length ? { tool_calls: a.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.raw ?? JSON.stringify(t.input) } })) } : {}),
        ...(a.reasoningDetails ? { reasoning_details: a.reasoningDetails } : {}),
      })
    } else if (role === 'tool') {
      for (const r of (c as Extract<MessageContent, { toolResults: unknown }>).toolResults) out.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.output) })
    } else if (role === 'system') out.push({ role: 'system', content: (c as { text: string }).text })
  })
  return out
}

const COMPACT_AT_CHARS = 120_000
const COMPACT_KEEP = 10

/// Client-side compaction. When the stored transcript outgrows the budget,
/// everything but the last few rows is summarised by the model into a
/// single system row that records what it replaced. Rows are never deleted:
/// the operator still sees the whole conversation; the model sees the
/// summary plus the tail.
async function compactIfNeeded(threadId: string): Promise<void> {
  const rows = await prisma.agentMessage.findMany({ where: { threadId }, orderBy: { seq: 'asc' } })
  const visible = toWire(rows.map((m) => ({ seq: m.seq, role: m.role, content: m.content as MessageContent })))
  const size = visible.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  if (size < COMPACT_AT_CHARS || rows.length <= COMPACT_KEEP + 2) return

  const lastSummary = [...rows].reverse().find((r) => r.role === 'system' && 'replaces' in (r.content as object))
  const from = lastSummary ? (lastSummary.content as { replaces: [number, number] }).replaces[1] + 1 : rows[0].seq
  const to = rows[rows.length - 1 - COMPACT_KEEP].seq
  if (to <= from) return
  const range = rows.filter((r) => r.seq >= from && r.seq <= to)
  const transcript = toWire(range.map((m) => ({ seq: m.seq, role: m.role, content: m.content as MessageContent })))
    .map((m) => `${m.role.toUpperCase()}: ${(m.content ?? (m.tool_calls ? `called ${m.tool_calls.map((t) => t.function.name).join(', ')}` : '')).slice(0, 4000)}`)
    .join('\n\n')
  const s = settings()
  try {
    const out = await streamCompletion({
      model: s.agentModel,
      tools: [],
      effort: 'low',
      maxTokens: 3000,
      messages: [
        { role: 'system', content: 'You summarise a conversation between an operator and an assistant so the assistant can continue it later. Keep every fact, id, number, decision, open question and instruction the operator gave. Drop pleasantries and the detail of tool outputs already acted on. Write plainly, in the past tense, under 600 words.' },
        { role: 'user', content: transcript },
      ],
    })
    const previous = lastSummary ? `${(lastSummary.content as { summary: string }).summary}\n\n` : ''
    await append(threadId, 'system', { summary: `${previous}${out.text.trim()}`.slice(0, 12_000), replaces: [lastSummary ? (lastSummary.content as { replaces: [number, number] }).replaces[0] : from, to] })
    if (lastSummary) await prisma.agentMessage.update({ where: { id: lastSummary.id }, data: { content: { summary: '(superseded)', replaces: [0, 0] } } })
    logLine(`compacted thread ${threadId.slice(0, 8)}: rows ${from}–${to}`)
  } catch (err) {
    logLine(`compaction failed for thread ${threadId.slice(0, 8)}; continuing uncompacted`, err)
  }
}

/// Old tool results are the bulk of a long thread and the least useful
/// part of it once the model has answered from them. Past a size, the
/// oldest are replaced by a stub — the call and its answer stay in the
/// stored transcript, only the model's view shrinks.
function trimHistory(messages: WireMessage[]) {
  let size = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  if (size <= MAX_HISTORY_CHARS) return
  for (let i = 2; i < messages.length - 6 && size > MAX_HISTORY_CHARS * 0.7; i++) {
    const m = messages[i]
    if (m.role === 'tool' && m.content && m.content.length > 200) {
      size -= m.content.length - 60
      m.content = '[an earlier tool result, no longer shown — call the tool again if you need it]'
    }
  }
}
