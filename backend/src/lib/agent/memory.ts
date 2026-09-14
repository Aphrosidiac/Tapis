import { z } from 'zod'
import prisma from '../prisma.js'
import { defineTool } from './tools.js'

/// The assistant's memory: a directory of short files under /memories.
/// The tool speaks the same six commands as Anthropic's memory tool (view,
/// create, str_replace, insert, delete, rename) so any model that has seen
/// that tool drives it well; the store is a Postgres table so it survives
/// restarts and shows on the Memory panel.
///
/// Layout the prompt asks for:
///   operator.md            how this operator wants things done
///   clients/<name>.md      what it learned about each client beyond the chat description
///   procedures/<name>.md   ways of working that worked
///   log.md                 short dated notes, consolidated nightly

export const MEMORY_ROOT = '/memories'
const MAX_FILES = 80
const MAX_FILE_CHARS = 16_000
const OPERATOR_FILE = 'operator.md'
const CONTEXT_CAP = 6_000

export function normalizeMemoryPath(p: string): string | null {
  let s = p.trim()
  if (s.startsWith(MEMORY_ROOT)) s = s.slice(MEMORY_ROOT.length)
  s = s.replace(/^\/+/, '').replace(/\/+$/, '')
  if (s === '') return ''
  if (!/^[A-Za-z0-9_\-. ]+(\/[A-Za-z0-9_\-. ]+){0,2}$/.test(s) || s.split('/').some((seg) => seg === '.' || seg === '..')) return null
  return s
}

export async function listMemory(): Promise<{ path: string; chars: number; updatedAt: Date }[]> {
  const rows = await prisma.agentMemory.findMany({ select: { path: true, content: true, updatedAt: true }, orderBy: { path: 'asc' } })
  return rows.map((r) => ({ path: r.path, chars: r.content.length, updatedAt: r.updatedAt }))
}

export async function readMemory(path: string): Promise<string | null> {
  const p = normalizeMemoryPath(path)
  if (!p) return null
  const row = await prisma.agentMemory.findUnique({ where: { path: p } })
  return row?.content ?? null
}

export async function writeMemory(path: string, content: string): Promise<void> {
  const p = normalizeMemoryPath(path)
  if (!p) throw new Error('That is not a valid memory path')
  if (content.length > MAX_FILE_CHARS) throw new Error(`A memory file is at most ${MAX_FILE_CHARS} characters; split it`)
  const count = await prisma.agentMemory.count()
  const exists = await prisma.agentMemory.findUnique({ where: { path: p }, select: { path: true } })
  if (!exists && count >= MAX_FILES) throw new Error(`Memory holds at most ${MAX_FILES} files; consolidate before adding more`)
  await prisma.agentMemory.upsert({ where: { path: p }, create: { path: p, content }, update: { content } })
}

export async function deleteMemory(path: string): Promise<boolean> {
  const p = normalizeMemoryPath(path)
  if (!p) return false
  const r = await prisma.agentMemory.deleteMany({ where: { path: p } })
  return r.count > 0
}

/// What every turn starts with: the directory, and the operator file in
/// full (capped). The rest is read on demand.
export async function memoryContext(): Promise<string> {
  const files = await listMemory()
  const operator = files.some((f) => f.path === OPERATOR_FILE) ? await readMemory(OPERATOR_FILE) : null
  const lines: string[] = []
  lines.push(`## Your memory (${MEMORY_ROOT})`)
  if (!files.length) lines.push('(empty — nothing remembered yet)')
  else lines.push(files.map((f) => `- ${f.path} (${f.chars} chars)`).join('\n'))
  if (operator) {
    const body = operator.length > CONTEXT_CAP ? `${operator.slice(0, CONTEXT_CAP)}\n…(truncated; view the file for the rest)` : operator
    lines.push(`\n### ${OPERATOR_FILE}\n${body}`)
  }
  return lines.join('\n')
}

