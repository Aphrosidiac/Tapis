import { z } from 'zod'
import { readFile } from 'fs/promises'
import type { Chat, Message } from '@prisma/client'
import prisma from '../prisma.js'
import { settings, transcriptionConfigured } from '../settings.js'
import { callParsed, callTranscribe, type ImageInput } from './client.js'
import { chatContextBlock, outputLanguageName } from './prompts.js'
import { translateBatch } from './translate.js'

/// Reading the media before anyone judges it.
///
/// A voice note the filter "cannot hear" and a screenshot it "cannot see"
/// used to be flagged on their neighbours alone — which is guessing. Now
/// each is read once, the reading is stored on the message beside the
/// untouched original, and both passes and the operator see the same words:
///   - AUDIO  → a verbatim transcript in the language spoken;
///   - IMAGE  → a short description plus any text visible in it, in the
///              operator's output language.
/// A failure is recorded on the message and never stops the bundle: the
/// transcript line then says what could not be read and why.

const READABLE: Message['type'][] = ['IMAGE', 'AUDIO']

/// Whether a stored media message is one this step will read.
export function mediaReadable(type: Message['type'], mime: string | null): boolean {
  if (!READABLE.includes(type)) return false
  if (type === 'IMAGE') return /^image\/(jpeg|png|gif|webp)$/.test(mime ?? '')
  return (mime ?? '').startsWith('audio/')
}

const DescribeOutput = z.object({
  /// One to three sentences. What the picture is and what it shows.
  description: z.string(),
  /// Text visible in the image, transcribed as-is. Empty if none.
  textInImage: z.string(),
})

const DESCRIBE_SYSTEM = `You describe images sent in a business's WhatsApp chats so that a text-only reader can judge whether the image is part of a client request, complaint or bug report.

Write a factual description in the language named — what kind of image it is (screenshot, photo, document scan, chart…), what it shows, and anything that would matter to a software team or a business (an error dialog, a wrong number, a broken layout, a damaged product). Then transcribe any text visible in the image exactly as written, in its own language, keeping the reading order. Do not guess at what you cannot read; do not interpret beyond what is visible.`

export interface MediaReadSummary {
  read: number
  failed: number
  skipped: number
}

/// Reads every message in the list still marked PENDING. Returns fresh copies
/// of the ones it touched so the caller can use the text without reloading.
export async function understandMedia(chat: Chat, messages: Message[]): Promise<MediaReadSummary> {
  const summary: MediaReadSummary = { read: 0, failed: 0, skipped: 0 }
  for (const m of messages) {
    if (m.mediaTextStatus !== 'PENDING') continue
    const outcome = await readOne(chat, m)
    if (outcome === 'read') summary.read += 1
    else if (outcome === 'failed') summary.failed += 1
    else summary.skipped += 1
  }
  return summary
}

/// Reads one message regardless of its current status — the retry button.
export async function rereadMedia(messageId: string): Promise<Message> {
  const m = await prisma.message.findUnique({ where: { id: messageId }, include: { chat: true } })
  if (!m) throw Object.assign(new Error('Message not found'), { statusCode: 404 })
  if (!m.mediaPath || !mediaReadable(m.type, m.mediaMime)) {
    throw Object.assign(new Error('There is nothing to read from this message'), { statusCode: 400 })
  }
  await prisma.message.update({ where: { id: m.id }, data: { mediaTextStatus: 'PENDING', mediaTextError: null, translationLang: null } })
  await readOne(m.chat, { ...m, mediaTextStatus: 'PENDING' })
  const fresh = (await prisma.message.findUnique({ where: { id: m.id } }))!
  await translateBatch(m.chat, [fresh])
  return (await prisma.message.findUnique({ where: { id: m.id } }))!
}

async function readOne(chat: Chat, m: Message): Promise<'read' | 'failed' | 'skipped'> {
  const s = settings()
  if (!m.mediaPath || !mediaReadable(m.type, m.mediaMime)) {
    await prisma.message.update({ where: { id: m.id }, data: { mediaTextStatus: 'NONE' } })
    return 'skipped'
  }
  // Switched off: stays PENDING so switching it on later picks it up, but
  // the transcript line must not wait for it.
  if (m.type === 'AUDIO' && !s.transcribeVoice) return 'skipped'
  if (m.type === 'IMAGE' && !s.describeImages) return 'skipped'

  let buffer: Buffer
  try {
    buffer = await readFile(m.mediaPath)
  } catch {
    await prisma.message.update({ where: { id: m.id }, data: { mediaTextStatus: 'FAILED', mediaTextError: 'The media file is no longer on disk' } })
    return 'failed'
  }

  try {
    const { text, model } = m.type === 'AUDIO' ? await transcribe(chat, m, buffer) : await describe(chat, m, buffer)
    await prisma.message.update({
      where: { id: m.id },
      data: { mediaText: text, mediaTextStatus: 'DONE', mediaTextError: null, mediaTextModel: model },
    })
    return 'read'
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    await prisma.message.update({ where: { id: m.id }, data: { mediaTextStatus: 'FAILED', mediaTextError: reason } })
    return 'failed'
  }
}

async function transcribe(chat: Chat, m: Message, audio: Buffer): Promise<{ text: string; model: string }> {
  if (!transcriptionConfigured()) {
    throw new Error('Voice notes need an OpenRouter API key — the Anthropic API takes no audio. Add one on the Settings screen.')
  }
  const s = settings()
  const who = m.senderName ? `${m.senderName} sent this` : 'A client sent this'
  const out = await callTranscribe({
    audio,
    mime: m.mediaMime ?? 'audio/ogg',
    model: s.transcribeModel,
    hint: `${who} in the chat below.\n${chatContextBlock(chat)}`,
    mock: () => ({ transcript: 'MOCK transcript of a voice note', language: 'mock', unintelligible: false }),
  })
  const text = out.unintelligible || !out.transcript.trim() ? '' : out.transcript.trim()
  if (!text) throw new Error('No intelligible speech was heard in this voice note')
  return { text, model: s.provider === 'mock' ? 'mock' : s.transcribeModel }
}

async function describe(chat: Chat, m: Message, image: Buffer): Promise<{ text: string; model: string }> {
  const s = settings()
  const img: ImageInput = { mime: m.mediaMime as ImageInput['mime'], data: image.toString('base64'), label: 'The image:' }
  const caption = m.text?.trim() ? `The sender's caption: "${m.text.trim()}"` : 'The image was sent with no caption.'
  const out = await callParsed({
    kind: 'MEDIA',
    model: s.filterModel,
    system: DESCRIBE_SYSTEM,
    text: `Describe in ${outputLanguageName()}.\n\n${chatContextBlock(chat)}\n${caption}`,
    images: [img],
    schema: DescribeOutput,
    maxTokens: 1500,
    mock: () => ({ description: 'MOCK description of an image', textInImage: '' }),
  })
  const desc = out.description.trim()
  const ocr = out.textInImage.trim()
  const text = ocr ? `${desc}\nText in the image: ${ocr}` : desc
  if (!text) throw new Error('The model returned an empty description')
  return { text, model: s.provider === 'mock' ? 'mock' : s.filterModel }
}
