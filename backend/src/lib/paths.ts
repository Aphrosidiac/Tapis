import { join } from 'path'
import { mkdirSync } from 'fs'

/// Downloaded media (screenshots, voice notes). Served only through an
/// authenticated route — never a static mount, because the session directory
/// below must never be reachable the same way.
export const MEDIA_DIR = join(process.cwd(), 'media')

/// Baileys keeps the linked device's Signal keys and credentials here. This is
/// a complete WhatsApp login. It is a sibling of `media/`, not a child, and the
/// override is ignored in production so nothing can move it under a served
/// directory.
export const WA_SESSION_DIR =
  process.env.NODE_ENV !== 'production' && process.env.WA_SESSION_DIR
    ? process.env.WA_SESSION_DIR
    : join(process.cwd(), '.wa-session')

export function ensureDirs() {
  mkdirSync(MEDIA_DIR, { recursive: true })
}

export function ensureWaSessionDir() {
  mkdirSync(WA_SESSION_DIR, { recursive: true })
}
