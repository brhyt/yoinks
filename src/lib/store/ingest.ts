import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {putItem} from './log.js'
import {blobDir, blobMetaPath, boardsPath, ensureLibrary, findOriginal} from './paths.js'
import {isoNow, ulid} from './types.js'
import type {BlobMeta, Board, Item, Kind} from './types.js'

/**
 * Capture — bytes already on disk become a blob and an item.
 *
 * Hash first, copy second. The hash is the identity, so the second capture of
 * the same bytes writes an item and nothing else. That's the whole payoff of
 * the blob/item split: dedupe costs one read, and derivation runs once per
 * blob rather than once per save.
 *
 * See docs/asset-model.md#two-kinds-of-identity.
 */

export type IngestInput = {
  /** file already on disk, from a Candidate's fetch() */
  path: string
  kind: Kind
  mime?: string
  source: {url: string; site?: string; title?: string; author?: string; extractor?: string}
  /** board names as typed — stored on the item slugified, see boardKey */
  boards?: string[]
  tags?: string[]
  note?: string
}

export type IngestResult = {item: Item; sha256: string; blobPath: string; deduped: boolean}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const bytes = await sizeOfFile(input.path)
  const sha256 = await hashFile(input.path)

  await ensureLibrary()

  const stored = await findOriginal(sha256)
  const deduped = stored !== undefined
  const blobPath = stored ?? (await writeBlob(input.path, sha256, extensionFor(input.path, input.mime)))

  // Write meta whenever it's missing, not just for a new blob. `kind` and
  // `mime` come from the extractor and are NOT recoverable from the bytes, so
  // a lost meta.json would otherwise be permanent — a dedupe hit is the only
  // chance to heal one. Never overwrite an existing meta: it may already carry
  // derive.ts's palette and dimensions.
  if (!(await exists(blobMetaPath(sha256)))) {
    // width/height/palette/fonts and the derived_at pair belong to derive.ts —
    // their absence is exactly what marks this blob as not yet derived
    const meta: BlobMeta = {sha256, kind: input.kind, ...(input.mime ? {mime: input.mime} : {}), bytes}
    await writeJson(blobMetaPath(sha256), meta)
  }

  const boards = await ensureBoards(input.boards)
  const now = isoNow()
  const item: Item = {
    id: ulid(),
    ts: now,
    sha256,
    source: {...input.source, captured_at: now},
    boards,
    tags: input.tags ?? [],
    ...(input.note ? {note: input.note} : {}),
  }

  await putItem(item)
  return {item, sha256, blobPath, deduped}
}

export async function loadBoards(): Promise<Record<string, Board>> {
  let raw: string
  try {
    raw = await fs.readFile(boardsPath(), 'utf8')
  } catch {
    return {} // no boards yet is not an error
  }
  if (!raw.trim()) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  // refusing beats returning {} here: every write rewrites the whole file, so
  // shrugging at an unreadable one would delete every board in it
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${boardsPath()} is not a readable board list. Move it aside to start over.`)
  }
  return parsed as Record<string, Board>
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** Idempotent: an existing board is returned untouched, note and cover intact. */
export async function ensureBoard(name: string, note?: string): Promise<Board> {
  const key = boardKey(name)
  if (!key) throw new Error(`"${name}" has no letters or numbers to make a board out of.`)

  const boards = await loadBoards()
  const existing = boards[key]
  if (existing) return existing

  const board: Board = {name: name.trim(), created_at: isoNow(), ...(note ? {note} : {})}
  boards[key] = board
  await ensureLibrary()
  await writeJson(boardsPath(), boards)
  return board
}

/** The key a board is filed under. `Board.name` keeps whatever was typed. */
export function boardKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'text/html': '.html',
  'text/css': '.css',
  'text/plain': '.txt',
  'application/json': '.json',
}

const PLAIN_EXTENSION = /^\.[a-z0-9]{1,8}$/

function extensionFor(file: string, mime?: string): string {
  const fromPath = path.extname(file).toLowerCase()
  if (PLAIN_EXTENSION.test(fromPath)) return fromPath
  return EXT_FOR_MIME[(mime ?? '').split(';')[0]!.trim().toLowerCase()] ?? ''
}

async function sizeOfFile(file: string): Promise<number> {
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    throw new Error(`Nothing to yoink at ${file} — that file is gone.`)
  }
  if (!stat.isFile()) throw new Error(`${file} is not a file, so there is nothing to yoink.`)
  return stat.size
}

/** Streamed, because a 4 GB video must never become a 4 GB buffer. */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function writeBlob(from: string, sha256: string, ext: string): Promise<string> {
  const dir = blobDir(sha256)
  await fs.mkdir(dir, {recursive: true})

  const target = path.join(dir, `original${ext}`)
  const tmp = tempSibling(target)
  try {
    // copy to a name findOriginal cannot match, then rename — an ingest killed
    // mid-copy leaves a stray temp file, never a truncated `original.*` that
    // every later run would hand out as the complete blob
    await fs.copyFile(from, tmp)
    await fs.rename(tmp, target)
  } catch (error) {
    await fs.rm(tmp, {force: true})
    throw error
  }
  return target
}

async function writeJson(target: string, value: unknown): Promise<void> {
  const tmp = tempSibling(target)
  await fs.mkdir(path.dirname(target), {recursive: true})
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
    await fs.rename(tmp, target)
  } catch (error) {
    await fs.rm(tmp, {force: true})
    throw error
  }
}

let tempSeq = 0

/** Same directory as the target, so the rename is atomic and never cross-device. */
function tempSibling(target: string): string {
  const unique = `${process.pid}-${Date.now()}-${tempSeq++}`
  return path.join(path.dirname(target), `.tmp-${unique}-${path.basename(target)}`)
}

/** One at a time: boards.json is read-modify-written, so these cannot overlap. */
async function ensureBoards(names: string[] | undefined): Promise<string[]> {
  const keys: string[] = []
  for (const name of names ?? []) {
    if (!name.trim()) continue
    await ensureBoard(name)
    const key = boardKey(name)
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}
