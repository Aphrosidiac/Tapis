import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import prisma from '../prisma.js'
import { settings, providerApiKey, secret } from '../settings.js'
import { supportsEffort, MODELS, AUDIO_MODELS, AGENT_MODELS } from './models.js'
import { mockCall } from './mock.js'

/// One place that talks to a model. Two providers behind one call:
///  - Anthropic directly, through the official SDK with structured outputs;
///  - OpenRouter, through its chat-completions API with a strict JSON schema.
/// Either way the reply is re-validated with Zod here — a provider's "strict"
/// is a promise, and this is where it is checked. Every call is recorded in
/// llm_calls with its token counts so the pipeline's cost is a number.

export function llmConfigured(): boolean {
  return !!providerApiKey()
}

export class LlmRefusal extends Error {}

export interface ImageInput {
  mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
  label: string
}

export interface ParsedCallOptions<T> {
  kind: 'FILTER' | 'ANALYZE' | 'MEDIA' | 'TRANSLATE' | 'AGENT'
  /// What the mock provider answers with, when it is the provider.
  mock?: () => unknown
  model: string
  system: string
  text: string
  images?: ImageInput[]
  schema: z.ZodType<T>
  maxTokens: number
  effort?: 'low' | 'medium' | 'high'
  bundleId?: string | null
}

interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export async function callParsed<T>(opts: ParsedCallOptions<T>): Promise<T> {
  const started = Date.now()
  let usage: Usage | null = null
  try {
    const provider = settings().provider
    const out =
      provider === 'mock'
        ? viaMock(opts)
        : provider === 'openrouter'
          ? await viaOpenRouter(opts)
          : await viaAnthropic(opts)
    usage = out.usage
    await record(opts, usage, Date.now() - started, true, null)
    return out.data
  } catch (err) {
    await record(opts, usage, Date.now() - started, false, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ── Mock ───────────────────────────────────────────────────────────────────

function viaMock<T>(opts: ParsedCallOptions<T>): { data: T; usage: Usage } {
  if (!opts.mock) throw new Error('The mock provider has no answer for this call')
  return { data: mockCall(opts.schema, opts.mock), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}

// ── Anthropic ──────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null
let anthropicKey = ''

function anthropic(): Anthropic {
  const key = secret('anthropicApiKey')
  if (!key) throw new Error('No Anthropic API key. Add one on the Settings screen.')
  if (!anthropicClient || anthropicKey !== key) {
    anthropicClient = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 180_000 })
    anthropicKey = key
  }
  return anthropicClient
}

async function viaAnthropic<T>(opts: ParsedCallOptions<T>): Promise<{ data: T; usage: Usage }> {
  const content: Anthropic.ContentBlockParam[] = []
  for (const img of opts.images ?? []) {
    content.push({ type: 'text', text: img.label })
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })
  }
  content.push({ type: 'text', text: opts.text })

  const response = await anthropic().messages.parse({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: {
      format: zodOutputFormat(opts.schema),
      ...(opts.effort && supportsEffort(opts.model) ? { effort: opts.effort } : {}),
    },
  })
  const usage: Usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  }
  if (response.stop_reason === 'refusal') {
    throw new LlmRefusal(`The model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`)
  }
  if (response.stop_reason === 'max_tokens') throw new Error(`The model ran out of output tokens (${opts.maxTokens}) before finishing`)

  const parsed = response.parsed_output as T | null | undefined
  if (parsed !== null && parsed !== undefined) return { data: parsed, usage }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return { data: validate(opts.schema, text), usage }
}

// ── OpenRouter ─────────────────────────────────────────────────────────────

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

