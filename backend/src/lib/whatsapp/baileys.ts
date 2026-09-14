import { existsSync, readdirSync, rmSync } from 'fs'
import { WA_SESSION_DIR, ensureWaSessionDir } from '../paths.js'
import { parseInbound, jidFor, unwrap, historyChats, type ParsedInbound } from './inbound.js'
import { handleInbound, discoverChat, rememberContact, applyContactNames } from './ingest.js'
import prisma from '../prisma.js'

/// A linked-device WhatsApp connection, over the multi-device protocol
/// WhatsApp Web uses. Ported from BBFSystem's hardened module.
///
/// The known failure of a linked device is that it breaks QUIETLY: the phone
/// unlinks, the socket dies, the process keeps answering health checks. So:
///   - one state per real situation; `failed` and `logged-out` are distinct
///     from `reconnecting` because they need a person;
///   - a watchdog checks the actual websocket, not the last event received;
///   - sending while not connected THROWS. Never a silent success.

export type BaileysState =
  | 'off'
  | 'unlinked'
  | 'starting'
  | 'pairing'
  | 'connected'
  | 'reconnecting'
  | 'logged-out'
  | 'failed'

interface Runtime {
  sock: any
  saveCreds: () => Promise<void>
  mod: any
}

let runtime: Runtime | null = null
let state: BaileysState = 'off'
let installed: boolean | null = null

let qrDataUrl: string | null = null
let qrIssuedAt: Date | null = null
let pairingCode: string | null = null
let pairingDeadline = 0

let me: { id: string; name: string | null } | null = null
let ghostDevice: string | null = null
let lastError: string | null = null
let lastErrorAt: Date | null = null
let connectedAt: Date | null = null
let disconnectedAt: Date | null = null
let lastEventAt: Date | null = null
let lastInboundAt: Date | null = null
let lastOutboundAt: Date | null = null
let inboundStored = 0
let inboundIgnored = 0

let attempts = 0
/// Consecutive closes with a code that LOOKS terminal (401, 440). Neither is
/// proof on its own — see wireConnection — so the first is retried and only a
/// run of them is believed. Reset by a successful open.
let suspectCloses = 0
let nextRetryAt: Date | null = null
let retryTimer: NodeJS.Timeout | null = null
let watchdog: NodeJS.Timeout | null = null
let stopping = false
let startInFlight = false

let logLine: (msg: string, err?: unknown) => void = (m, e) => console.log(`[whatsapp] ${m}`, e ?? '')
export function setBaileysLogger(fn: (msg: string, err?: unknown) => void) {
  logLine = fn
}

// ── State bookkeeping ──────────────────────────────────────────────────────

function setState(next: BaileysState, error?: string | null) {
  if (state !== next) logLine(`link: ${state} → ${next}${error ? ` (${error})` : ''}`)
  state = next
  if (error !== undefined) {
    lastError = error
    lastErrorAt = error ? new Date() : lastErrorAt
  }
}

function touch() {
  lastEventAt = new Date()
}

function backoffMs(n: number) {
  return Math.min(60_000, 2_000 * 2 ** Math.min(n, 5))
}

export function hasStoredSession(): boolean {
  try {
    return existsSync(`${WA_SESSION_DIR}/creds.json`)
  } catch {
    return false
  }
}

