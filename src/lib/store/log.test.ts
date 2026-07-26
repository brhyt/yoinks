import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {append, compact, deleteItem, getItem, loadItems, putItem, readRecords, replay} from './log.js'
import {itemsLogPath} from './paths.js'
import {ulid, type Item, type LogRecord} from './types.js'

/** Point the library at a throwaway directory. Never touch a real ~/.yoinks. */
async function withTempHome(run: () => Promise<void>): Promise<void> {
  const previous = process.env.YOINKS_HOME
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-log-'))
  process.env.YOINKS_HOME = dir
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.YOINKS_HOME
    else process.env.YOINKS_HOME = previous
    await fs.rm(dir, {recursive: true, force: true})
  }
}

const item = (id: string, ts: string, extra: Partial<Item> = {}): Item => ({
  id,
  ts,
  sha256: 'a'.repeat(64),
  source: {url: 'https://example.com/x.png', captured_at: ts},
  boards: [],
  tags: [],
  ...extra,
})

test('append then read round-trips', async () => {
  await withTempHome(async () => {
    await putItem(item('01A', '2026-01-01T00:00:00.000Z'))
    await putItem(item('01B', '2026-01-02T00:00:00.000Z'))
    const records = await readRecords()
    assert.equal(records.length, 2)
    assert.equal(records[0]!.op, 'put')
  })
})

test('a later record wins for the same id', () => {
  const records: LogRecord[] = [
    {op: 'put', ...item('01A', '2026-01-01T00:00:00.000Z', {note: 'first'})},
    {op: 'put', ...item('01A', '2026-01-02T00:00:00.000Z', {note: 'second'})},
  ]
  const {items} = replay(records)
  assert.equal(items.size, 1)
  assert.equal(items.get('01A')?.note, 'second')
})

test('an out-of-order replay still lands on the newest record', () => {
  // concatenating two machines' logs gives no ordering guarantee
  const records: LogRecord[] = [
    {op: 'put', ...item('01A', '2026-01-02T00:00:00.000Z', {note: 'newer'})},
    {op: 'put', ...item('01A', '2026-01-01T00:00:00.000Z', {note: 'older'})},
  ]
  assert.equal(replay(records).items.get('01A')?.note, 'newer')
})

test('a tombstone removes the item', () => {
  const records: LogRecord[] = [
    {op: 'put', ...item('01A', '2026-01-01T00:00:00.000Z')},
    {op: 'del', id: '01A', ts: '2026-01-02T00:00:00.000Z'},
  ]
  assert.equal(replay(records).items.size, 0)
})

test('a put newer than its tombstone is a genuine undelete', () => {
  const records: LogRecord[] = [
    {op: 'put', ...item('01A', '2026-01-01T00:00:00.000Z')},
    {op: 'del', id: '01A', ts: '2026-01-02T00:00:00.000Z'},
    {op: 'put', ...item('01A', '2026-01-03T00:00:00.000Z', {note: 'back'})},
  ]
  const {items} = replay(records)
  assert.equal(items.get('01A')?.note, 'back')
})

test('an older put does not resurrect a deleted item', () => {
  // the case tombstones exist for: replaying a stale log must not undo a delete
  const records: LogRecord[] = [
    {op: 'del', id: '01A', ts: '2026-01-02T00:00:00.000Z'},
    {op: 'put', ...item('01A', '2026-01-01T00:00:00.000Z')},
  ]
  assert.equal(replay(records).items.size, 0)
})

test('a half-written final line does not poison the library', async () => {
  await withTempHome(async () => {
    await putItem(item('01A', '2026-01-01T00:00:00.000Z'))
    await fs.appendFile(itemsLogPath(), '{"op":"put","id":"01B","ts":"2026')
    const items = await loadItems()
    assert.equal(items.length, 1)
    assert.equal(items[0]!.id, '01A')
  })
})

test('a missing log is an empty library, not an error', async () => {
  await withTempHome(async () => {
    assert.deepEqual(await loadItems(), [])
    assert.equal(await getItem('nope'), undefined)
  })
})

test('items come back newest first', async () => {
  await withTempHome(async () => {
    await putItem(item('01AAA', '2026-01-01T00:00:00.000Z'))
    await putItem(item('01CCC', '2026-01-03T00:00:00.000Z'))
    await putItem(item('01BBB', '2026-01-02T00:00:00.000Z'))
    assert.deepEqual((await loadItems()).map(i => i.id), ['01CCC', '01BBB', '01AAA'])
  })
})

test('delete then load hides the item', async () => {
  await withTempHome(async () => {
    await putItem(item('01A', '2026-01-01T00:00:00.000Z'))
    await deleteItem('01A', '2026-01-02T00:00:00.000Z')
    assert.deepEqual(await loadItems(), [])
  })
})

test('compact collapses duplicates but keeps every tombstone', async () => {
  await withTempHome(async () => {
    await putItem(item('01A', '2026-01-01T00:00:00.000Z', {note: 'first'}))
    await putItem(item('01A', '2026-01-02T00:00:00.000Z', {note: 'second'}))
    await putItem(item('01B', '2026-01-01T00:00:00.000Z'))
    await deleteItem('01B', '2026-01-03T00:00:00.000Z')

    const {before, after} = await compact()
    assert.equal(before, 4)
    assert.equal(after, 2) // one surviving put, one tombstone

    const records = await readRecords()
    assert.ok(records.some(r => r.op === 'del' && r.id === '01B'))
    assert.equal((await loadItems()).length, 1)
    assert.equal((await loadItems())[0]!.note, 'second')
  })
})

test('compacting an empty library is a no-op, not a crash', async () => {
  await withTempHome(async () => {
    const {before, after} = await compact()
    assert.equal(before, 0)
    assert.equal(after, 0)
    assert.deepEqual(await loadItems(), [])
  })
})

test('appends survive a compact — the log stays usable', async () => {
  await withTempHome(async () => {
    await putItem(item('01A', '2026-01-01T00:00:00.000Z'))
    await compact()
    await putItem(item('01B', '2026-01-02T00:00:00.000Z'))
    assert.deepEqual((await loadItems()).map(i => i.id), ['01B', '01A'])
  })
})

test('ulids sort by creation time', () => {
  const early = ulid(1_700_000_000_000, () => 0.99)
  const late = ulid(1_800_000_000_000, () => 0)
  assert.ok(early < late, 'a later timestamp must sort after, whatever the entropy')
  assert.equal(early.length, 26)
})

test('ulids minted in the same millisecond still differ', () => {
  const values = new Set(Array.from({length: 200}, () => ulid(1_700_000_000_000)))
  assert.equal(values.size, 200)
})

test('an unknown op is skipped rather than trusted', async () => {
  await withTempHome(async () => {
    await append({op: 'put', ...item('01A', '2026-01-01T00:00:00.000Z')})
    await fs.appendFile(itemsLogPath(), `${JSON.stringify({op: 'nonsense', id: '01B'})}\n`)
    // it parses and carries an id, so it survives readRecords; replay must not
    // let it become an item
    assert.equal((await loadItems()).length, 1)
  })
})
