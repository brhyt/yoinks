import fs from 'node:fs/promises'
import path from 'node:path'
import {decodeRgb} from '../store/derive.js'
import {findOriginal, thumbsDir} from '../store/paths.js'
import type {CellSize} from './types.js'

/**
 * Thumbnails, cached as raw pixels.
 *
 * Raw rgb24 rather than PNG because a read has to be nearly free — a scroll
 * frame composes a whole grid of these against a 16ms budget, and a decode per
 * thumbnail would eat it — while the file stays tiny anyway: a 44×22 thumbnail
 * is 5.8 KB. The cell size lives in the filename, so a terminal resize asks a
 * different question rather than invalidating the answer to the old one.
 *
 * Nothing here throws. A missing blob, a missing ffmpeg or an undecodable file
 * all come back undefined and the caller draws a placeholder, because browsing
 * your own library must never hard-depend on a media toolchain.
 *
 * See docs/rendering.md#caching.
 */

const cachePath = (sha256: string, size: CellSize) =>
  path.join(thumbsDir(), `${sha256}-${size.cols}x${size.rows}.rgb`)

/** Distinct temp names, so two warms of the same key can't inherit each other's partial file. */
let writes = 0

/** Raw rgb24 for a thumbnail at cols×rows cells, cached on disk. */
export async function thumbRgb(sha256: string, size: CellSize, signal?: AbortSignal): Promise<Buffer | undefined> {
  const {cols, rows} = size
  if (cols <= 0 || rows <= 0) return undefined

  // half-blocks stack two pixels per cell, so the image is twice as tall in
  // pixels as the thumbnail is in rows
  const pixelHeight = rows * 2
  const expected = cols * pixelHeight * 3
  const target = cachePath(sha256, size)

  try {
    const cached = await fs.readFile(target)
    // the file has no header, so its length is the only integrity check there
    // is — and a short one is an interrupted write, not a smaller thumbnail
    if (cached.length === expected) return cached
  } catch {
    // no cache entry yet, which is the common path on first sight of a blob
  }

  const original = await findOriginal(sha256)
  if (!original) return undefined

  const frame = await decodeRgb(original, cols, pixelHeight, signal)
  if (!frame || frame.length !== expected) return undefined

  await store(target, frame)
  return frame
}

async function store(target: string, frame: Buffer): Promise<void> {
  const tmp = `${target}.${process.pid}-${writes++}.writing`
  try {
    await fs.mkdir(thumbsDir(), {recursive: true})
    await fs.writeFile(tmp, frame)
    await fs.rename(tmp, target)
  } catch {
    // an unwritable cache costs a re-decode next time, never the thumbnail
    await fs.rm(tmp, {force: true}).catch(() => {})
  }
}

/** Drop every cached thumbnail for one blob (e.g. after a re-derive). */
export async function evictThumb(sha256: string): Promise<void> {
  const dir = thumbsDir()
  try {
    const entries = await fs.readdir(dir)
    // the prefix also catches any abandoned `.writing` temp for this blob
    const stale = entries.filter(entry => entry.startsWith(`${sha256}-`))
    await Promise.all(stale.map(entry => fs.rm(path.join(dir, entry), {force: true})))
  } catch {
    // no cache directory means nothing to evict
  }
}

/** Wipe the whole thumbnail cache. */
export async function clearThumbs(): Promise<void> {
  await fs.rm(thumbsDir(), {recursive: true, force: true})
}
