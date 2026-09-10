import { existsSync, readdirSync, rmSync } from 'fs'
import { WA_SESSION_DIR, ensureWaSessionDir } from '../paths.js'
import { parseInbound, jidFor, unwrap, type ParsedInbound } from './inbound.js'
import { handleInbound, discoverChat } from './ingest.js'
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

function scheduleRetry() {
  cancelRetry()
  if (stopping) return
  const delay = backoffMs(attempts)
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
      ;({ version } = await fetchLatestBaileysVersion())
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
      // Recent history only. It is how existing chats become visible; full
      // history costs minutes of CPU and we store none of the old content.
      syncFullHistory: false,
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
        clearStoredSession()
        me = null
        setState('logged-out', 'The phone removed this linked device.')
        return
      case DisconnectReason.connectionReplaced:
        setState('failed', 'Another session took over this WhatsApp link. Only one server may hold it at a time.')
        return
      case DisconnectReason.badSession:
      case DisconnectReason.multideviceMismatch:
        clearStoredSession()
        me = null
        setState('unlinked', 'The stored session was rejected. Link the phone again.')
        return
      case DisconnectReason.forbidden:
        setState('failed', 'WhatsApp refused this account. It may be blocked or restricted.')
        return
      default:
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
  const ext = MEDIA_EXT[mime] ?? (node.fileName?.split('.').pop() ?? 'bin')
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
    try {
      const names = new Map<string, string>()
      for (const c of payload?.contacts ?? []) {
        const n = contactName(c)
        if (c?.id && n) names.set(c.id, n)
      }
      for (const chat of payload?.chats ?? []) {
        const jid: string | undefined = chat?.id
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue
        const isGroup = jid.endsWith('@g.us')
        const ts = Number(chat.conversationTimestamp?.low ?? chat.conversationTimestamp ?? 0)
        await discoverChat({
          jid,
          name: chat.name || names.get(jid) || null,
          isGroup,
          lastMessageAt: ts > 0 ? new Date(ts * 1000) : null,
        })
      }
      for (const [jid, name] of names) {
        if (!jid.endsWith('@s.whatsapp.net')) continue
        const existing = await prisma.chat.findUnique({ where: { jid } })
        if (existing) await discoverChat({ jid, name, isGroup: false })
      }
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
    for (const c of contacts ?? []) {
      const n = contactName(c)
      if (!c?.id || !n || !c.id.endsWith('@s.whatsapp.net')) continue
      try {
        const existing = await prisma.chat.findUnique({ where: { jid: c.id } })
        if (existing) await discoverChat({ jid: c.id, name: n, isGroup: false })
      } catch {
        /* cosmetic */
      }
    }
  }
  sock.ev.on('contacts.upsert', contactEvent)
  sock.ev.on('contacts.update', contactEvent)
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
