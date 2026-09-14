import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/// The disconnect codes that LOOK terminal and are not. Each case below is a
/// close that once deleted `.wa-session` or parked the link on `failed`; the
/// assertion in every one is the same: the keys are still on disk and the
/// link is going to try again.

const dir = mkdtempSync(join(tmpdir(), 'tapis-wa-'))
process.env.WA_SESSION_DIR = dir
process.env.NODE_ENV = 'test'
process.env.WA_WATCHDOG_MS = '100000'

const DisconnectReason = { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, loggedOut: 401, badSession: 500, restartRequired: 515, multideviceMismatch: 411, forbidden: 403 }
let sockets: Array<EventEmitter & { ws: { isOpen: boolean }; user: unknown; end: () => void }> = []

// `exports` is Node 26's name for the option; @types/node still knows only
// the deprecated `namedExports`, hence the cast.
mock.module('baileys', {
  exports: {
    DisconnectReason,
    Browsers: { appropriate: () => ['Tapis', 'Chrome', '1'] },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    useMultiFileAuthState: async () => ({ state: { creds: { registered: true }, keys: {} }, saveCreds: async () => {} }),
    makeCacheableSignalKeyStore: (k: unknown) => k,
    makeWASocket: () => {
      const ev = new EventEmitter()
      const sock = Object.assign(ev, { ev, ws: { isOpen: true }, user: { id: '60100000000:1@s.whatsapp.net', name: 'Us' }, end() { this.ws.isOpen = false } })
      sockets.push(sock)
      return sock
    },
  },
} as Parameters<typeof mock.module>[1])

const wa = await import('./baileys.js')

function creds() {
  writeFileSync(join(dir, 'creds.json'), '{}')
}
function close(code: number) {
  const s = sockets.at(-1)!
  s.ws.isOpen = false
  s.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: `code ${code}`, output: { statusCode: code } } } })
}
function open() {
  sockets.at(-1)!.emit('connection.update', { connection: 'open' })
}
const tick = () => new Promise((r) => setTimeout(r, 20))

before(async () => {
  creds()
  wa.setBaileysLogger(() => {})
  await wa.start({ resumeOnly: true })
  open()
})
after(async () => {
  await wa.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('500 badSession is an ordinary drop: keys kept, retry scheduled', async () => {
  close(DisconnectReason.badSession)
  await tick()
  const s = wa.baileysStatus()
  assert.equal(existsSync(join(dir, 'creds.json')), true)
  assert.equal(s.state, 'reconnecting')
  assert.ok(s.nextRetryAt)
})

test('411 multideviceMismatch likewise', async () => {
  await wa.start({})
  open()
  close(DisconnectReason.multideviceMismatch)
  await tick()
  assert.equal(existsSync(join(dir, 'creds.json')), true)
  assert.equal(wa.baileysStatus().state, 'reconnecting')
})

test('first 401 is retried with the keys; a second in a row is believed, keys still kept', async () => {
  await wa.start({})
  open()
  close(DisconnectReason.loggedOut)
  await tick()
  let s = wa.baileysStatus()
  assert.equal(existsSync(join(dir, 'creds.json')), true)
  assert.equal(s.state, 'reconnecting')
  assert.match(s.lastError ?? '', /checking once more/)

  await wa.start({})
  close(DisconnectReason.loggedOut)
  await tick()
  s = wa.baileysStatus()
  assert.equal(s.state, 'logged-out')
  assert.equal(s.hasSession, true, 'a logout keeps the files until a person acts')
  assert.equal(s.nextRetryAt, null)
})

test('linking again after a logout is what clears the old keys', async () => {
  await wa.start({ pair: true })
  assert.equal(existsSync(join(dir, 'creds.json')), false)
  assert.equal(wa.baileysStatus().state, 'starting')
})

test('a successful open resets the count, so an old 401 does not haunt the next one', async () => {
  creds()
  open()
  close(DisconnectReason.loggedOut)
  await tick()
  assert.equal(wa.baileysStatus().state, 'reconnecting')
})

test('440 is retried twice before the link is declared taken', async () => {
  await wa.start({})
  open()
  close(DisconnectReason.connectionReplaced)
  await tick()
  assert.equal(wa.baileysStatus().state, 'reconnecting')
  await wa.start({})
  close(DisconnectReason.connectionReplaced)
  await tick()
  assert.equal(wa.baileysStatus().state, 'reconnecting')
  await wa.start({})
  close(DisconnectReason.connectionReplaced)
  await tick()
  const s = wa.baileysStatus()
  assert.equal(s.state, 'failed')
  assert.match(s.lastError ?? '', /keeps taking over/)
  assert.equal(existsSync(join(dir, 'creds.json')), true)
})

test('403 forbidden still stops on sight', async () => {
  await wa.start({})
  open()
  close(DisconnectReason.forbidden)
  await tick()
  assert.equal(wa.baileysStatus().state, 'failed')
})
