import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {createReadStream, createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {Readable, Writable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {createGunzip, createGzip} from 'node:zlib'
import {CommandError, envelopeFor, ok, type Envelope} from '../agent/json.js'
import {boardKey, ensureBoard} from './ingest.js'
import {append, readRecords, replay} from './log.js'
import {blobDir, blobMetaPath, ensureLibrary, findOriginal, libraryDir} from './paths.js'
import {scoreItem, type Filters} from './query.js'
import {isoNow, type LogRecord} from './types.js'

/**
 * The `.pluck` bundle — the manual half of sync.
 *
 * A gzipped tar holding a manifest, the exported records, and the blobs those
 * records reference. Import replays them through the same last-write-wins and
 * tombstone rules as the log, which is what makes importing the same bundle
 * twice a no-op and makes importing a friend's board leave your own notes on a
 * shared image alone — different item ids, same blob.
 *
 * The tar is hand-rolled rather than a dependency. A bundle needs one narrow
 * slice of ustar — regular files, short names, one header block each — and
 * writing it costs less than a package while keeping `tar tzf hero-refs.pluck`
 * working on any machine.
 *
 * See docs/asset-model.md#export-bundle.
 */

export type Manifest = {format: number; created_at: string; items: number; blobs: number}

const FORMAT = 1

const BLOCK = 512
const SPACE = 0x20
const TYPE_FILE = '0'
const EMPTY = Buffer.alloc(0)

/** The ustar size field is 11 octal digits; past that a tar needs GNU extensions. */
const MAX_ENTRY = 8 ** 11 - 1

const SHA256 = /^[0-9a-f]{64}$/
const ORIGINAL = /^original(\.[a-z0-9]{1,8})?$/i

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const corrupt = (detail: string): CommandError =>
  new CommandError('store_error', `That doesn’t read as a .pluck bundle — ${detail}.`)

const truncated = (): CommandError =>
  new CommandError('store_error', 'That bundle is cut short — the file is incomplete or corrupt.')

// --- tar --------------------------------------------------------------------

/**
 * A ustar header block. Field layout, by offset: name 0, mode 100, uid 108,
 * gid 116, size 124, mtime 136, checksum 148, type 156, magic 257, version 263.
 * Numbers are octal, NUL-terminated; everything unset stays zero.
 */
function tarHeader(name: string, size: number, mtime: number): Buffer {
  const encoded = Buffer.from(name, 'utf8')
  if (encoded.length > 100) throw new CommandError('store_error', `bundle entry name is too long: ${name}`)
  if (size > MAX_ENTRY) throw new CommandError('store_error', `${name} is too large for a bundle entry`)

  const block = Buffer.alloc(BLOCK)
  encoded.copy(block, 0)
  block.write(octal(0o644, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii')
  block.write(octal(0, 8), 116, 'ascii')
  block.write(octal(size, 12), 124, 'ascii')
  block.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii')
  block.write(TYPE_FILE, 156, 'ascii')
  block.write('ustar', 257, 'ascii')
  block.write('00', 263, 'ascii')

  // the checksum covers its own field read as spaces, so it can only be filled
  // in after every other field — six octal digits, then NUL and a space
  block.fill(SPACE, 148, 156)
  block.write(octal(checksumOf(block), 7), 148, 'ascii')
  block[154] = 0
  block[155] = SPACE
  return block
}

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0')

function checksumOf(block: Buffer): number {
  let sum = 0
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? SPACE : block[index]!
  return sum
}

function parseOctal(field: Buffer): number {
  const digits = field.toString('ascii').replace(/[^0-7]/g, '')
  return digits ? Number.parseInt(digits, 8) : 0
}

function fieldText(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

const padding = (size: number): number => (size % BLOCK ? BLOCK - (size % BLOCK) : 0)

function tarWriter(sink: Writable) {
  const write = async (chunk: Buffer): Promise<void> => {
    if (!sink.write(chunk)) await once(sink, 'drain')
  }
  const pad = async (size: number): Promise<void> => {
    const rest = padding(size)
    if (rest) await write(Buffer.alloc(rest))
  }

  return {
    async entry(name: string, body: Buffer): Promise<void> {
      await write(tarHeader(name, body.length, Date.now()))
      await write(body)
      await pad(body.length)
    },

    /** Streamed from disk, because a bundled video must never become a buffer. */
    async fileEntry(name: string, file: string, size: number): Promise<void> {
      await write(tarHeader(name, size, Date.now()))
      let sent = 0
      for await (const chunk of createReadStream(file)) {
        const bytes = chunk as Buffer
        sent += bytes.length
        if (sent > size) throw new CommandError('store_error', `${file} grew while it was being exported`)
        await write(bytes)
      }
      if (sent !== size) throw new CommandError('store_error', `${file} shrank while it was being exported`)
      await pad(size)
    },

    /** Two zero blocks. Their absence is how a truncated bundle gives itself away. */
    end: () => write(Buffer.alloc(BLOCK * 2)),
  }
}

type TarEntry = {name: string; size: number; type: string}

type Reader = {
  exactly(want: number): Promise<Buffer>
  chunks(want: number): AsyncGenerator<Buffer>
  skip(count: number): Promise<void>
  /** Let go of the source. The archive is over; whatever follows it is not ours. */
  stop(): void
}

/** How far ahead of the consumer the decoder is allowed to run. */
const READ_AHEAD = 64 * 1024

/**
 * Pull-based bytes over a gzipped source, so an entry body can be handed on in
 * pieces rather than buffered whole.
 *
 * Backpressure is applied by holding back the compressed input rather than by
 * pausing the decoded side. Both bound memory, but a paused zlib stream holds
 * what it has already decoded in an internal buffer and drops that buffer if it
 * later errors — so pausing would lose the tail of a perfectly good archive on
 * the way to reporting a problem that came after it.
 *
 * A stored error is only raised once the queue runs dry, for the same reason:
 * bytes we already hold are answers, and a tar that has reached its
 * end-of-archive marker has nothing left to ask for.
 */
function byteReader(input: NodeJS.ReadableStream): Reader {
  const gunzip = createGunzip()
  const queue: Buffer[] = []
  let held = 0
  let ended = false
  let failure: Error | undefined
  let stopped = false
  let waiters: Array<() => void> = []

  const notify = (): void => {
    const waiting = waiters
    waiters = []
    for (const resume of waiting) resume()
  }
  const idle = (): Promise<void> => new Promise<void>(resolve => waiters.push(resolve))

  gunzip.on('data', chunk => {
    const bytes = chunk as Buffer
    if (bytes.length) {
      queue.push(bytes)
      held += bytes.length
    }
    notify()
  })
  gunzip.on('end', () => {
    ended = true
    notify()
  })
  gunzip.on('error', error => {
    failure = error as Error
    notify()
  })

  const feed = (async () => {
    try {
      for await (const chunk of input) {
        while (held >= READ_AHEAD && !stopped && !failure) await idle()
        if (stopped || failure) break
        if (!gunzip.write(chunk as Buffer)) await once(gunzip, 'drain')
      }
      if (!stopped) gunzip.end()
    } catch (error) {
      // a read error on the source would otherwise leave the loop below waiting
      // for bytes that stopped coming
      failure ??= error as Error
      notify()
    }
  })()
  feed.catch(() => {})

  function stop(): void {
    stopped = true
    notify()
    gunzip.destroy()
    if (typeof (input as Readable).destroy === 'function') (input as Readable).destroy()
  }

  /** Up to `want` bytes — whatever has already arrived. Empty means a clean end of stream. */
  async function take(want: number): Promise<Buffer> {
    while (!held && !ended && !failure) await idle()

    const first = queue[0]
    if (!first) {
      if (failure) throw failure
      return EMPTY
    }
    if (first.length <= want) {
      queue.shift()
      held -= first.length
      notify() // room again, so the feed can resume
      return first
    }
    queue[0] = first.subarray(want)
    held -= want
    notify()
    return first.subarray(0, want)
  }

  async function* chunks(want: number): AsyncGenerator<Buffer> {
    let left = want
    while (left > 0) {
      const chunk = await take(left)
      if (!chunk.length) throw truncated()
      left -= chunk.length
      yield chunk
    }
  }

  return {
    chunks,
    stop,
    async exactly(want: number): Promise<Buffer> {
      const parts: Buffer[] = []
      for await (const chunk of chunks(want)) parts.push(chunk)
      return parts.length === 1 ? parts[0]! : Buffer.concat(parts, want)
    },
    async skip(count: number): Promise<void> {
      let left = count
      while (left > 0) {
        const chunk = await take(left)
        if (!chunk.length) throw truncated()
        left -= chunk.length
      }
    },
  }
}

/** Undefined at the end-of-archive marker. Anything short of a full block is truncation. */
async function nextEntry(reader: Reader): Promise<TarEntry | undefined> {
  const block = await reader.exactly(BLOCK)
  if (block.every(byte => byte === 0)) return undefined

  if (parseOctal(block.subarray(148, 156)) !== checksumOf(block)) throw corrupt('a header block is damaged')

  const prefix = fieldText(block, 345, 155)
  const name = fieldText(block, 0, 100)
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: parseOctal(block.subarray(124, 136)),
    type: fieldText(block, 156, 1) || TYPE_FILE,
  }
}

// --- export -----------------------------------------------------------------

export async function exportBundle(
  opts: {board?: string; tags?: string[]; since?: string; until?: string},
  out: NodeJS.WritableStream,
): Promise<Manifest> {
  const records = await readRecords()
  const {items, tombstones} = replay(records)

  const filters: Filters = {
    boards: opts.board ? [boardKey(opts.board)] : undefined,
    tags: opts.tags?.length ? opts.tags : undefined,
    since: opts.since,
    until: opts.until,
  }
  const unfiltered = !filters.boards && !filters.tags && !filters.since && !filters.until

  // membership is decided on any put an id ever had, not just the winning one,
  // so an item that sat on the board and was then deleted still carries its
  // tombstone into the bundle rather than quietly resurrecting on the far side
  const wanted = new Set<string>()
  for (const record of records) {
    if (record.op === 'put' && scoreItem(record, undefined, filters) !== undefined) wanted.add(record.id)
  }
  // a tombstone whose put is long gone has no board and no tags to match on, so
  // it can only ride along on an unfiltered export
  if (unfiltered) for (const id of tombstones.keys()) wanted.add(id)

  const selected: LogRecord[] = []
  for (const id of [...wanted].sort()) {
    const item = items.get(id)
    if (item) selected.push({op: 'put', ...item})
    const ts = tombstones.get(id)
    if (ts) selected.push({op: 'del', id, ts})
  }

  const blobs = await bundledBlobs(selected)
  const manifest: Manifest = {
    format: FORMAT,
    created_at: isoNow(),
    items: selected.length,
    blobs: blobs.length,
  }

  const gzip = createGzip()
  const flushed = new Promise<void>((resolve, reject) => {
    gzip.once('error', reject)
    out.once('error', reject)
    gzip.once('end', resolve)
  })
  // a failing write rejects this before anything awaits it, and an unattended
  // rejection would take the process down with it
  flushed.catch(() => {})

  // `out` is never ended here: it may be stdout, and a caller that opened a
  // file is the one that has to close it
  gzip.pipe(out, {end: false})

  try {
    const tar = tarWriter(gzip)
    await tar.entry('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    await tar.entry('items.jsonl', Buffer.from(selected.map(record => `${JSON.stringify(record)}\n`).join('')))
    for (const blob of blobs) {
      for (const file of blob.files) await tar.fileEntry(file.name, file.path, file.size)
    }
    await tar.end()
    gzip.end()
    await flushed
  } catch (error) {
    gzip.destroy()
    throw error
  }

  return manifest
}

type BundledBlob = {sha256: string; files: Array<{name: string; path: string; size: number}>}

/** The blobs the selected records reference, skipping any the library has lost. */
async function bundledBlobs(selected: readonly LogRecord[]): Promise<BundledBlob[]> {
  const shas = new Set<string>()
  for (const record of selected) if (record.op === 'put' && record.sha256) shas.add(record.sha256)

  const blobs: BundledBlob[] = []
  for (const sha256 of [...shas].sort()) {
    const original = await findOriginal(sha256)
    if (!original) continue

    const files: BundledBlob['files'] = [
      {name: `blobs/${sha256}/${path.basename(original)}`, path: original, size: await sizeOf(original)},
    ]
    const meta = blobMetaPath(sha256)
    const metaSize = await sizeOf(meta).catch(() => undefined)
    if (metaSize !== undefined) files.push({name: `blobs/${sha256}/meta.json`, path: meta, size: metaSize})

    blobs.push({sha256, files})
  }
  return blobs
}

const sizeOf = async (file: string): Promise<number> => (await fs.stat(file)).size

// --- import -----------------------------------------------------------------

type Staged = {temp: string; target: string}

/**
 * Merge a bundle into the library.
 *
 * Nothing lands until the whole bundle has been read: blobs are staged beside
 * the library and renamed into place at the end, and the records are appended
 * only after that. A bundle that runs out halfway therefore leaves the library
 * exactly as it was rather than half-applied.
 *
 * `items` counts records actually merged, `blobs` counts bodies written, and
 * `skipped` counts what the library already held — so a second import of the
 * same bundle reports nothing merged and nothing written.
 */
export async function importBundle(
  input: NodeJS.ReadableStream,
  opts: {dryRun?: boolean} = {},
): Promise<{items: number; blobs: number; skipped: number}> {
  const dryRun = opts.dryRun === true

  const reader = byteReader(input)
  const staged: Staged[] = []
  let stagingDir: string | undefined

  const staging = async (): Promise<string> => {
    if (!stagingDir) {
      stagingDir = path.join(libraryDir(), `.importing-${process.pid}-${Date.now()}`)
      await fs.mkdir(stagingDir, {recursive: true})
    }
    return stagingDir
  }

  try {
    const head = await nextEntry(reader)
    if (!head || head.name !== 'manifest.json') throw corrupt('it has no manifest')
    const manifest = parseManifest(await reader.exactly(head.size))
    await reader.skip(padding(head.size))

    let incoming: LogRecord[] | undefined
    const seen = new Set<string>()
    let written = 0
    let held = 0

    for (let entry = await nextEntry(reader); entry; entry = await nextEntry(reader)) {
      const size = entry.size
      if (entry.type !== TYPE_FILE) {
        await reader.skip(size)
      } else if (entry.name === 'items.jsonl') {
        if (incoming) throw corrupt('it carries two item logs')
        incoming = parseRecords(await reader.exactly(size))
      } else {
        const blob = blobTarget(entry.name)
        if (!blob) {
          await reader.skip(size) // an entry from a format we don't know is not ours to apply
        } else {
          seen.add(blob.sha256)
          const original = blob.file !== 'meta.json'
          const target = original ? path.join(blobDir(blob.sha256), blob.file) : blobMetaPath(blob.sha256)
          // blobs merge by hash: bytes we already hold cost nothing to receive.
          // meta is never overwritten either — the local one may already carry
          // a derived palette the sender's doesn't have.
          const have = original ? (await findOriginal(blob.sha256)) !== undefined : await exists(target)
          if (original) have ? held++ : written++

          if (have || dryRun) {
            // still hashed on a dry run, so `--dry-run` catches a bad blob too
            await drainEntry(reader, size, undefined, original ? blob.sha256 : undefined)
          } else {
            const temp = path.join(await staging(), `${blob.sha256}-${blob.file}`)
            await drainEntry(reader, size, temp, original ? blob.sha256 : undefined)
            staged.push({temp, target})
          }
        }
      }
      await reader.skip(padding(size))
    }

    // the end-of-archive marker is the end of the bundle, so stop reading here
    // rather than decoding whatever a shell redirect appended to the file
    reader.stop()

    if (!incoming) throw corrupt('it has no items.jsonl')
    if (incoming.length !== manifest.items) throw corrupt(`its manifest promises ${manifest.items} records`)
    if (seen.size !== manifest.blobs) throw corrupt(`its manifest promises ${manifest.blobs} blobs`)

    const pending = unheldRecords(incoming, await readRecords())

    if (!dryRun) {
      await ensureLibrary()
      for (const {temp, target} of staged) {
        await fs.mkdir(path.dirname(target), {recursive: true})
        await fs.rename(temp, target)
      }
      // records last, so every blob an item points at is already in place
      for (const record of pending) await append(record)

      // boards.json doesn't travel in the bundle, so recreate any board the
      // imported items claim membership of. Without this, sharing a board —
      // the whole point of a bundle — lands the items but leaves `pluck
      // boards` empty, and the board is invisible to everything that lists
      // them. Existing boards are untouched: ensureBoard is idempotent.
      const boards = new Set<string>()
      for (const record of pending) {
        if (record.op === 'put') for (const board of record.boards ?? []) boards.add(board)
      }
      for (const board of boards) await ensureBoard(board)
    }

    return {items: pending.length, blobs: written, skipped: incoming.length - pending.length + held}
  } catch (error) {
    for (const {temp} of staged) await fs.rm(temp, {force: true})
    reader.stop()
    if (error instanceof CommandError) throw error
    throw new CommandError('store_error', `That file isn’t a readable .pluck bundle — ${messageOf(error)}`)
  } finally {
    if (stagingDir) await fs.rm(stagingDir, {recursive: true, force: true})
  }
}

function parseManifest(body: Buffer): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw corrupt('its manifest is not readable json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupt('its manifest is not a record')

  const {format, created_at, items, blobs} = parsed as Partial<Manifest>
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    throw corrupt('its manifest names no format version')
  }
  if (format > FORMAT) {
    throw new CommandError(
      'unsupported',
      `That bundle is format ${format} and this pluck reads up to ${FORMAT}. Upgrade to open it.`,
    )
  }
  if (typeof items !== 'number' || typeof blobs !== 'number') throw corrupt('its manifest has no counts')

  return {format, created_at: typeof created_at === 'string' ? created_at : '', items, blobs}
}

/**
 * Unlike the library's own log, a line that doesn't parse here is refused. A
 * torn last line in `items.jsonl` means the process died mid-append; a torn
 * line inside a bundle means the bundle is damaged, and applying the rest of it
 * would merge a fraction of somebody's board without saying so.
 */
function parseRecords(body: Buffer): LogRecord[] {
  const records: LogRecord[] = []
  for (const line of body.toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw corrupt('one of its records is not readable json')
    }
    const record = parsed as Partial<LogRecord>
    if (
      !record ||
      typeof record !== 'object' ||
      (record.op !== 'put' && record.op !== 'del') ||
      typeof record.id !== 'string' ||
      typeof record.ts !== 'string'
    ) {
      throw corrupt('one of its records is not an item')
    }
    records.push(parsed as LogRecord)
  }
  return records
}

/**
 * The records the library doesn't already hold something at least as new for.
 *
 * Equal timestamps count as held, which is exactly what makes a second import
 * of the same bundle append nothing at all.
 */
function unheldRecords(incoming: readonly LogRecord[], local: readonly LogRecord[]): LogRecord[] {
  const newest = new Map<string, string>()
  for (const record of local) {
    const key = `${record.op}:${record.id}`
    const at = newest.get(key)
    if (!at || record.ts > at) newest.set(key, record.ts)
  }
  return incoming.filter(record => {
    const at = newest.get(`${record.op}:${record.id}`)
    return at === undefined || record.ts > at
  })
}

/**
 * `blobs/<sha256>/original.<ext>` or `blobs/<sha256>/meta.json`, and nothing
 * else. The target path is rebuilt from a validated hash rather than joined
 * from the entry name, so no name in a bundle can write outside the library.
 */
function blobTarget(name: string): {sha256: string; file: string} | undefined {
  const parts = name.split('/')
  if (parts.length !== 3 || parts[0] !== 'blobs') return undefined

  const sha256 = parts[1]!
  const file = parts[2]!
  if (!SHA256.test(sha256)) return undefined
  if (file !== 'meta.json' && !ORIGINAL.test(file)) return undefined
  return {sha256, file}
}

/** Consumes exactly `size` bytes, optionally to disk, optionally verifying the hash. */
async function drainEntry(reader: Reader, size: number, into?: string, sha256?: string): Promise<void> {
  const hash = sha256 === undefined ? undefined : createHash('sha256')

  if (into === undefined) {
    for await (const chunk of reader.chunks(size)) hash?.update(chunk)
  } else {
    // The blob directory may not exist yet, and createWriteStream would fail
    // ENOENT and destroy itself.
    await fs.mkdir(path.dirname(into), {recursive: true})

    // pipeline owns the sink's whole lifetime: it attaches an error handler,
    // waits for the flush, and destroys cleanly on failure. Hand-rolling
    // write/drain/end/destroy leaks an unhandled 'error' event the moment a
    // queued fs write lands after a destroy — which crashes the process with
    // an ERR_STREAM_DESTROYED carrying no userland frames at all.
    await pipeline(async function* () {
      for await (const chunk of reader.chunks(size)) {
        hash?.update(chunk)
        yield chunk
      }
    }, createWriteStream(into))
  }

  if (hash && hash.digest('hex') !== sha256) {
    throw corrupt(`blob ${sha256!.slice(0, 12)} doesn’t match its own hash`)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

// --- commands ---------------------------------------------------------------

type Spec = {boolean?: readonly string[]; single?: readonly string[]; repeatable?: readonly string[]}
type Flags = {positional: string[]; values: Map<string, string[]>; bools: Set<string>}

/** `--json` is the caller's business, but it lands in every command's tail. */
const ALWAYS_BOOLEAN = ['json']

function parseFlags(args: string[], spec: Spec): Flags {
  const booleans = new Set([...ALWAYS_BOOLEAN, ...(spec.boolean ?? [])])
  const single = new Set(spec.single ?? [])
  const repeatable = new Set(spec.repeatable ?? [])
  const flags: Flags = {positional: [], values: new Map(), bools: new Set()}

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') {
      flags.positional.push(...args.slice(index + 1))
      break
    }
    if (!arg.startsWith('--')) {
      flags.positional.push(arg)
      continue
    }

    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    const inline = equals === -1 ? undefined : arg.slice(equals + 1)

    if (booleans.has(name)) {
      if (inline !== undefined) throw new CommandError('usage', `--${name} takes no value`)
      flags.bools.add(name)
      continue
    }
    if (!single.has(name) && !repeatable.has(name)) throw new CommandError('usage', `unknown flag “--${name}”`)

    const value = inline ?? args[++index]
    if (value === undefined) throw new CommandError('usage', `--${name} needs a value`)

    const held = flags.values.get(name)
    if (!held) flags.values.set(name, [value])
    else if (single.has(name)) throw new CommandError('usage', `--${name} can only be given once`)
    else held.push(value)
  }

  return flags
}

const listOf = (flags: Flags, name: string): string[] => flags.values.get(name) ?? []
const oneOf = (flags: Flags, name: string): string | undefined => flags.values.get(name)?.[0]

function isoDate(flags: Flags, name: string): string | undefined {
  const raw = oneOf(flags, name)
  if (raw === undefined) return undefined
  if (Number.isNaN(Date.parse(raw))) {
    throw new CommandError('usage', `--${name} needs an ISO date like 2026-01-31, not “${raw}”`)
  }
  return raw
}

async function guard<T>(run: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return ok(await run())
  } catch (error) {
    return envelopeFor(error)
  }
}

/**
 * Without `--out` the bundle goes to stdout, so `pluck export --board x >
 * x.pluck` works. The envelope this returns is then the caller's problem: it
 * must not print it to the same stream the bytes just went down.
 */
export async function cmdExport(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {single: ['board', 'since', 'until', 'out'], repeatable: ['tag']})
    if (flags.positional.length) {
      throw new CommandError('usage', 'export takes no arguments — narrow it with --board, --tag, --since or --until')
    }

    const board = oneOf(flags, 'board')
    if (board !== undefined && !boardKey(board)) {
      throw new CommandError('usage', `“${board}” has no letters or numbers to make a board out of`)
    }
    const tags = listOf(flags, 'tag')
      .map(tag => tag.trim())
      .filter(Boolean)

    const opts = {
      board,
      tags: tags.length ? tags : undefined,
      since: isoDate(flags, 'since'),
      until: isoDate(flags, 'until'),
    }

    const file = oneOf(flags, 'out')
    if (!file) return {...(await exportBundle(opts, process.stdout)), out: null}

    const sink = createWriteStream(file)
    try {
      const manifest = await exportBundle(opts, sink)
      sink.end()
      await once(sink, 'close')
      return {...manifest, out: path.resolve(file)}
    } catch (error) {
      // half a bundle on disk is worse than none — it looks importable
      sink.destroy()
      await fs.rm(file, {force: true})
      throw error
    }
  })
}

export async function cmdImport(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {boolean: ['dry-run']})
    const [file, ...extra] = flags.positional
    if (!file) throw new CommandError('usage', 'pluck import <bundle.pluck> — a bundle is required')
    if (extra.length) throw new CommandError('usage', 'import takes a single bundle')

    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      throw new CommandError('not_found', `Nothing to import at ${file} — that file is gone.`)
    }
    if (!stat.isFile()) throw new CommandError('usage', `${file} is not a file, so there is nothing to import.`)

    const dryRun = flags.bools.has('dry-run')
    const result = await importBundle(createReadStream(file), {dryRun})
    return {file: path.resolve(file), dryRun, ...result}
  })
}
