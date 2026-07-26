import fs from 'node:fs/promises'
import path from 'node:path'
import {itemsLogPath} from './paths.js'
import type {Item, LogRecord} from './types.js'

/**
 * The append-only item log — the library's source of truth.
 *
 * Why append rather than rewrite a json file: a rewrite interrupted at the
 * wrong moment loses the whole library, while an append interrupted loses the
 * last line. This holds work people can't regenerate, so that asymmetry
 * decides it. It's also the sync primitive — merging two libraries is
 * concatenate, sort, replay.
 *
 * See docs/asset-model.md#the-log.
 */

/**
 * A single line under 4 KB written with O_APPEND is atomic on every filesystem
 * yoinks targets, so two processes appending concurrently cannot interleave.
 * No lock file, no journal.
 */
export async function append(record: LogRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`
  await fs.mkdir(path.dirname(itemsLogPath()), {recursive: true})
  await fs.appendFile(itemsLogPath(), line, {flag: 'a'})
}

export async function readRecords(): Promise<LogRecord[]> {
  let raw: string
  try {
    raw = await fs.readFile(itemsLogPath(), 'utf8')
  } catch {
    return [] // no library yet is not an error
  }

  const records: LogRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as LogRecord
      // a half-written final line from a killed process must not poison the
      // whole library — skip what doesn't parse and keep going
      if (parsed && typeof parsed === 'object' && 'op' in parsed && 'id' in parsed) records.push(parsed)
    } catch {
      continue
    }
  }
  return records
}

/**
 * Fold records into current state. Later `ts` wins; a tombstone removes.
 *
 * Tombstones are kept forever — without them, replaying an older log would
 * resurrect deleted items.
 */
export function replay(records: LogRecord[]): {items: Map<string, Item>; tombstones: Map<string, string>} {
  const items = new Map<string, Item>()
  const tombstones = new Map<string, string>()

  for (const record of records) {
    if (record.op === 'del') {
      const existing = tombstones.get(record.id)
      if (!existing || record.ts >= existing) tombstones.set(record.id, record.ts)
      continue
    }
    // only ops we understand become items — a record from a future format, or
    // a corrupt one that still happens to parse, must not turn into content
    if (record.op !== 'put') continue

    const {op: _op, ...item} = record
    const existing = items.get(record.id)
    if (!existing || record.ts >= existing.ts) items.set(record.id, item as Item)
  }

  for (const [id, ts] of tombstones) {
    const item = items.get(id)
    // a put newer than the tombstone is a genuine undelete, and wins
    if (item && item.ts <= ts) items.delete(id)
  }

  return {items, tombstones}
}

export async function loadItems(): Promise<Item[]> {
  const {items} = replay(await readRecords())
  // ulids sort by creation time, so this is newest-first without a date parse
  return [...items.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

export async function getItem(id: string): Promise<Item | undefined> {
  const {items} = replay(await readRecords())
  return items.get(id)
}

export async function putItem(item: Item): Promise<Item> {
  await append({op: 'put', ...item})
  return item
}

export async function deleteItem(id: string, ts: string): Promise<void> {
  await append({op: 'del', id, ts})
}

/**
 * Rewrite the log with only the winning record per id, keeping every
 * tombstone. Pure housekeeping — never required for correctness.
 *
 * Writes to a temp file and renames, so an interrupted compaction leaves the
 * original log untouched.
 */
export async function compact(): Promise<{before: number; after: number}> {
  const records = await readRecords()
  const {items, tombstones} = replay(records)

  const kept: LogRecord[] = [
    ...[...items.values()].map(item => ({op: 'put' as const, ...item})),
    ...[...tombstones.entries()].map(([id, ts]) => ({op: 'del' as const, id, ts})),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const target = itemsLogPath()
  const tmp = `${target}.compacting`
  await fs.mkdir(path.dirname(target), {recursive: true})
  await fs.writeFile(tmp, kept.map(record => JSON.stringify(record)).join('\n') + (kept.length ? '\n' : ''))
  await fs.rename(tmp, target)

  return {before: records.length, after: kept.length}
}