async function viaOpenRouter<T>(opts: ParsedCallOptions<T>): Promise<{ data: T; usage: Usage }> {
  const key = secret('openrouterApiKey')
  if (!key) throw new Error('No OpenRouter API key. Add one on the Settings screen.')

  const userContent: unknown[] = []
  for (const img of opts.images ?? []) {
    userContent.push({ type: 'text', text: img.label })
    userContent.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })
  }
  userContent.push({ type: 'text', text: opts.text })

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: userContent },
    ],
    max_tokens: opts.maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'output', strict: true, schema: z.toJSONSchema(opts.schema) },
    },
    // Providers that enforce the schema go first; a silent fall-through to
    // one that ignores response_format looks like a stupid model, not a bug.
    provider: { order: ['Anthropic', 'Amazon Bedrock', 'Google Vertex'], allow_fallbacks: true },
    ...(opts.effort && supportsEffort(opts.model) ? { reasoning: { effort: opts.effort } } : {}),
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Aphrosidiac/Tapis',
      'X-Title': 'Tapis',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.error?.message ?? `OpenRouter returned ${res.status}`
    throw new Error(String(msg).replace(key, '••••'))
  }
  const choice = json?.choices?.[0]
  const usage: Usage = {
    input: Number(json?.usage?.prompt_tokens ?? 0) - Number(json?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    output: Number(json?.usage?.completion_tokens ?? 0),
    cacheRead: Number(json?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    cacheWrite: 0,
  }
  if (choice?.message?.refusal) throw new LlmRefusal(`The model declined this request: ${choice.message.refusal}`)
  if (choice?.finish_reason === 'length') throw new Error(`The model ran out of output tokens (${opts.maxTokens}) before finishing`)
  const text: string = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  return { data: validate(opts.schema, text), usage }
}

// ── Audio ──────────────────────────────────────────────────────────────────

const AUDIO_FORMATS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/aiff': 'aiff',
}

export const TranscriptOutput = z.object({
  /// Verbatim, in the language spoken. Empty when nothing intelligible.
  transcript: z.string(),
  /// e.g. "Malay", "English and Chinese".
  language: z.string(),
  /// True when the audio is silence, music, or unintelligible.
  unintelligible: z.boolean(),
})
export type Transcript = z.infer<typeof TranscriptOutput>

export interface TranscribeOptions {
  audio: Buffer
  mime: string
  model: string
  /// Chat context that helps a listener: who is talking, what the project is.
  hint: string
  mock?: () => unknown
}

const TRANSCRIBE_SYSTEM = `You transcribe WhatsApp voice notes for a business that tracks client requests. The speaker may use Malay, English, Chinese, or all three in one sentence — often Malaysian colloquial speech.

Write down exactly what is said, in the language it is said, as the speaker would write it themselves. Keep the code-switching; do not translate. Use normal punctuation. Leave out filler ("um", "eh") unless it carries meaning. Never invent words you cannot hear: mark an unclear stretch as [unclear]. If there is no speech, say so with an empty transcript and unintelligible=true.`

