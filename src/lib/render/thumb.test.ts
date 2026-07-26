import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {TestContext} from 'node:test'
import {ffmpegRaw, resolveFfmpeg} from '../ffmpeg.js'
import {blobDir, thumbsDir} from '../store/paths.js'
import {clearThumbs, evictThumb, thumbRgb} from './thumb.js'
import {cellHeightFor} from './types.js'

/**
 * Every test runs in its own PLUCK_HOME, because these functions delete cache
 * trees and a test that reached the real `~/.pluck` would be deleting somebody's
 * library. Anything needing ffmpeg skips, so a machine without it still passes —
 * the same rule the thumbnailer itself lives by.
 */

const SHA = 'a1'.repeat(32)
const OTHER = 'b2'.repeat(32)

async function freshHome(t: TestContext): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-thumb-'))
  const previous = process.env.PLUCK_HOME
  process.env.PLUCK_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.PLUCK_HOME
    else process.env.PLUCK_HOME = previous
    await fs.rm(home, {recursive: true, force: true})
  })
  return home
}

/** An original beside a blob, painted by ffmpeg so there is no binary fixture to commit. */
async function plantImage(ffmpeg: string, sha256: string, source = 'color=c=red:s=64x64'): Promise<string> {
  await fs.mkdir(blobDir(sha256), {recursive: true})
  const original = path.join(blobDir(sha256), 'original.png')
  await ffmpegRaw(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-frames:v', '1', original])
  return original
}

/** Spelled out rather than imported, so a change to the key format fails a test. */
const cacheFile = (sha256: string, cols: number, rows: number) =>
  path.join(thumbsDir(), `${sha256}-${cols}x${rows}.rgb`)

function blackPixels(rgb: Buffer): number {
  let count = 0
  for (let at = 0; at < rgb.length; at += 3) if (!rgb[at] && !rgb[at + 1] && !rgb[at + 2]) count++
  return count
}

test('a miss decodes and leaves a file of exactly one thumbnail', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  await freshHome(t)
  await plantImage(ffmpeg, SHA)

  const thumb = await thumbRgb(SHA, {cols: 8, rows: 4})
  assert.equal(thumb?.length, 8 * 8 * 3) // 4 rows of cells is 8 pixel rows
  assert.equal((await fs.stat(cacheFile(SHA, 8, 4))).size, 8 * 8 * 3)
  assert.ok(thumb![0]! > 200 && thumb![1]! < 50 && thumb![2]! < 50, 'red went in, red came out')
})

test('a second call is served from the cache, not from the blob', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  await freshHome(t)
  const original = await plantImage(ffmpeg, SHA)
  const first = await thumbRgb(SHA, {cols: 8, rows: 4})

  // with the original gone there is nothing left to decode, so anything that
  // comes back can only have come off disk
  await fs.rm(original)
  assert.deepEqual(await thumbRgb(SHA, {cols: 8, rows: 4}), first)
})

test('a truncated cache file is re-derived instead of handed back as pixels', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  await freshHome(t)
  await plantImage(ffmpeg, SHA)
  await fs.mkdir(thumbsDir(), {recursive: true})
  await fs.writeFile(cacheFile(SHA, 8, 4), Buffer.alloc(8 * 8 * 3 - 3))

  const thumb = await thumbRgb(SHA, {cols: 8, rows: 4})
  assert.equal(thumb?.length, 8 * 8 * 3)
  assert.equal((await fs.stat(cacheFile(SHA, 8, 4))).size, 8 * 8 * 3)
})

test('a short cache file is refused even when nothing can replace it', async t => {
  await freshHome(t)
  await fs.mkdir(thumbsDir(), {recursive: true})
  await fs.writeFile(cacheFile(SHA, 8, 4), Buffer.alloc(12))

  assert.equal(await thumbRgb(SHA, {cols: 8, rows: 4}), undefined)
})

test('a blob that is not there is undefined, not a throw', async t => {
  await freshHome(t)

  assert.equal(await thumbRgb(SHA, {cols: 8, rows: 4}), undefined)
  assert.equal(await thumbRgb(SHA, {cols: 0, rows: 0}), undefined)
})

test('eviction takes every size of one blob and nothing of its neighbour', async t => {
  await freshHome(t)
  await evictThumb(SHA) // no cache directory yet

  await fs.mkdir(thumbsDir(), {recursive: true})
  for (const file of [cacheFile(SHA, 8, 4), cacheFile(SHA, 44, 22), cacheFile(OTHER, 8, 4)]) {
    await fs.writeFile(file, Buffer.alloc(3))
  }

  await evictThumb(SHA)
  assert.deepEqual(await fs.readdir(thumbsDir()), [`${OTHER}-8x4.rgb`])
})

test('clearing the cache is safe with or without a cache to clear', async t => {
  await freshHome(t)
  await clearThumbs()

  await fs.mkdir(thumbsDir(), {recursive: true})
  await fs.writeFile(cacheFile(SHA, 8, 4), Buffer.alloc(3))
  await clearThumbs()
  await assert.rejects(fs.stat(thumbsDir()))
})

test('a 2:1 image at 40 cols is 10 rows of cells, and fills them edge to edge', async t => {
  assert.equal(cellHeightFor(40, 128, 64), 10)

  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  await freshHome(t)
  await plantImage(ffmpeg, SHA, 'color=c=green:s=128x64')

  const rows = cellHeightFor(40, 128, 64)
  const thumb = await thumbRgb(SHA, {cols: 40, rows})
  assert.equal(thumb?.length, 40 * rows * 2 * 3)
  // 40×20 pixels is the source's own 2:1, so the aspect-preserving pad has no
  // bars to draw — which is the whole point of halving the height for cells
  assert.equal(blackPixels(thumb!), 0)
})
