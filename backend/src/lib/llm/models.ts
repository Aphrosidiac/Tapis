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
  { key: 'haiku-4.5', label: 'Claude Haiku 4.5 — cheapest, for the filter', anthropic: 'claude-haiku-4-5', openrouter: 'anthropic/claude-haiku-4.5', in: 1, out: 5, effort: false },
  { key: 'sonnet-5', label: 'Claude Sonnet 5', anthropic: 'claude-sonnet-5', openrouter: 'anthropic/claude-sonnet-5', in: 2, out: 10, effort: true },
  { key: 'sonnet-4.6', label: 'Claude Sonnet 4.6', anthropic: 'claude-sonnet-4-6', openrouter: 'anthropic/claude-sonnet-4.6', in: 3, out: 15, effort: true },
  { key: 'opus-5', label: 'Claude Opus 5 — recommended for analysis', anthropic: 'claude-opus-5', openrouter: 'anthropic/claude-opus-5', in: 5, out: 25, effort: true },
  { key: 'opus-4.8', label: 'Claude Opus 4.8', anthropic: 'claude-opus-4-8', openrouter: 'anthropic/claude-opus-4.8', in: 5, out: 25, effort: true },
  { key: 'fable-5.1', label: 'Claude Fable 5.1 — most capable, most expensive', anthropic: 'claude-fable-5-1', openrouter: 'anthropic/claude-fable-5.1', in: 10, out: 50, effort: true },
]

export function modelInfo(id: string): ModelInfo | null {
  return MODELS.find((m) => m.anthropic === id || m.openrouter === id) ?? null
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
  return m ? m[provider] : id
}
