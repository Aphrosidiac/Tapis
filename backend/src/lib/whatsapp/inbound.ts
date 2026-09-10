/// Turns a raw Baileys message into the shape the rest of the system stores.
///
/// Two addressing facts cost sibling projects real days and are handled here
/// on purpose:
///  - a one-to-one chat may arrive as `...@lid` rather than `...@s.whatsapp.net`,
///    with the phone number beside it in `senderPn`;
///  - a group message's sender is `key.participant`, which may itself be a LID,
///    with the number in `participantPn` when WhatsApp bothers to send it.
/// Every reason this declines a message is logged by the caller.

export const LID_PREFIX = 'lid:'

export type InboundType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'STICKER' | 'LOCATION' | 'CONTACT' | 'OTHER'

export interface ParsedInbound {
  waMessageId: string
  chatJid: string
  isGroup: boolean
  /// Phone digits, or `lid:<digits>` when WhatsApp gave no number.
  senderWaId: string
  senderName: string | null
  fromMe: boolean
  type: InboundType
  text: string | null
  quotedWaMessageId: string | null
  timestamp: Date
  hasMedia: boolean
  /// The unwrapped content, kept only long enough to download media.
  content: any
  raw: any
}

export function unwrap(message: any): any {
  let m = message
  for (let i = 0; i < 4 && m; i++) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message
    else if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message
    else if (m.editedMessage) m = m.editedMessage.message
    else break
  }
  return m
}

export function messageType(m: any): InboundType | 'reaction' | 'protocol' | 'unknown' {
  if (!m) return 'unknown'
  if (m.conversation || m.extendedTextMessage) return 'TEXT'
  if (m.imageMessage) return 'IMAGE'
  if (m.videoMessage) return 'VIDEO'
  if (m.documentMessage) return 'DOCUMENT'
  if (m.audioMessage) return 'AUDIO'
  if (m.stickerMessage) return 'STICKER'
  if (m.locationMessage || m.liveLocationMessage) return 'LOCATION'
  if (m.contactMessage || m.contactsArrayMessage) return 'CONTACT'
  if (m.reactionMessage) return 'reaction'
  if (m.protocolMessage || m.senderKeyDistributionMessage) return 'protocol'
  if (m.pollCreationMessage || m.pollCreationMessageV3 || m.buttonsMessage || m.listMessage || m.templateMessage) return 'OTHER'
  return 'unknown'
}

export function messageText(m: any): string | null {
  if (!m) return null
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.pollCreationMessage?.name ??
    m.pollCreationMessageV3?.name ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    null
  )
}

function quotedId(m: any): string | null {
  const ctx =
    m?.extendedTextMessage?.contextInfo ??
    m?.imageMessage?.contextInfo ??
    m?.videoMessage?.contextInfo ??
    m?.documentMessage?.contextInfo ??
    m?.audioMessage?.contextInfo ??
    null
  return ctx?.stanzaId ?? null
}

/// Phone digits from a `@s.whatsapp.net` jid, else null.
function digitsOf(jid: unknown): string | null {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null
  return jid.split('@')[0].split(':')[0]
}

/// The identity for a person: number when available, else `lid:` + LID.
function personId(primary: unknown, ...pnCandidates: unknown[]): string | null {
  for (const c of pnCandidates) {
    const d = digitsOf(c)
    if (d) return d
  }
  if (typeof primary !== 'string') return null
  if (primary.endsWith('@s.whatsapp.net')) return primary.split('@')[0].split(':')[0]
  if (primary.endsWith('@lid')) return `${LID_PREFIX}${primary.split('@')[0].split(':')[0]}`
  return null
}

export interface ParseResult {
  parsed: ParsedInbound | null
  reason: string | null
}

