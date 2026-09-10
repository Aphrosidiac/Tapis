import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInbound, jidFor, waSeconds, historyChats } from './inbound.js'

/// Shapes copied from what a linked device actually receives, not what a
/// test would like it to receive. The LID cases are the ones that silently
/// dropped every customer message on sibling projects.

const me = { id: '60111111111', name: 'Us' }

test('group message from a LID participant with a number beside it', () => {
  const { parsed } = parseInbound(
    {
      key: { remoteJid: '120363000000000000@g.us', fromMe: false, id: 'ABC1', participant: '80943691858039@lid', participantPn: '60123456701@s.whatsapp.net' },
      pushName: 'Ahmad',
      messageTimestamp: 1757397720,
      message: { conversation: 'report sales tu boleh tak tambah filter ikut branch' },
    },
    me,
  )
  assert.ok(parsed)
  assert.equal(parsed.isGroup, true)
  assert.equal(parsed.chatJid, '120363000000000000@g.us')
  assert.equal(parsed.senderWaId, '60123456701')
  assert.equal(parsed.senderName, 'Ahmad')
  assert.equal(parsed.type, 'TEXT')
  assert.equal(parsed.text, 'report sales tu boleh tak tambah filter ikut branch')
})

test('group message from a LID participant with NO number is kept, keyed on the LID', () => {
  const { parsed } = parseInbound(
    { key: { remoteJid: '1@g.us', fromMe: false, id: 'ABC2', participant: '67615754068059@lid' }, message: { conversation: 'hi' } },
    me,
  )
  assert.ok(parsed)
  assert.equal(parsed.senderWaId, 'lid:67615754068059')
})

test('private chat addressed by LID lands in the number-keyed chat', () => {
  const { parsed } = parseInbound(
    { key: { remoteJid: '80943691858039@lid', fromMe: false, id: 'ABC3', senderPn: '60123456701@s.whatsapp.net' }, message: { extendedTextMessage: { text: 'invoice bila?' } } },
    me,
  )
  assert.ok(parsed)
  assert.equal(parsed.isGroup, false)
  assert.equal(parsed.chatJid, '60123456701@s.whatsapp.net')
  assert.equal(parsed.senderWaId, '60123456701')
})

test('private chat by LID with no number keeps a lid chat', () => {
  const { parsed } = parseInbound({ key: { remoteJid: '5555@lid', fromMe: false, id: 'ABC4' }, message: { conversation: 'x' } }, me)
  assert.ok(parsed)
  assert.equal(parsed.chatJid, '5555@lid')
  assert.equal(parsed.senderWaId, 'lid:5555')
})

test('our own message in a group is kept as fromMe with our id', () => {
  const { parsed } = parseInbound({ key: { remoteJid: '1@g.us', fromMe: true, id: 'ABC5' }, message: { conversation: 'ok noted thanks' } }, me)
  assert.ok(parsed)
  assert.equal(parsed.fromMe, true)
  assert.equal(parsed.senderWaId, '60111111111')
  assert.equal(parsed.senderName, 'Us')
})

test('status feed, newsletters, reactions and protocol messages are declined with a reason', () => {
  const cases = [
    { key: { remoteJid: 'status@broadcast', id: 'S1' }, message: { conversation: 'x' } },
    { key: { remoteJid: '123@newsletter', id: 'S2' }, message: { conversation: 'x' } },
    { key: { remoteJid: '1@g.us', id: 'S3', participant: '60123@s.whatsapp.net' }, message: { reactionMessage: { text: '👍' } } },
    { key: { remoteJid: '1@g.us', id: 'S4', participant: '60123@s.whatsapp.net' }, message: { protocolMessage: { type: 0 } } },
  ]
  for (const raw of cases) {
    const { parsed, reason } = parseInbound(raw, me)
    assert.equal(parsed, null)
    assert.ok(reason && reason.length > 0)
  }
})

test('media types and captions, including the ephemeral wrapper', () => {
  const { parsed } = parseInbound(
    {
      key: { remoteJid: '1@g.us', id: 'M1', participant: '60123@s.whatsapp.net' },
      message: { ephemeralMessage: { message: { imageMessage: { caption: 'got error', mimetype: 'image/jpeg', fileLength: 1000 } } } },
    },
    me,
  )
  assert.ok(parsed)
  assert.equal(parsed.type, 'IMAGE')
  assert.equal(parsed.text, 'got error')
  assert.equal(parsed.hasMedia, true)
})

