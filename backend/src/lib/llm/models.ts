/// The models offered on the Settings screen, with both providers' ids.
/// Any other id can be typed in; it simply costs 0 in the display.

export type Provider = 'anthropic' | 'openrouter' | 'mock'

export interface ModelInfo {
  key: string
  label: string
  anthropic: string
  openrouter: string
  /// USD per million tokens.
  in: number
  out: number
  /// Whether `effort` / `reasoning_effort` is accepted.
  effort: boolean
}

export const MODELS: ModelInfo[] = [
  // OpenRouter only — no Anthropic id, so it is offered only on that provider.
  { key: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — recommended for the filter', anthropic: '', openrouter: 'deepseek/deepseek-v4-flash', in: 0.09, out: 0.18, effort: true },
  // The three below take images as well as text (prices 2026-09-17).
  { key: 'qwen3.7-flash', label: 'Qwen3.7 Flash — cheapest, reads images', anthropic: '', openrouter: 'qwen/qwen3.7-flash', in: 0.03, out: 0.13, effort: true },
  { key: 'glm-5.3-flash', label: 'GLM 5.3 Flash — reads images, strong on Chinese', anthropic: '', openrouter: 'z-ai/glm-5.3-flash', in: 0.09, out: 0.3, effort: true },
  { key: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash — reads images', anthropic: '', openrouter: 'deepseek/deepseek-v4.1-flash', in: 0.15, out: 0.6, effort: true },
  { key: 'haiku-4.5', label: 'Claude Haiku 4.5', anthropic: 'claude-haiku-4-5', openrouter: 'anthropic/claude-haiku-4.5', in: 1, out: 5, effort: false },
  { key: 'sonnet-5', label: 'Claude Sonnet 5 — recommended for analysis', anthropic: 'claude-sonnet-5', openrouter: 'anthropic/claude-sonnet-5', in: 2, out: 10, effort: true },
  { key: 'sonnet-4.6', label: 'Claude Sonnet 4.6', anthropic: 'claude-sonnet-4-6', openrouter: 'anthropic/claude-sonnet-4.6', in: 3, out: 15, effort: true },
  { key: 'opus-5', label: 'Claude Opus 5 — strongest analysis', anthropic: 'claude-opus-5', openrouter: 'anthropic/claude-opus-5', in: 5, out: 25, effort: true },
  { key: 'opus-4.8', label: 'Claude Opus 4.8', anthropic: 'claude-opus-4-8', openrouter: 'anthropic/claude-opus-4.8', in: 5, out: 25, effort: true },
  { key: 'fable-5.1', label: 'Claude Fable 5.1 — most capable, most expensive', anthropic: 'claude-fable-5-1', openrouter: 'anthropic/claude-fable-5.1', in: 10, out: 50, effort: true },
]

/// Models that take audio, for transcribing voice notes. OpenRouter ids
/// only — Claude has no audio input. Prices are per million text tokens;
/// audio tokens on these are priced at or below the text rate, so the
/// estimate errs high rather than low.
export const AUDIO_MODELS: ModelInfo[] = [
  { key: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash — recommended for voice notes', anthropic: '', openrouter: 'google/gemini-3.8-flash', in: 0.75, out: 3.75, effort: false },
  { key: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite — cheapest', anthropic: '', openrouter: 'google/gemini-3.5-flash-lite', in: 0.3, out: 2.5, effort: false },
  { key: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro — for hard audio', anthropic: '', openrouter: 'google/gemini-3.1-pro-preview', in: 2, out: 12, effort: false },
  { key: 'gpt-audio-mini', label: 'GPT Audio Mini', anthropic: '', openrouter: 'openai/gpt-audio-mini', in: 0.6, out: 2.4, effort: false },
]

/// Models for the assistant's loop. Cheap, tool-calling, long-context —
/// the harness carries the reliability, so the model can be a fraction of
/// the analysis model's price. OpenRouter ids.
export const AGENT_MODELS: ModelInfo[] = [
  { key: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — recommended', anthropic: '', openrouter: 'deepseek/deepseek-v4-flash', in: 0.09, out: 0.18, effort: true },
  { key: 'qwen3.7-flash', label: 'Qwen3.7 Flash — cheapest, reads images', anthropic: '', openrouter: 'qwen/qwen3.7-flash', in: 0.03, out: 0.13, effort: true },
  { key: 'glm-5.3-flash', label: 'GLM 5.3 Flash — reads images, strong on Chinese', anthropic: '', openrouter: 'z-ai/glm-5.3-flash', in: 0.09, out: 0.3, effort: true },
  { key: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash — reads images', anthropic: '', openrouter: 'deepseek/deepseek-v4.1-flash', in: 0.15, out: 0.6, effort: true },
  { key: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — for escalation', anthropic: '', openrouter: 'deepseek/deepseek-v4-pro', in: 1.6, out: 3.2, effort: true },
  { key: 'kimi-k2.5', label: 'Kimi K2.5', anthropic: '', openrouter: 'moonshotai/kimi-k2.5', in: 0.45, out: 2.25, effort: true },
  { key: 'qwen3-235b', label: 'Qwen3 235B (2507)', anthropic: '', openrouter: 'qwen/qwen3-235b-a22b-2507', in: 0.09, out: 0.35, effort: false },
  { key: 'minimax-m3', label: 'MiniMax M3', anthropic: '', openrouter: 'minimax/minimax-m3', in: 0.3, out: 1.2, effort: true },
  { key: 'sonnet-5-agent', label: 'Claude Sonnet 5', anthropic: 'claude-sonnet-5', openrouter: 'anthropic/claude-sonnet-5', in: 2, out: 10, effort: true },
]

export function modelInfo(id: string): ModelInfo | null {
  return (
    MODELS.find((m) => m.anthropic === id || m.openrouter === id) ??
    AUDIO_MODELS.find((m) => m.openrouter === id) ??
    AGENT_MODELS.find((m) => m.openrouter === id) ??
    null
  )
}

export function supportsEffort(id: string): boolean {
  const m = modelInfo(id)
  if (m) return m.effort
  return !/haiku|sonnet-4-5|sonnet-4\.5|opus-4-5|opus-4\.5|3-5|3\.5|3-7|3\.7/.test(id)
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0): number {
  const p = modelInfo(model)
  if (!p) return 0
  return (Math.max(0, inputTokens) * p.in + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25 + outputTokens * p.out) / 1_000_000
}

/// Translates a model id to the other provider's spelling when it is one we
/// know; unknown ids are left alone.
export function modelFor(id: string, provider: Provider): string {
  if (provider === 'mock') return id
  const m = modelInfo(id)
  // A model with no id on this provider keeps its spelling; the call will
  // say so plainly rather than silently landing on a different model.
  return m && m[provider] ? m[provider] : id
}
