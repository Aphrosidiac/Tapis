export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—'
  return new Date(v).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  return new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function ago(v: string | Date | null | undefined): string {
  if (!v) return 'never'
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`
  return fmtDate(v)
}

export function usd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

export const STATUS_LABEL: Record<string, string> = { NEW: 'New', IN_PROGRESS: 'In progress', DONE: 'Done', DISMISSED: 'Dismissed' }
export const STATUS_TONE: Record<string, 'info' | 'warn' | 'ok' | 'dormant'> = { NEW: 'info', IN_PROGRESS: 'warn', DONE: 'ok', DISMISSED: 'dormant' }

/// A message's fate is a different axis from an item's status, so it gets its
/// own colour. Sharing them is how "New" and "Flagged" become the same pill.
export const PRIORITY_TONE: Record<string, 'neutral' | 'warn' | 'bad'> = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warn', URGENT: 'bad' }
export const FILTER_LABEL: Record<string, string> = { PENDING: 'Waiting', DISMISSED: 'Dismissed', FLAGGED: 'Flagged', ATTACHED: 'In an item', SKIPPED: 'Ours' }
export const FILTER_TONE: Record<string, 'neutral' | 'dormant' | 'violet' | 'ok' | 'info'> = { PENDING: 'neutral', DISMISSED: 'dormant', FLAGGED: 'violet', ATTACHED: 'ok', SKIPPED: 'info' }

export function senderOf(m: { senderName?: string | null; senderWaId: string; fromMe?: boolean }): string {
  if (m.fromMe) return 'Me'
  return m.senderName || (m.senderWaId.startsWith('lid:') ? 'Unknown contact' : `+${m.senderWaId}`)
}

export function bodyOf(m: { type: string; text?: string | null }): string {
  const t = m.text?.trim()
  switch (m.type) {
    case 'TEXT': return t || '(empty)'
    case 'IMAGE': return t ? `📷 ${t}` : '📷 Image'
    case 'VIDEO': return t ? `🎬 ${t}` : '🎬 Video'
    case 'AUDIO': return '🎤 Voice note (not transcribed yet)'
    case 'DOCUMENT': return t ? `📄 ${t}` : '📄 Document'
    case 'STICKER': return 'Sticker'
    case 'LOCATION': return '📍 Location'
    case 'CONTACT': return 'Contact card'
    default: return t || 'Unsupported message'
  }
}
