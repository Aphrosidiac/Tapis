import { z } from 'zod'
import type { Chat, Message } from '@prisma/client'
import prisma from '../prisma.js'
import { settings } from '../settings.js'
import { callParsed } from './client.js'
import { chatContextBlock, outputLanguageName } from './prompts.js'

/// Translations for the reader, not for the models. The models read Chinese
/// perfectly well; the operator may not. Anything with CJK text in it —
/// the message, a transcript, an image reading — gets a rendering into the
/// output language stored beside the original. One call per bundle, never
/// per message, and a failure is a log line: a missing translation costs a
/// glance, a failed bundle costs a client.

const CJK = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/

export function needsTranslation(m: Pick<Message, 'text' | 'mediaText' | 'mediaTextStatus' | 'translationLang'>, lang: string): boolean {
  if (lang === 'zh') return false
  const reading = m.mediaTextStatus === 'DONE' ? m.mediaText : null
  const has = CJK.test(m.text ?? '') || CJK.test(reading ?? '')
  return has && m.translationLang !== lang
}

// The field is called "translation", never "reading": to a model, a
// "reading" of Chinese is its pinyin, and that is exactly what came back.
const Output = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      /// The MESSAGE passage rendered in the target language. Empty when
      /// the passage was not given.
      messageTranslation: z.string(),
      /// The TRANSCRIPT/DESCRIPTION passage rendered in the target language.
      /// Empty when the passage was not given.
      transcriptTranslation: z.string(),
    }),
  ),
})

const SYSTEM = `You translate WhatsApp messages for a business owner who cannot read Chinese. The messages mix Malay, English and Chinese, often in one sentence.

Each numbered passage has one or two parts: MESSAGE (what was typed) and/or TRANSCRIPT (what was said in a voice note, or what an image shows). Translate each part you are given into the language named, so that someone who reads only that language understands exactly what was meant. Keep the meaning, tone and register — casual stays casual, a chase stays a chase. Keep names, product names, numbers, and words that were already in the target language. Do not summarise, do not explain, do not add anything.

Never return the original Chinese, and never return a romanisation (pinyin) — the reader cannot read either. A part you were not given is an empty string.`

/// Translates every message in the list that needs it. Returns how many.
export async function translateBatch(chat: Chat, messages: Message[]): Promise<number> {
  const s = settings()
  if (!s.translateOriginals) return 0
  const lang = s.outputLanguage
  const todo = messages.filter((m) => needsTranslation(m, lang))
  if (!todo.length) return 0

  const passages = todo
    .map((m, i) => {
      const parts = [`[${i + 1}]`]
      if (CJK.test(m.text ?? '')) parts.push(`MESSAGE: ${m.text}`)
      if (m.mediaTextStatus === 'DONE' && CJK.test(m.mediaText ?? '')) parts.push(`TRANSCRIPT: ${m.mediaText}`)
      return parts.join('\n')
    })
    .join('\n\n')

  try {
    const out = await callParsed({
      kind: 'TRANSLATE',
      model: s.filterModel,
      system: SYSTEM,
      text: `Translate into ${outputLanguageName()}.\n\n${chatContextBlock(chat)}\n\n## Passages\n${passages}\n\nReturn one entry per passage id: ${todo.map((_, i) => i + 1).join(', ')}.`,
      schema: Output,
      maxTokens: 8000,
      mock: () => ({ translations: todo.map((_, i) => ({ id: String(i + 1), messageTranslation: 'MOCK translation', transcriptTranslation: 'MOCK translation' })) }),
    })
    let n = 0
    for (const t of out.translations) {
      const m = todo[Number(t.id.replace(/\D/g, '')) - 1]
      if (!m) continue
      await prisma.message.update({
        where: { id: m.id },
        data: {
          textTranslation: accept(m.text, t.messageTranslation),
          mediaTextTranslation: m.mediaTextStatus === 'DONE' ? accept(m.mediaText, t.transcriptTranslation) : null,
          translationLang: lang,
        },
      })
      n += 1
    }
    return n
  } catch (err) {
    console.warn(`[translate] ${todo.length} message(s) not translated: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}

/// A translation is only kept when it is one: not empty, not the original
/// handed back, and not still mostly Chinese.
function accept(original: string | null | undefined, candidate: string): string | null {
  const c = candidate.trim()
  if (!original || !CJK.test(original) || !c) return null
  if (c === original.trim()) return null
  const cjkChars = (c.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (cjkChars > c.length * 0.3) return null
  return c
}

/// One message, on demand — the button.
export async function translateOne(messageId: string): Promise<Message> {
  const m = await prisma.message.findUnique({ where: { id: messageId }, include: { chat: true } })
  if (!m) throw Object.assign(new Error('Message not found'), { statusCode: 404 })
  await prisma.message.update({ where: { id: m.id }, data: { translationLang: null } })
  await translateBatch(m.chat, [{ ...m, translationLang: null }])
  return (await prisma.message.findUnique({ where: { id: m.id } }))!
}