function clearStoredSession() {
  try {
    rmSync(WA_SESSION_DIR, { recursive: true, force: true })
  } catch (err) {
    logLine('could not clear the session directory', err)
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

export function baileysReady(): boolean {
  return state === 'connected' && !!runtime?.sock?.ws?.isOpen
}

export function meInfo() {
  return me
}

export interface BaileysStatus {
  installed: boolean | null
  state: BaileysState
  socketOpen: boolean
  ready: boolean
  hasSession: boolean
  qr: string | null
  qrIssuedAt: string | null
  pairingExpiresAt: string | null
  pairingCode: string | null
  me: { id: string; name: string | null } | null
  connectedAt: string | null
  disconnectedAt: string | null
  lastEventAt: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  inboundStored: number
  inboundIgnored: number
  lastError: string | null
  lastErrorAt: string | null
  ghostDevice: string | null
  attempts: number
  nextRetryAt: string | null
  action: string | null
}

export function baileysStatus(): BaileysStatus {
  return {
    installed,
    state,
    socketOpen: !!runtime?.sock?.ws?.isOpen,
    ready: baileysReady(),
    hasSession: hasStoredSession(),
    qr: qrDataUrl,
    qrIssuedAt: qrIssuedAt?.toISOString() ?? null,
    pairingExpiresAt: pairingDeadline > Date.now() ? new Date(pairingDeadline).toISOString() : null,
    pairingCode,
    me,
    connectedAt: connectedAt?.toISOString() ?? null,
    disconnectedAt: disconnectedAt?.toISOString() ?? null,
    lastEventAt: lastEventAt?.toISOString() ?? null,
    lastInboundAt: lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: lastOutboundAt?.toISOString() ?? null,
    inboundStored,
    inboundIgnored,
    lastError,
    lastErrorAt: lastErrorAt?.toISOString() ?? null,
    ghostDevice,
    attempts,
    nextRetryAt: nextRetryAt?.toISOString() ?? null,
    action: requiredAction(),
  }
}

function requiredAction(): string | null {
  if (installed === false) return 'Install the baileys package on the server and restart.'
  if (ghostDevice) return ghostDevice
  switch (state) {
    case 'unlinked':
      return lastError
        ? `${lastError} Show a new code to try again.`
        : 'Show a code and scan it with the WhatsApp account whose chats should be read.'
    case 'logged-out':
      return 'This device was removed from the phone. Link it again to carry on.'
    case 'failed':
      return lastError ?? 'The link stopped for a reason retrying will not fix.'
    case 'pairing':
      return 'Waiting for the code to be scanned.'
    default:
      return null
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

function cancelRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  nextRetryAt = null
}

function scheduleRetry(delayOverride?: number) {
  cancelRetry()
  if (stopping) return
  const delay = delayOverride ?? backoffMs(attempts)
  nextRetryAt = new Date(Date.now() + delay)
  setState('reconnecting')
  retryTimer = setTimeout(() => {
    retryTimer = null
    nextRetryAt = null
    void start({ pair: Date.now() < pairingDeadline }).catch((err) => logLine('reconnect attempt failed', err))
  }, delay)
  retryTimer.unref?.()
}

function watchdogMs(): number {
  const raw = Number(process.env.WA_WATCHDOG_MS)
  return Number.isFinite(raw) && raw >= 100 ? raw : 30_000
}

function startWatchdog() {
  if (watchdog) return
  watchdog = setInterval(() => {
    if (state !== 'connected') return
    if (runtime?.sock?.ws?.isOpen) return
    logLine('link: socket is closed while the state said connected — forcing a reconnect')
    disconnectedAt = new Date()
    setState('reconnecting', 'The connection dropped without notifying us.')
    teardownSocket()
    attempts += 1
    scheduleRetry()
  }, watchdogMs())
  watchdog.unref?.()
}

function stopWatchdog() {
  if (watchdog) clearInterval(watchdog)
  watchdog = null
}

function teardownSocket() {
  const sock = runtime?.sock
  runtime = null
  try {
    sock?.ev?.removeAllListeners?.()
    sock?.end?.(undefined)
  } catch {
    /* already gone */
  }
}

export async function probeInstalled(): Promise<boolean> {
  if (installed !== null) return installed
  try {
    await import('baileys')
    installed = true
  } catch {
    installed = false
  }
  return installed
}

async function loadBaileys() {
  try {
    const mod: any = await import('baileys')
    installed = true
    return mod
  } catch (err) {
    installed = false
    throw new Error(`The baileys package is not available (${err instanceof Error ? err.message : String(err)}). Run npm install in backend/.`)
  }
}

export interface StartOptions {
  resumeOnly?: boolean
  pair?: boolean
  pairWithNumber?: string
}

export async function start(opts: StartOptions = {}): Promise<BaileysStatus> {
  stopping = false
  if (runtime?.sock?.ws?.isOpen && state === 'connected') return baileysStatus()
  if (startInFlight) return baileysStatus()
  if (opts.resumeOnly && !hasStoredSession()) {
    setState('unlinked', null)
    return baileysStatus()
  }
  // A person asking to link again after the phone removed the device is the
  // one moment the old keys are cleared — Baileys will not show a QR while a
  // registered creds file exists, and those creds can only earn another 401.
  if ((opts.pair || opts.pairWithNumber) && state === 'logged-out') {
    clearStoredSession()
    me = null
  }
  startInFlight = true
  try {
    return await openSocket(opts)
  } finally {
    startInFlight = false
  }
}

async function openSocket(opts: StartOptions): Promise<BaileysStatus> {
  if (opts.pair || opts.pairWithNumber) pairingDeadline = Date.now() + 5 * 60_000

  cancelRetry()
  teardownSocket()
  setState('starting', null)
  qrDataUrl = null
  qrIssuedAt = null
  pairingCode = null

  let mod: any
  try {
    mod = await loadBaileys()
  } catch (err) {
    setState('failed', err instanceof Error ? err.message : String(err))
    return baileysStatus()
  }

  const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, Browsers } = mod

  try {
    ensureWaSessionDir()
    const { state: authState, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR)

    let version: [number, number, number] | undefined
    try {
      // Without a timeout a half-dead network can park this GET for minutes,
      // and start() holds startInFlight the whole time — no retry can run.
      ;({ version } = await fetchLatestBaileysVersion({ timeout: 8_000 }))
    } catch {
      version = undefined
    }

    const logger = makeQuietLogger()
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
      logger,
      browser: Browsers.appropriate('Tapis'),
      // Marking the account online takes push notifications away from the
      // human phone. Never.
      markOnlineOnConnect: false,
      // Do not ask WhatsApp for the entire archive — years of messages cost
      // minutes of CPU on connect and we store none of the old content.
      syncFullHistory: false,
      // But DO process the recent/bootstrap sync it sends anyway. This line
      // is load-bearing and its absence is invisible.
      //
      // `makeWASocket` defaults `shouldSyncHistoryMessage` to
      // `() => !!syncFullHistory`, so leaving it out did not mean "skip the
      // old messages" — it meant Baileys answered false for INITIAL_BOOTSTRAP
      // and RECENT too, logged "History sync skipped", and never emitted
      // `messaging-history.set` at all. The chat list, every last-message
      // time and every one-to-one chat arrive in exactly that event.
      //
      // It also silently costs the app-state sync: `doAppStateSync` only runs
      // once the socket reaches the `Syncing` state, which only the history
      // path enters. That is why contacts had no names either — a real
      // account showed 199 chats, 197 of them groups from
      // `groupFetchAllParticipating` (which carries no timestamps), 196 of
      // them reading "never", and contacts as bare numbers.
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      qrTimeout: 60_000,
      // Retry receipts ask for the original of something we sent. Our
      // outbound rows keep the body, so a desynced session can heal.
      getMessage: async (key: { id?: string | null }) => {
        if (!key?.id) return undefined
        try {
          const row = await prisma.delivery.findFirst({ where: { waMessageId: key.id }, select: { body: true } })
          return row?.body ? { conversation: row.body } : undefined
        } catch {
          return undefined
        }
      },
    })

    runtime = { sock, saveCreds, mod }
    sock.ev.on('creds.update', saveCreds)
    wireConnection(sock, DisconnectReason)
    wireMessages(sock)
    wireDiscovery(sock)
    startWatchdog()

    if (opts.pairWithNumber && !authState.creds.registered) {
      const digits = opts.pairWithNumber.replace(/[^0-9]/g, '')
      setTimeout(() => {
        sock
          .requestPairingCode(digits)
          .then((code: string) => {
            pairingCode = code
            qrDataUrl = null
            setState('pairing', null)
            touch()
          })
          .catch((err: unknown) => {
            setState('failed', `Could not request a pairing code: ${err instanceof Error ? err.message : String(err)}`)
          })
      }, 3_000)
    }
  } catch (err) {
    setState('failed', err instanceof Error ? err.message : String(err))
    teardownSocket()
  }
  return baileysStatus()
}

