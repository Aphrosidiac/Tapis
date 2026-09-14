import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMemoryPath } from './memory.js'
import { toWire } from './run.js'
import { getTool } from './tools.js'
import './read-tools.js'

/// The harness's guarantees, checked without a model: paths the memory
/// tool will and will not touch, the SQL door's refusals, and what the
/// model sees of a compacted transcript.

test('memory paths stay under /memories and shallow', () => {
  assert.equal(normalizeMemoryPath('/memories/operator.md'), 'operator.md')
  assert.equal(normalizeMemoryPath('clients/harvestgrow.md'), 'clients/harvestgrow.md')
  assert.equal(normalizeMemoryPath('/memories'), '')
  assert.equal(normalizeMemoryPath('../etc/passwd'), null)
  assert.equal(normalizeMemoryPath('/memories/a/../b.md'), null)
  assert.equal(normalizeMemoryPath('a/b/c/d.md'), null, 'at most two directory levels')
  assert.equal(normalizeMemoryPath('bad<name>.md'), null)
})

test('sql_query refuses anything but one SELECT, and the two private tables', async () => {
  const tool = getTool('sql_query')!
  const ctx = { threadId: 't', approved: false, log: () => {} }
  const refuse = async (sql: string) => {
    const out = (await tool.run({ sql }, ctx)) as { error?: string }
    assert.ok(out.error, `expected a refusal for: ${sql}`)
    return out.error
  }
  await refuse('DELETE FROM items')
  await refuse('SELECT 1; DROP TABLE items')
  await refuse('SELECT password FROM users')
  await refuse('SELECT value FROM app_settings')
  await refuse('WITH x AS (SELECT 1) UPDATE items SET title = 1')
  await refuse("SELECT * FROM pg_stat_activity")
})

test('a compaction row replaces its range in the wire view and nothing else', () => {
  const rows = [
    { seq: 1, role: 'user', content: { text: 'first' } },
    { seq: 2, role: 'assistant', content: { text: 'reply one' } },
    { seq: 3, role: 'user', content: { text: 'second' } },
    { seq: 4, role: 'assistant', content: { toolCalls: [{ id: 'c1', name: 'get_status', input: {}, raw: '{}' }] } },
    { seq: 5, role: 'tool', content: { toolResults: [{ id: 'c1', name: 'get_status', output: { ok: true }, isError: false, ms: 1 }] } },
    { seq: 6, role: 'system', content: { summary: 'They said first; I replied.', replaces: [1, 2] as [number, number] } },
    { seq: 7, role: 'user', content: { text: 'third' } },
  ]
  const wire = toWire(rows as never)
  assert.deepEqual(
    wire.map((m) => [m.role, typeof m.content === 'string' ? m.content.slice(0, 30) : m.content]),
    [
      ['user', 'second'],
      ['assistant', null],
      ['tool', '{"ok":true}'],
      ['system', 'Earlier in this conversation ('],
      ['user', 'third'],
    ],
  )
  assert.equal(wire[1].tool_calls?.[0].function.name, 'get_status')
  assert.equal(wire[2].tool_call_id, 'c1')
})

test('the assistant can message the operator and nobody else', async () => {
  const { assertOperatorNumber, isOperatorNumber } = await import('./guard.js')
  const op = '60100000000'
  assert.equal(assertOperatorNumber('+60 10-000 0000', op), op)
  assert.equal(isOperatorNumber('60199899069', op), false)
  assert.throws(() => assertOperatorNumber('60199899069', op), /only message the operator's own number/)
  assert.throws(() => assertOperatorNumber(op, ''), /no number it may message/)
})