const Command = z.object({
  command: z.enum(['view', 'create', 'str_replace', 'insert', 'delete', 'rename']),
  path: z.string().describe('Under /memories, e.g. /memories/operator.md or /memories/clients/harvestgrow.md'),
  file_text: z.string().optional().describe('create: the whole file'),
  old_str: z.string().optional().describe('str_replace: exact text to find (must occur once)'),
  new_str: z.string().optional().describe('str_replace: replacement'),
  insert_line: z.number().int().min(0).optional().describe('insert: line number to insert after (0 = top)'),
  insert_text: z.string().optional().describe('insert: the text'),
  new_path: z.string().optional().describe('rename: the new path'),
  view_range: z.array(z.number().int()).length(2).optional().describe('view: [startLine, endLine], 1-based'),
})

defineTool({
  name: 'memory',
  tier: 'write',
  description:
    'Your memory between conversations: files under /memories. Commands: view (a directory or a file), create (whole file), str_replace (edit in place; old_str must match exactly once), insert (after a line), delete, rename. Use it to remember how the operator wants things done (operator.md), what you learn about a client (clients/<name>.md), and ways of working that worked (procedures/<name>.md). Never store keys, passwords, phone numbers, or copies of messages — the database has those; refer to people by name. Keep files short and current: edit, do not append forever.',
  schema: Command,
  summarize: (i) => `memory ${i.command} ${i.path}${i.new_path ? ` → ${i.new_path}` : ''}`,
  run: async (input) => {
    const p = normalizeMemoryPath(input.path)
    if (p === null) return { error: 'Paths are letters, digits, - _ . and at most two directory levels under /memories' }
    switch (input.command) {
      case 'view': {
        if (p === '' || !p.includes('.')) {
          const files = (await listMemory()).filter((f) => p === '' || f.path.startsWith(`${p}/`))
          return { directory: `${MEMORY_ROOT}/${p}`.replace(/\/$/, ''), files: files.map((f) => ({ path: f.path, chars: f.chars, updatedAt: f.updatedAt.toISOString() })) }
        }
        const content = await readMemory(p)
        if (content === null) return { error: `No file at ${MEMORY_ROOT}/${p}` }
        const lines = content.split('\n')
        const [a, b] = input.view_range ?? [1, lines.length]
        const slice = lines.slice(Math.max(0, a - 1), Math.min(lines.length, b))
        return { path: p, lines: lines.length, content: slice.map((l, i) => `${a + i}: ${l}`).join('\n') }
      }
      case 'create': {
        if (input.file_text === undefined) return { error: 'create needs file_text' }
        await writeMemory(p, input.file_text)
        return { ok: true, path: p, chars: input.file_text.length }
      }
      case 'str_replace': {
        if (input.old_str === undefined || input.new_str === undefined) return { error: 'str_replace needs old_str and new_str' }
        const content = await readMemory(p)
        if (content === null) return { error: `No file at ${MEMORY_ROOT}/${p}` }
        const n = content.split(input.old_str).length - 1
        if (n !== 1) return { error: n === 0 ? 'old_str was not found in the file' : `old_str occurs ${n} times; make it unique` }
        await writeMemory(p, content.replace(input.old_str, input.new_str))
        return { ok: true, path: p }
      }
      case 'insert': {
        if (input.insert_text === undefined || input.insert_line === undefined) return { error: 'insert needs insert_line and insert_text' }
        const content = (await readMemory(p)) ?? ''
        const lines = content ? content.split('\n') : []
        const at = Math.min(input.insert_line, lines.length)
        lines.splice(at, 0, ...input.insert_text.split('\n'))
        await writeMemory(p, lines.join('\n'))
        return { ok: true, path: p, lines: lines.length }
      }
      case 'delete': {
        const gone = await deleteMemory(p)
        return gone ? { ok: true, deleted: p } : { error: `No file at ${MEMORY_ROOT}/${p}` }
      }
      case 'rename': {
        const to = input.new_path ? normalizeMemoryPath(input.new_path) : null
        if (!to) return { error: 'rename needs a valid new_path' }
        const content = await readMemory(p)
        if (content === null) return { error: `No file at ${MEMORY_ROOT}/${p}` }
        await writeMemory(to, content)
        await deleteMemory(p)
        return { ok: true, from: p, to }
      }
    }
  },
})