/// Listens to one voice note. Always OpenRouter: the Anthropic API has no
/// audio input, so this is the one call that needs that key whatever the
/// provider setting says.
export async function callTranscribe(opts: TranscribeOptions): Promise<Transcript> {
  const started = Date.now()
  const record_ = (usage: Usage | null, ok: boolean, error: string | null) =>
    record({ kind: 'MEDIA', model: opts.model, system: '', text: '', schema: TranscriptOutput, maxTokens: 0 }, usage, Date.now() - started, ok, error)
  try {
    if (settings().provider === 'mock') {
      if (!opts.mock) throw new Error('The mock provider has no transcript for this call')
      const data = mockCall(TranscriptOutput, opts.mock)
      await record_({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, true, null)
      return data
    }
    const key = secret('openrouterApiKey')
    if (!key) throw new Error('Voice notes need an OpenRouter API key — the Anthropic API takes no audio. Add one on the Settings screen.')
    const format = AUDIO_FORMATS[opts.mime.split(';')[0].trim().toLowerCase()]
    if (!format) throw new Error(`Audio type "${opts.mime}" is not one the transcription model accepts`)

    const body = {
      model: opts.model,
      messages: [
        { role: 'system', content: TRANSCRIBE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Context: ${opts.hint}\n\nTranscribe this voice note.` },
            { type: 'input_audio', input_audio: { data: opts.audio.toString('base64'), format } },
          ],
        },
      ],
      max_tokens: 4096,
      response_format: { type: 'json_schema', json_schema: { name: 'transcript', strict: true, schema: z.toJSONSchema(TranscriptOutput) } },
    }
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/Aphrosidiac/Tapis', 'X-Title': 'Tapis' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String(json?.error?.message ?? `OpenRouter returned ${res.status}`).replace(key, '••••'))
    const choice = json?.choices?.[0]
    const usage: Usage = {
      input: Number(json?.usage?.prompt_tokens ?? 0) - Number(json?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output: Number(json?.usage?.completion_tokens ?? 0),
      cacheRead: Number(json?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      cacheWrite: 0,
    }
    if (choice?.message?.refusal) throw new LlmRefusal(`The model declined this request: ${choice.message.refusal}`)
    const text: string = typeof choice?.message?.content === 'string' ? choice.message.content : ''
    const data = validate(TranscriptOutput, text)
    await record_(usage, true, null)
    return data
  } catch (err) {
    await record_(null, false, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ── Shared ─────────────────────────────────────────────────────────────────

function validate<T>(schema: z.ZodType<T>, text: string): T {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`The model did not return JSON. Reply began: ${text.slice(0, 200)}`)
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error(`The model returned malformed JSON. Reply began: ${text.slice(0, 200)}`)
  }
  const check = schema.safeParse(json)
  if (!check.success) {
    const issue = check.error.issues[0]
    throw new Error(`The model's JSON did not match the schema: ${issue?.message} at ${issue?.path.join('.')}. Reply began: ${text.slice(0, 200)}`)
  }
  return check.data
}

/// Any call, from anywhere, into the ledger. The assistant's loop records
/// through this because its calls do not fit ParsedCallOptions.
export async function recordLlmCall(kind: ParsedCallOptions<unknown>['kind'], model: string, usage: Usage | null, latencyMs: number, ok: boolean, error: string | null) {
  return record({ kind, model, system: '', text: '', schema: z.any(), maxTokens: 0 }, usage, latencyMs, ok, error)
}

export type { Usage }

async function record(opts: ParsedCallOptions<unknown>, usage: Usage | null, latencyMs: number, ok: boolean, error: string | null) {
  try {
    await prisma.llmCall.create({
      data: {
        kind: opts.kind,
        model: settings().provider === 'mock' ? 'mock' : opts.model,
        bundleId: opts.bundleId ?? null,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        cacheReadTokens: usage?.cacheRead ?? 0,
        cacheWriteTokens: usage?.cacheWrite ?? 0,
        latencyMs,
        ok,
        error: error ? error.slice(0, 1000) : null,
      },
    })
  } catch (e) {
    console.error('could not record an LLM call', e)
  }
}

/// Proves the key works without spending on a completion.
export async function testProvider(): Promise<{ ok: boolean; message: string }> {
  const s = settings()
  try {
    if (s.provider === 'mock') return { ok: true, message: 'Mock provider: no model is called. Briefs will say MOCK.' }
    if (s.provider === 'openrouter') {
      const key = secret('openrouterApiKey')
      if (!key) return { ok: false, message: 'No OpenRouter key is configured.' }
      const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return { ok: false, message: res.status === 401 ? 'OpenRouter rejected the key.' : `OpenRouter returned ${res.status}.` }
      const json: any = await res.json()
      const limit = json?.data?.limit
      // The label OpenRouter returns contains fragments of the key. Not shown.
      return { ok: true, message: `Key accepted${limit != null ? ` (key limit $${limit}, used $${Number(json?.data?.usage ?? 0).toFixed(2)})` : ''}. Filter: ${s.filterModel}. Analysis: ${s.analyzeModel}.` }
    }
    const m = await anthropic().models.retrieve(s.filterModel)
    return { ok: true, message: `Key accepted. ${m.display_name ?? m.id} is available.` }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, message: 'Anthropic rejected the key.' }
    if (err instanceof Anthropic.NotFoundError) return { ok: false, message: `The key works but the model "${s.filterModel}" was not found.` }
    if (err instanceof Anthropic.APIError) return { ok: false, message: `Anthropic returned ${err.status}: ${err.message}` }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function modelCatalogue() {
  return MODELS
}

export function audioModelCatalogue() {
  return AUDIO_MODELS
}

export function agentModelCatalogue() {
  return AGENT_MODELS
}
