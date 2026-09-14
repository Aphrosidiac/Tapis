import { z } from 'zod'
import type { WireTool } from './provider.js'

/// The assistant's tools. Every capability is a dedicated, typed tool — no
/// shell, no free-form writes — so the harness can validate the input,
/// gate the dangerous ones, log every call with what it changed, and undo.
///
/// Tiers:
///   read    — runs freely, in parallel.
///   write   — runs, is logged with before/after, can be undone.
///   outward — leaves the box or cannot be undone: the person confirms first.

export type Tier = 'read' | 'write' | 'outward'

export interface ToolContext {
  threadId: string
  log: (msg: string) => void
  /// True when a person approved this exact call (outward tools only run
  /// this way; the harness never runs them straight from the model).
  approved: boolean
}

/// What a write tool hands back: the result the model reads, plus the
/// before/after the audit keeps and the undo needs.
export interface Audited {
  result: unknown
  before?: unknown
  after?: unknown
}

export function audited(result: unknown, before?: unknown, after?: unknown): Audited {
  return { result, before, after, [AUDITED]: true } as Audited
}
export const AUDITED = Symbol('audited')
export function isAudited(v: unknown): v is Audited {
  return !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[AUDITED] === true
}

export interface AgentTool<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  tier: Tier
  schema: T
  run: (input: z.infer<T>, ctx: ToolContext) => Promise<unknown>
  /// One line for the approval card and the audit: what this call would do.
  summarize?: (input: z.infer<T>) => string
  /// Reverses a done call from its audit record. Absent = not undoable.
  undo?: (action: { input: z.infer<T>; before: unknown; after: unknown }) => Promise<string>
}

const registry = new Map<string, AgentTool>()

export function defineTool<T extends z.ZodTypeAny>(tool: AgentTool<T>): AgentTool<T> {
  registry.set(tool.name, tool as unknown as AgentTool)
  return tool
}

export function getTool(name: string): AgentTool | undefined {
  return registry.get(name)
}

export function allTools(): AgentTool[] {
  return [...registry.values()]
}

/// The wire form. Descriptions carry examples on purpose: a cheap model
/// leans on them far more than a frontier one does.
export function wireTools(tools: AgentTool[] = allTools()): WireTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) as Record<string, unknown> },
  }))
}

/// Keeps a tool result small enough to be worth its tokens. Lists are the
/// usual offender; every list tool caps its own rows, this caps the rest.
export function clip(s: string | null | undefined, n = 400): string | null {
  if (!s) return s ?? null
  return s.length > n ? `${s.slice(0, n)}…` : s
}
