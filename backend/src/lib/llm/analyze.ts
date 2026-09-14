import { z } from 'zod'
import { readFile } from 'fs/promises'
import type { Chat, Message, Rule, Item } from '@prisma/client'
import { callParsed, type ImageInput } from './client.js'
import {
  ANALYZE_SYSTEM,
  chatContextBlock,
  rulesBlock,
  transcriptLine,
  mapIds,
  outputLanguageName,
  formatTime,
} from './prompts.js'
import { settings } from '../settings.js'
import { mockAnalyze } from './mock.js'

const Action = z.object({
  kind: z.enum(['create', 'attach', 'ignore']),
  messageIds: z.array(z.string()),
  itemId: z.string(),
  attachKind: z.enum(['FOLLOW_UP', 'STATUS_CHECK', 'DETAIL', 'TEAM_UPDATE', 'NONE']),
  note: z.string(),
  /// What our own side has said about this item, in these or the context
  /// messages: IN_PROGRESS for a commitment or progress, RESOLVED for
  /// "fixed / done / deployed", NONE otherwise.
  teamStatus: z.enum(['NONE', 'IN_PROGRESS', 'RESOLVED']),
  /// One line, in the output language: who said what. Empty when NONE.
  teamNote: z.string(),
  title: z.string(),
  brief: z.string(),
  suggestion: z.string(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  ruleIds: z.array(z.string()),
  extra: z.array(z.object({ label: z.string(), value: z.string() })),
})

const AnalyzeOutput = z.object({ actions: z.array(Action) })

export type AnalyzeAction = z.infer<typeof Action>

export interface OpenItem extends Pick<Item, 'id' | 'title' | 'brief' | 'status' | 'lastActivityAt'> {
  ruleIds: string[]
}

export interface AnalyzeInput {
  chat: Chat
  rules: Rule[]
  participants: Map<string, string | null>
  openItems: OpenItem[]
  flagged: Message[]
  context: Message[]
  bundleId: string | null
}

export interface AnalyzeResult {
  actions: AnalyzeAction[]
}

/// Second pass. The capable model, only on what the filter kept.
export async function runAnalysis(input: AnalyzeInput): Promise<AnalyzeResult> {
  const msgIds = mapIds('m', input.flagged.map((m) => m.id))
  const ruleIds = mapIds('r', input.rules.map((r) => r.id))
  const itemIds = mapIds('i', input.openItems.map((i) => i.id))

  const sections: string[] = []
  sections.push(`Output language: ${outputLanguageName()}.`)
  sections.push(`## Chat context\n${chatContextBlock(input.chat)}`)
  sections.push(`## Tracking rules\n${rulesBlock(input.rules, ruleIds, input.participants)}`)
  sections.push(
    `## Items already open for this chat\n` +
      (input.openItems.length
        ? input.openItems
            .map(
              (i) =>
                `${itemIds.toShort.get(i.id)} [${i.status}, last activity ${formatTime(i.lastActivityAt)}] ${i.title}\n    ${i.brief.replace(/\s+/g, ' ').slice(0, 300)}` +
                (i.ruleIds.length ? `\n    rules: ${i.ruleIds.map((r) => ruleIds.toShort.get(r)).filter(Boolean).join(', ')}` : ''),
            )
            .join('\n')
        : '(none)'),
  )
  if (input.context.length) {
    sections.push(`## Surrounding conversation (context only)\n${input.context.map((m) => transcriptLine(m)).join('\n')}`)
  }
  sections.push(
    `## Flagged messages (exact originals)\n` +
      input.flagged
        .map((m) => `${transcriptLine(m, msgIds.toShort.get(m.id))}\n    filter reason: ${m.filterReason ?? '-'}`)
        .join('\n'),
  )
  sections.push(`Every one of ${input.flagged.map((m) => msgIds.toShort.get(m.id)).join(', ')} must appear in exactly one action.`)

  const images: ImageInput[] = []
  // Screenshots are the bug report more often than the caption is.
  if (settings().analyzeImages) {
    for (const m of input.flagged) {
      if (m.type !== 'IMAGE' || !m.mediaPath || !m.mediaMime) continue
      const mime = m.mediaMime as ImageInput['mime']
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) continue
      try {
        const data = (await readFile(m.mediaPath)).toString('base64')
        images.push({ mime, data, label: `Image attached to ${msgIds.toShort.get(m.id)}:` })
      } catch {
        /* the file is gone; the transcript still says an image was sent */
      }
    }
  }

  const out = await callParsed({
    kind: 'ANALYZE',
    model: settings().analyzeModel,
    system: ANALYZE_SYSTEM,
    text: sections.join('\n\n'),
    images,
    schema: AnalyzeOutput,
    maxTokens: 16000,
    effort: 'medium',
    bundleId: input.bundleId,
    mock: () =>
      mockAnalyze(
        input.flagged.map((m) => ({ id: msgIds.toShort.get(m.id)!, text: m.text, senderName: m.senderName })),
        input.openItems.map((i) => ({ id: itemIds.toShort.get(i.id)!, title: i.title, brief: i.brief })),
        input.rules.map((r) => ({ id: ruleIds.toShort.get(r.id)! })),
      ),
  })

  // Translate short ids back; drop references to things that do not exist.
  const actions: AnalyzeAction[] = out.actions.map((a) => ({
    ...a,
    messageIds: a.messageIds.map((s) => msgIds.toLong.get(s.trim())).filter((x): x is string => !!x),
    itemId: itemIds.toLong.get(a.itemId.trim()) ?? '',
    ruleIds: a.ruleIds.map((s) => ruleIds.toLong.get(s.trim())).filter((x): x is string => !!x),
  }))

  return { actions }
}