test('send addresses: digits go to s.whatsapp.net, LIDs stay LIDs', () => {
  assert.equal(jidFor('60123456789'), '60123456789@s.whatsapp.net')
  assert.equal(jidFor('+60 12-345 6789'), '60123456789@s.whatsapp.net')
  assert.equal(jidFor('lid:67615754068059'), '67615754068059@lid')
})

// ── History sync ───────────────────────────────────────────────────────────
// Shapes taken from what a real RECENT sync actually delivered on 2026-09-11,
// not from what the types suggest it should: sixteen chats carrying no
// `conversationTimestamp` at all, alongside fifteen thousand messages that
// carried every one of them.

test('a protobuf Long, a string and a number all decode to the same second', () => {
  const secs = 1757520000
  assert.equal(waSeconds(secs), secs)
  assert.equal(waSeconds(String(secs)), secs)
  assert.equal(waSeconds({ low: secs, high: 0, unsigned: true }), secs)
  assert.equal(waSeconds({ toNumber: () => secs }), secs)
  // and the values that used to silently become "never"
  assert.equal(waSeconds(undefined), 0)
  assert.equal(waSeconds(null), 0)
  assert.equal(waSeconds({}), 0)
  assert.equal(waSeconds('not a number'), 0)
})

test('a Long that has actually overflowed 32 bits is not truncated to its low word', () => {
  // 2^32 + 5 seconds. Reading `.low` alone would answer 5, i.e. 1970.
  assert.equal(waSeconds({ low: 5, high: 1 }), 4294967301)
})

test('chats with no conversationTimestamp are still timed, from the messages', () => {
  const out = historyChats({
    chats: [{ id: '120363000000000001@g.us', name: 'Client 2 – Website' }, { id: '60123456701@s.whatsapp.net' }],
    contacts: [{ id: '60123456701@s.whatsapp.net', notify: 'Ahmad' }],
    messages: [
      { key: { remoteJid: '120363000000000001@g.us' }, messageTimestamp: { low: 1757520000, high: 0 } },
      { key: { remoteJid: '120363000000000001@g.us' }, messageTimestamp: { low: 1757530000, high: 0 } },
      { key: { remoteJid: '60123456701@s.whatsapp.net' }, messageTimestamp: 1757400000 },
    ],
  })
  const byJid = Object.fromEntries(out.map((c) => [c.jid, c]))
  assert.equal(out.length, 2)
  // the NEWEST message wins, not the last one seen
  assert.equal(byJid['120363000000000001@g.us'].lastMessageAt?.getTime(), 1757530000 * 1000)
  assert.equal(byJid['120363000000000001@g.us'].name, 'Client 2 – Website')
  assert.equal(byJid['120363000000000001@g.us'].isGroup, true)
  // a one-to-one chat, named from the contact list — the kind that was
  // missing entirely because the group fetch cannot see them
  assert.equal(byJid['60123456701@s.whatsapp.net'].lastMessageAt?.getTime(), 1757400000 * 1000)
  assert.equal(byJid['60123456701@s.whatsapp.net'].name, 'Ahmad')
  assert.equal(byJid['60123456701@s.whatsapp.net'].isGroup, false)
})

test('a conversation known only from its messages still becomes a chat', () => {
  const out = historyChats({
    chats: [],
    messages: [{ key: { remoteJid: '60111222333@s.whatsapp.net' }, messageTimestamp: 1757000000 }],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].jid, '60111222333@s.whatsapp.net')
  assert.equal(out[0].lastMessageAt?.getTime(), 1757000000 * 1000)
})

test('conversationTimestamp is used when it IS present, and loses to a newer message', () => {
  const out = historyChats({
    chats: [{ id: '1@g.us', name: 'G', conversationTimestamp: { low: 1757000000, high: 0 } }],
    messages: [{ key: { remoteJid: '1@g.us' }, messageTimestamp: 1757999999 }],
  })
  assert.equal(out[0].lastMessageAt?.getTime(), 1757999999 * 1000)
})

test('the status feed, channels and broadcast lists never become chats', () => {
  const out = historyChats({
    chats: [{ id: 'status@broadcast' }, { id: '123@newsletter' }, { id: '456@broadcast' }],
    messages: [
      { key: { remoteJid: 'status@broadcast' }, messageTimestamp: 1757000000 },
      { key: { remoteJid: '789@newsletter' }, messageTimestamp: 1757000000 },
    ],
  })
  assert.deepEqual(out, [])
})

test('an empty or malformed payload is not an error', () => {
  assert.deepEqual(historyChats({}), [])
  assert.deepEqual(historyChats(null), [])
  assert.deepEqual(historyChats({ chats: null, messages: undefined }), [])
})
