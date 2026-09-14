import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageBody } from './prompts.js'
import type { Message } from '@prisma/client'

/// What the models are shown for media. The reading must reach the
/// transcript line, and its absence must say why — a bare "[voice note]" is
/// the thing that got four real voice notes dismissed unheard.

function msg(over: Partial<Message>): Message {
  return { type: 'TEXT', text: null, mediaText: null, mediaTextStatus: 'NONE', mediaTextError: null, ...over } as Message
}

test('a transcribed voice note reads as its words', () => {
  assert.equal(messageBody(msg({ type: 'AUDIO', mediaTextStatus: 'DONE', mediaText: 'tolong tambah button tu' })), '[voice note, transcribed] tolong tambah button tu')
})

test('a described image carries the description and the caption separately', () => {
  const m = msg({ type: 'IMAGE', text: 'see this', mediaTextStatus: 'DONE', mediaText: 'Screenshot of an error dialog\nText in the image: Cannot save' })
  assert.equal(messageBody(m), '[image — Screenshot of an error dialog · Text in the image: Cannot save] Caption: see this')
})

test('a failed read says why', () => {
  const m = msg({ type: 'AUDIO', mediaTextStatus: 'FAILED', mediaTextError: 'No OpenRouter key' })
  assert.equal(messageBody(m), '[voice note — could not be read: No OpenRouter key]')
})

test('a read switched off in Settings says so, not "not transcribed"', () => {
  assert.equal(messageBody(msg({ type: 'IMAGE', mediaTextStatus: 'PENDING' })), '[image — reading is switched off in Settings]')
})

test('an image with nothing read and no caption is still an image', () => {
  assert.equal(messageBody(msg({ type: 'IMAGE' })), '[image, no caption]')
})
