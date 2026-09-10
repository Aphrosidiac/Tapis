import { z } from 'zod'
import type { Chat, Message, Rule, Feedback } from '@prisma/client'
import { callParsed } from './client.js'
import { FILTER_SYSTEM, chatContextBlock, rulesBlock, feedbackBlock, transcriptLine, mapIds } from './prompts.js'
import { settings } from '../settings.js'
import { mockFilter } from './mock.js'

const FilterOutput = z.object({
  decisions: z.array(
    z.object({
      id: z.string(),
      flag: z.boolean(),
      reason: z.string(),
      ruleIds: z.array(z.string()),
    }),
  ),
})

export interface FilterDecision {
  flag: boolean
  reason: string
  ruleIds: string[]
}

export interface FilterInput {
  chat: Chat
  rules: Rule[]
  participants: Map<string, string | null>
  context: Message[]
  batch: Message[]
  feedback: Feedback[]
  bundleId: string | null
}

/// First pass. Cheap model, one question: is anything here worth a second look?
/// A message the model forgets to decide on is flagged, not dropped — the
/// default has to be the safe side.
export async function runFilter(input: FilterInput): Promise<Map<string, FilterDecision>> {
  const msgIds = mapIds('m', input.batch.map((m) => m.id))
  const ruleIds = mapIds('r', input.rules.map((r) => r.id))

  const sections: string[] = []
  sections.push(`## Chat context\n${chatContextBlock(input.chat)}`)
  sections.push(`## Tracking rules\n${rulesBlock(input.rules, ruleIds, input.participants)}`)
  const fb = feedbackBlock(input.feedback)
  if (fb) sections.push(`## Learned from the operator\n${fb}`)
  if (input.context.length) {
    sections.push(`## Earlier conversation (context only, already judged)\n${input.context.map((m) => transcriptLine(m)).join('\n')}`)
  }
  sections.push(`## New messages to judge\n${input.batch.map((m) => transcriptLine(m, msgIds.toShort.get(m.id))).join('\n')}`)
  sections.push(`Return one decision for each of: ${input.batch.map((m) => msgIds.toShort.get(m.id)).join(', ')}.`)

  const out = await callParsed({
    kind: 'FILTER',
    model: settings().filterModel,
    system: FILTER_SYSTEM,
    text: sections.join('\n\n'),
    schema: FilterOutput,
    maxTokens: 4096,
    bundleId: input.bundleId,
    mock: () => {
      const r = mockFilter('', input.batch.map((m) => ({ id: msgIds.toShort.get(m.id)!, text: m.text, type: m.type })), input.rules.map((x) => ({ id: ruleIds.toShort.get(x.id)!, text: x.text })))
      return r
    },
  })

  const decisions = new Map<string, FilterDecision>()
  for (const d of out.decisions) {
    const id = msgIds.toLong.get(d.id.trim())
    if (!id) continue
    decisions.set(id, {
      flag: d.flag,
      reason: d.reason.slice(0, 300),
      ruleIds: d.ruleIds.map((r) => ruleIds.toLong.get(r.trim())).filter((x): x is string => !!x),
    })
  }
  for (const m of input.batch) {
    if (!decisions.has(m.id)) {
      decisions.set(m.id, { flag: true, reason: 'The filter gave no decision for this message, so it was kept.', ruleIds: [] })
    }
  }
  return decisions
}
