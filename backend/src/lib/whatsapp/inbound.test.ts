import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInbound, jidFor } from './inbound.js'

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
