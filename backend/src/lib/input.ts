export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function strOrNull(v: unknown): string | null {
  const s = str(v)
  return s ? s : null
}

export function bool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

export function int(v: unknown, fallback: number, min?: number, max?: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  let out = n
  if (min !== undefined) out = Math.max(min, out)
  if (max !== undefined) out = Math.min(max, out)
  return out
}

export function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => str(x)).filter(Boolean)
}

/// International digits only. "abc" strips to nothing and is refused.
export function waDigits(v: unknown): string {
  return str(v).replace(/[^0-9]/g, '')
}

export function isUsableWaId(digits: string): boolean {
  return /^[0-9]{8,15}$/.test(digits)
}