function wireConnection(sock: any, DisconnectReason: any) {
  sock.ev.on('connection.update', async (update: any) => {
    touch()
    const { connection, lastDisconnect, qr } = update

    if (qr && !pairingCode) {
      try {
        const QRCode = (await import('qrcode')).default
        qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
        qrIssuedAt = new Date()
        setState('pairing', null)
      } catch (err) {
        setState('failed', `Could not render the pairing QR: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (connection === 'open') {
      ghostDevice = null
      attempts = 0
      suspectCloses = 0
      cancelRetry()
      qrDataUrl = null
      qrIssuedAt = null
      pairingCode = null
      pairingDeadline = 0
      connectedAt = new Date()
      disconnectedAt = null
      const raw = sock.user?.id as string | undefined
      me = raw ? { id: raw.split(':')[0].split('@')[0], name: sock.user?.name ?? null } : null
      setState('connected', null)
      // The group list is the one thing we can ask for outright.
      void refreshGroups().catch((err) => logLine('could not fetch the group list', err))
      return
    }

    if (connection !== 'close') return

    disconnectedAt = new Date()
    const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.output?.payload?.statusCode
    const detail = lastDisconnect?.error?.message ?? null
    teardownSocket()
    // A code belongs to the socket that issued it; never serve a dead one.
    qrDataUrl = null
    qrIssuedAt = null
    pairingCode = null

    switch (code) {
      case DisconnectReason.restartRequired:
        attempts = 0
        setState('starting', null)
        void start({ pair: Date.now() < pairingDeadline })
        return
      case DisconnectReason.loggedOut:
        // 401. WhatsApp sends it when the phone removed this device — and
        // also, now and then, to a socket that raced a dying one on the same
        // keys (every `tsx watch` restart is that race). The first is
        // permanent, the second heals on the next connect, and the message
        // does not say which. So the keys are never deleted here: one quiet
        // retry tells them apart, and even a real logout keeps the files
        // until a person links again (start({pair}) clears them) or unlinks.
        suspectCloses += 1
        if (suspectCloses < 2) {
          setState('reconnecting', 'WhatsApp reported this device logged out — checking once more before believing it.')
          scheduleRetry(15_000)
          return
        }
        me = null
        setState('logged-out', 'The phone removed this linked device.')
        return
      case DisconnectReason.connectionReplaced:
        // 440. Either a second process holds these keys, or the socket we
        // just closed still counted as alive when this one arrived. One is a
        // race; a run of three is a real second server, and stopping is the
        // only way to keep the two from knocking each other offline forever.
        suspectCloses += 1
        if (suspectCloses < 3) {
          setState('reconnecting', 'Another connection held this link — trying again shortly.')
          scheduleRetry(20_000 * suspectCloses)
          return
        }
        setState('failed', 'Another session keeps taking over this WhatsApp link. Only one server may hold it at a time.')
        return
      case DisconnectReason.forbidden:
        setState('failed', 'WhatsApp refused this account. It may be blocked or restricted.')
        return
      case DisconnectReason.badSession:
      case DisconnectReason.multideviceMismatch:
      default:
        // 500 is Baileys' DEFAULT for any stream error it cannot name, and
        // 411 has meant nothing since multi-device became mandatory. Neither
        // is evidence the keys are bad. An ordinary retry finds out, and a
        // genuine rejection comes back as a 401, handled above.
        if (state === 'pairing' && Date.now() >= pairingDeadline) {
          setState('unlinked', 'The pairing code expired before it was scanned.')
          return
        }
        attempts += 1
        setState('reconnecting', detail)
        scheduleRetry()
    }
  })
}

// ── Inbound ────────────────────────────────────────────────────────────────

const MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

/// Media is only fetched for messages that will be stored, and only up to a
/// sane size — a 40MB video is not a bug report.
const MEDIA_MAX_BYTES = 12 * 1024 * 1024

async function downloadMedia(sock: any, mod: any, parsed: ParsedInbound) {
  const c = parsed.content
  const node = c.imageMessage ?? c.videoMessage ?? c.audioMessage ?? c.documentMessage ?? c.stickerMessage
  if (!node) return null
  const size = Number(node.fileLength?.low ?? node.fileLength ?? 0)
  if (size > MEDIA_MAX_BYTES) {
    logLine(`skipping media download for ${parsed.waMessageId}: ${size} bytes`)
    return null
  }
  const mime: string = node.mimetype ?? 'application/octet-stream'
  const buffer: Buffer = await mod.downloadMediaMessage(parsed.raw, 'buffer', {}, { logger: makeQuietLogger(), reuploadRequest: sock.updateMediaMessage })
  // fileLength is the sender's claim; the buffer is the truth.
  if (buffer.length > MEDIA_MAX_BYTES) {
    logLine(`dropping media for ${parsed.waMessageId}: ${buffer.length} bytes after download`)
    return null
  }
  // The extension goes into a file path. A sender controls fileName, so
  // anything but a short run of letters and digits is treated as unknown —
  // "doc.pdf/../../creds" must never become part of a path.
  const claimed = node.fileName?.split('.').pop()?.toLowerCase() ?? ''
  const ext = MEDIA_EXT[mime] ?? (/^[a-z0-9]{1,8}$/.test(claimed) ? claimed : 'bin')
  return { buffer, mime: mime.split(';')[0], ext }
}

function wireMessages(sock: any) {
  sock.ev.on('messages.upsert', async (payload: any) => {
    touch()
    const messages: any[] = payload?.messages ?? []

    // 'append' is history back-fill. It is never fed to the pipeline — it
    // would replay weeks of chat — but the chat identities in it are how a
    // freshly linked account's private chats become visible at all.
    if (payload?.type !== 'notify') {
      for (const raw of messages) {
        const { parsed } = parseInbound(raw, me)
        if (!parsed) continue
        try {
          await discoverChat({
            jid: parsed.chatJid,
            name: parsed.isGroup || parsed.fromMe ? null : parsed.senderName,
            isGroup: parsed.isGroup,
            lastMessageAt: parsed.timestamp,
          })
        } catch (err) {
          logLine('could not record a chat from history', err)
        }
      }
      return
    }

    for (const raw of messages) {
      try {
        const { parsed, reason } = parseInbound(raw, me)
        if (!parsed) {
          logLine(`inbound not handled (${reason}): jid=${raw?.key?.remoteJid ?? '?'} id=${raw?.key?.id ?? '?'} content=[${Object.keys(unwrap(raw?.message) ?? {}).join(',')}]`)
          continue
        }
        lastInboundAt = new Date()
        const result = await handleInbound(parsed, (p) => downloadMedia(sock, runtime?.mod, p))
        if (result.stored) inboundStored += 1
        else {
          inboundIgnored += 1
          if (result.reason !== 'chat is not tracked') logLine(`inbound ${parsed.waMessageId} not stored: ${result.reason}`)
        }
      } catch (err) {
        logLine('failed to handle an inbound message', err)
      }
    }
  })
}

// ── Chat discovery ─────────────────────────────────────────────────────────

function contactName(c: any): string | null {
  return c?.name || c?.notify || c?.verifiedName || null
}

function wireDiscovery(sock: any) {
  sock.ev.on('messaging-history.set', async (payload: any) => {
    touch()
    // Logged on SUCCESS, not only on failure. This is the only event that
    // carries the chat list, the one-to-one chats and when each last spoke;
    // `groupFetchAllParticipating` returns groups and no timestamps. With no
    // line here, "WhatsApp sent nothing" and "we dropped it" look identical.
    logLine(
      `history sync: ${payload?.chats?.length ?? 0} chats, ${payload?.contacts?.length ?? 0} contacts, ` +
        `${payload?.messages?.length ?? 0} messages, syncType=${payload?.syncType ?? '?'}, progress=${payload?.progress ?? '?'}, latest=${!!payload?.isLatest}`,
    )
    try {
      const found = historyChats(payload)
      for (const c of found) await discoverChat(c)

      // A contact's name only matters for a chat we already know about; a
      // contact on its own is not a conversation.
      const seen = new Set(found.map((c) => c.jid))
      for (const c of payload?.contacts ?? []) {
        const name = contactName(c)
        const jid: string | undefined = c?.id
        if (!name || !jid || seen.has(jid) || !jid.endsWith('@s.whatsapp.net')) continue
        const existing = await prisma.chat.findUnique({ where: { jid } })
        if (existing) await discoverChat({ jid, name, isGroup: false })
      }

      const dated = await prisma.chat.count({ where: { lastMessageAt: { not: null } } })
      logLine(`history sync applied: ${found.filter((c) => c.lastMessageAt).length} timed here, ${dated} dated overall`)
    } catch (err) {
      logLine('could not record chats from history sync', err)
    }
  })

  const groupEvent = async (groups: any[]) => {
    for (const g of groups ?? []) {
      if (!g?.id) continue
      try {
        await discoverChat({ jid: g.id, name: g.subject ?? null, isGroup: true, participantCount: g.participants?.length ?? null })
      } catch (err) {
        logLine('could not record a group', err)
      }
    }
  }
  sock.ev.on('groups.upsert', groupEvent)
  sock.ev.on('groups.update', groupEvent)

  const contactEvent = async (contacts: any[]) => {
    let kept = 0
    for (const c of contacts ?? []) {
      const n = contactName(c)
      if (!c?.id || !n) continue
      try {
        // Remembered even when no chat exists yet. These arrive from the
        // app-state sync, which runs before the history sync has created a
        // single chat — applying them only to existing rows dropped all 905.
        await rememberContact(c.id, n)
        // A contact can be addressed by LID as well; name that chat too.
        if (typeof c.lid === 'string' && c.lid.endsWith('@lid')) await rememberContact(c.lid, n)
        kept += 1
      } catch (err) {
        logLine('could not record a contact name', err)
      }
    }
    if (kept) logLine(`address book: ${kept} contact name(s) recorded`)
  }
  sock.ev.on('contacts.upsert', contactEvent)
  sock.ev.on('contacts.update', contactEvent)
}

/// Re-pulls the address book from WhatsApp on a live socket.
///
/// The saved names ride the app-state sync, which only runs automatically
/// right after pairing — and at that moment none of the chats exist yet. This
/// is how the names are recovered without making someone scan a QR again.
export async function resyncContacts(): Promise<{ applied: number; contacts: number }> {
  const sock = requireReady()
  const collections = ['critical_unblock_low', 'regular_low', 'regular_high']

  // The stored version has to go back to zero first. Baileys asks WhatsApp
  // for a full snapshot only when it has no version for a collection
  // (`return_snapshot: (!state.version)`); with a version in hand the server
  // returns the patches SINCE it, and after a completed pairing there are
  // none — which is why an ordinary resync came back with nothing at all.
  try {
    await sock.authState.keys.set({
      'app-state-sync-version': Object.fromEntries(collections.map((c) => [c, null])),
    })
  } catch (err) {
    logLine('could not reset the app-state versions before resyncing contacts', err)
  }

  await sock.resyncAppState(collections, true)
  // The events land asynchronously through a buffered emitter; give them a
  // moment to drain before backfilling names onto chats.
  await new Promise((r) => setTimeout(r, 4_000))
  const applied = await applyContactNames()
  const contacts = await prisma.contact.count()
  logLine(`address book resync: ${contacts} contact(s) known, ${applied} chat(s) renamed`)
  return { applied, contacts }
}

/// Asks WhatsApp for every group the account is in. The one list that can be
/// fetched outright; private chats are learned from history and traffic.
export async function refreshGroups(): Promise<number> {
  const sock = requireReady()
  const groups: Record<string, any> = await sock.groupFetchAllParticipating()
  let n = 0
  for (const g of Object.values(groups)) {
    if (!g?.id) continue
    await discoverChat({ jid: g.id, name: g.subject ?? null, isGroup: true, participantCount: g.participants?.length ?? null })
    n += 1
  }
  logLine(`group list refreshed: ${n} groups`)
  return n
}

// ── Sending ────────────────────────────────────────────────────────────────

function requireReady() {
  if (!baileysReady()) {
    const why = requiredAction() ?? lastError ?? `the link is ${state}`
    throw new Error(`WhatsApp is not connected — ${why}`)
  }
  return runtime!.sock
}

export async function sendText(to: string, body: string): Promise<string | null> {
  const sock = requireReady()
  const res = await sock.sendMessage(jidFor(to), { text: body })
  lastOutboundAt = new Date()
  touch()
  return res?.key?.id ?? null
}

// ── Stopping and unlinking ─────────────────────────────────────────────────

export async function stop(reason = 'stopped'): Promise<BaileysStatus> {
  stopping = true
  cancelRetry()
  stopWatchdog()
  teardownSocket()
  qrDataUrl = null
  qrIssuedAt = null
  pairingCode = null
  pairingDeadline = 0
  attempts = 0
  suspectCloses = 0
  me = null
  setState(hasStoredSession() ? 'off' : 'unlinked', reason === 'stopped' ? null : reason)
  return baileysStatus()
}

/// Tells WhatsApp to drop the device, THEN deletes the keys. Deleting alone
/// leaves a ghost device on the phone holding one of four slots.
export async function logout(): Promise<BaileysStatus> {
  let told = false
  try {
    if (!runtime?.sock?.ws?.isOpen && hasStoredSession()) {
      await start({ resumeOnly: true })
      for (let i = 0; i < 40 && !runtime?.sock?.ws?.isOpen; i++) await new Promise((r) => setTimeout(r, 200))
    }
    if (runtime?.sock?.ws?.isOpen) {
      await runtime.sock.logout()
      told = true
    }
  } catch (err) {
    logLine('could not tell WhatsApp to remove this linked device', err)
  }

  stopping = true
  cancelRetry()
  stopWatchdog()
  teardownSocket()

  const hadSession = hasStoredSession()
  clearStoredSession()
  ghostDevice =
    told || !hadSession
      ? null
      : 'WhatsApp could not be reached to remove this device, so the phone still lists it and it still uses one of the four device slots. On the phone open WhatsApp → Settings → Linked devices and remove it there.'
  if (ghostDevice) logLine(`unlink left a ghost device: ${ghostDevice}`)

  me = null
  qrDataUrl = null
  qrIssuedAt = null
  pairingCode = null
  pairingDeadline = 0
  attempts = 0
  setState('unlinked', null)
  return baileysStatus()
}

// ── Logger shim ────────────────────────────────────────────────────────────

function makeQuietLogger(): any {
  const debug = process.env.BAILEYS_DEBUG === '1'
  const sink = (level: string) => (...args: unknown[]) => {
    if (debug) console.error(`[baileys:${level}]`, ...args)
  }
  const logger: any = {
    level: debug ? 'debug' : 'silent',
    trace: sink('trace'),
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
    fatal: sink('fatal'),
    silent: () => {},
  }
  logger.child = () => logger
  return logger
}

export function sessionFileCount(): number {
  try {
    return existsSync(WA_SESSION_DIR) ? readdirSync(WA_SESSION_DIR).length : 0
  } catch {
    return 0
  }
}