export function parseInbound(raw: any, me: { id: string; name: string | null } | null): ParseResult {
  const jid: string | undefined = raw?.key?.remoteJid
  const id: string | undefined = raw?.key?.id
  if (!jid || !id) return { parsed: null, reason: 'no jid or id' }

  if (jid === 'status@broadcast') return { parsed: null, reason: 'status feed' }
  if (jid.endsWith('@newsletter')) return { parsed: null, reason: 'channel/newsletter' }
  if (jid.endsWith('@broadcast')) return { parsed: null, reason: 'broadcast list' }

  const isGroup = jid.endsWith('@g.us')
  const fromMe = !!raw.key.fromMe

  let chatJid: string
  let senderWaId: string | null

  if (isGroup) {
    chatJid = jid
    senderWaId = fromMe
      ? me?.id ?? 'me'
      : personId(raw.key.participant, raw.key.participantPn, raw.participantPn)
  } else {
    // A one-to-one chat is keyed on the number when one is known, so the same
    // person arriving under a LID one day and a number the next lands in one
    // chat rather than two.
    const other = personId(jid, raw.key.senderPn, raw.key.participantPn)
    if (!other) return { parsed: null, reason: `unrecognised chat address ${jid}` }
    chatJid = other.startsWith(LID_PREFIX) ? `${other.slice(LID_PREFIX.length)}@lid` : `${other}@s.whatsapp.net`
    senderWaId = fromMe ? me?.id ?? 'me' : other
  }

  if (!senderWaId) return { parsed: null, reason: `group message with no sender (${jid})` }

  const content = unwrap(raw.message)
  if (!content) return { parsed: null, reason: 'no content (probably a key exchange or deletion)' }

  const type = messageType(content)
  if (type === 'reaction') return { parsed: null, reason: 'reaction' }
  if (type === 'protocol') return { parsed: null, reason: 'protocol message' }
  if (type === 'unknown') return { parsed: null, reason: `unknown content [${Object.keys(content).join(',')}]` }

  const seconds = Number(raw.messageTimestamp?.low ?? raw.messageTimestamp ?? 0)
  const hasMedia = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER'].includes(type)

  return {
    parsed: {
      waMessageId: id,
      chatJid,
      isGroup,
      senderWaId,
      senderName: fromMe ? me?.name ?? null : (raw.pushName as string | undefined) || null,
      fromMe,
      type,
      text: messageText(content),
      quotedWaMessageId: quotedId(content),
      timestamp: seconds > 0 ? new Date(seconds * 1000) : new Date(),
      hasMedia,
      content,
      raw,
    },
    reason: null,
  }
}

/// Where a send goes. The `@lid` branch is load-bearing: stripping a LID to
/// digits and appending `@s.whatsapp.net` addresses a stranger.
export function jidFor(waId: string): string {
  if (waId.startsWith(LID_PREFIX)) return `${waId.slice(LID_PREFIX.length).replace(/[^0-9]/g, '')}@lid`
  if (waId.includes('@')) return waId
  return `${waId.replace(/[^0-9]/g, '')}@s.whatsapp.net`
}


// ── History sync ───────────────────────────────────────────────────────────

/// WhatsApp timestamps arrive as a protobuf Long ({low, high}), a string, or
/// a plain number depending on the field and which codec path decoded it.
/// Reading `.low` alone looked correct and quietly produced 0 for every chat
/// in a real history sync, which is how 199 chats ended up with no time.
export function waSeconds(v: any): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.floor(n) : 0
  }
  if (typeof v.toNumber === 'function') {
    const n = v.toNumber()
    return Number.isFinite(n) ? Math.floor(n) : 0
  }
  if (typeof v.low === 'number') return v.low + (typeof v.high === 'number' ? v.high * 4294967296 : 0)
  return 0
}

export interface HistoryChat {
  jid: string
  name: string | null
  isGroup: boolean
  lastMessageAt: Date | null
}

const UNINTERESTING = (jid: string) =>
  jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')

/// Everything a history-sync payload says about which conversations exist and
/// when each last spoke.
///
/// Two sources, because the obvious one is empty: a real RECENT sync
/// delivered 16 chats and 15,000 messages, and not one of those chats carried
/// a `conversationTimestamp`. The messages — which this used to throw away —
/// are the reliable source, and they also reveal the one-to-one chats that
/// the group fetch cannot see.
export function historyChats(payload: any): HistoryChat[] {
  const names = new Map<string, string>()
  for (const c of payload?.contacts ?? []) {
    const n = c?.name || c?.notify || c?.verifiedName || null
    if (c?.id && n) names.set(c.id, n)
  }

  const lastAt = new Map<string, number>()
  const note = (jid: unknown, secs: number) => {
    if (typeof jid !== 'string' || !jid || !secs) return
    if (UNINTERESTING(jid)) return
    if (secs > (lastAt.get(jid) ?? 0)) lastAt.set(jid, secs)
  }

  const meta = new Map<string, { name: string | null; isGroup: boolean }>()
  for (const chat of payload?.chats ?? []) {
    const jid: string | undefined = chat?.id
    if (!jid || UNINTERESTING(jid)) continue
    meta.set(jid, { name: chat.name || names.get(jid) || null, isGroup: jid.endsWith('@g.us') })
    note(jid, waSeconds(chat.conversationTimestamp))
  }
  for (const m of payload?.messages ?? []) note(m?.key?.remoteJid, waSeconds(m?.messageTimestamp))

  return [...new Set([...meta.keys(), ...lastAt.keys()])].map((jid) => {
    const m = meta.get(jid)
    const secs = lastAt.get(jid) ?? 0
    return {
      jid,
      name: m?.name ?? names.get(jid) ?? null,
      isGroup: m?.isGroup ?? jid.endsWith('@g.us'),
      lastMessageAt: secs ? new Date(secs * 1000) : null,
    }
  })
}
