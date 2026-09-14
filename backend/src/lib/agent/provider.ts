import { secret } from '../settings.js'
import { OPENROUTER_URL, recordLlmCall, type Usage } from '../llm/client.js'

/// The one place the assistant talks to a model. OpenRouter's chat
/// completions, streamed, with tools — the OpenAI wire shape, which every
/// model on OpenRouter speaks. Nothing above this file knows the wire shape;
/// it sees text, reasoning, tool calls and usage.
///
/// Reasoning models hand back `reasoning_details` that must be echoed on the
/// next request or the model forgets what it was thinking between tool
/// calls. They are kept opaque and passed through.

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  reasoning_details?: unknown[]
}

export interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }
}

export interface ToolCall {
  id: string
  name: string
  /// Raw JSON text as the model wrote it. Parsed and validated by the caller
  /// so a malformed call becomes an error result, not a crash.
  arguments: string
}

export interface CompletionResult {
  text: string
  reasoning: string
  reasoningDetails: unknown[] | null
  toolCalls: ToolCall[]
  finishReason: string
  usage: Usage
  model: string
}

export interface StreamHandlers {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCall?: (call: { index: number; id?: string; name?: string; argumentsDelta: string }) => void
}

export interface CompletionOptions {
  model: string
  messages: WireMessage[]
  tools: WireTool[]
  effort: 'low' | 'medium' | 'high'
  maxTokens: number
  signal?: AbortSignal
  handlers?: StreamHandlers
}

export async function streamCompletion(opts: CompletionOptions): Promise<CompletionResult> {
  const key = secret('openrouterApiKey')
  if (!key) throw new Error('The assistant needs an OpenRouter API key. Add one on the Settings screen.')
  const started = Date.now()

  const body = {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    max_tokens: opts.maxTokens,
    stream: true,
    usage: { include: true },
    reasoning: { effort: opts.effort },
  }

  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/Aphrosidiac/Tapis', 'X-Title': 'Tapis' },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(300_000),
    })
  } catch (err) {
    await recordLlmCall('AGENT', opts.model, null, Date.now() - started, false, err instanceof Error ? err.message : String(err))
    throw err
  }
  if (!res.ok || !res.body) {
    const json: any = await res.json().catch(() => ({}))
    const msg = String(json?.error?.message ?? `OpenRouter returned ${res.status}`).replace(key, '••••')
    await recordLlmCall('AGENT', opts.model, null, Date.now() - started, false, msg)
    throw new Error(msg)
  }

  const out: CompletionResult = { text: '', reasoning: '', reasoningDetails: null, toolCalls: [], finishReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: opts.model }
  const calls = new Map<number, ToolCall>()
  const details: unknown[] = []

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (chunk.error) throw new Error(String(chunk.error.message ?? 'The model stream reported an error'))
        if (chunk.model) out.model = chunk.model
        if (chunk.usage) {
          out.usage = {
            input: Number(chunk.usage.prompt_tokens ?? 0) - Number(chunk.usage.prompt_tokens_details?.cached_tokens ?? 0),
            output: Number(chunk.usage.completion_tokens ?? 0),
            cacheRead: Number(chunk.usage.prompt_tokens_details?.cached_tokens ?? 0),
            cacheWrite: 0,
          }
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string' && delta.content) {
          out.text += delta.content
          opts.handlers?.onText?.(delta.content)
        }
        if (typeof delta.reasoning === 'string' && delta.reasoning) {
          out.reasoning += delta.reasoning
          opts.handlers?.onReasoning?.(delta.reasoning)
        }
        if (Array.isArray(delta.reasoning_details)) details.push(...delta.reasoning_details)
        for (const tc of delta.tool_calls ?? []) {
          const idx = Number(tc.index ?? 0)
          const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.arguments += tc.function.arguments
          calls.set(idx, cur)
          opts.handlers?.onToolCall?.({ index: idx, id: tc.id, name: tc.function?.name, argumentsDelta: tc.function?.arguments ?? '' })
        }
        if (choice.finish_reason) out.finishReason = choice.finish_reason
      }
    }
  } catch (err) {
    await recordLlmCall('AGENT', out.model, out.usage.output ? out.usage : null, Date.now() - started, false, err instanceof Error ? err.message : String(err))
    throw err
  }

  out.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c], i) => ({ ...c, id: c.id || `call_${i}` }))
  out.reasoningDetails = details.length ? mergeReasoningDetails(details) : null
  await recordLlmCall('AGENT', out.model, out.usage, Date.now() - started, true, null)
  return out
}

/// Streamed reasoning_details arrive as fragments of the same block; the
/// model wants them back whole. Fragments with the same index are joined
/// on their text fields, everything else is kept as-is.
function mergeReasoningDetails(parts: unknown[]): unknown[] {
  const byIndex = new Map<number, any>()
  const rest: unknown[] = []
  for (const p of parts as any[]) {
    if (p && typeof p.index === 'number') {
      const cur = byIndex.get(p.index)
      if (!cur) byIndex.set(p.index, { ...p })
      else {
        for (const k of ['text', 'summary', 'data', 'signature']) if (typeof p[k] === 'string') cur[k] = (cur[k] ?? '') + p[k]
      }
    } else rest.push(p)
  }
  return [...[...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v), ...rest]
}
