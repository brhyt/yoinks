import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {TestContext} from 'node:test'
import {ffmpegRaw, resolveFfmpeg} from '../ffmpeg.js'
import {decodeRgb, deriveBlob, paletteFromRgb, probeDimensions} from './derive.js'
import {blobDir, blobMetaPath} from './paths.js'
import {DERIVER_VERSION} from './types.js'
import type {BlobMeta} from './types.js'

/**
 * The palette tests are the load-bearing ones and they touch no binary: a
 * palette that shifts between runs makes meta.json non-reproducible, which is
 * the one thing derivation is not allowed to be. Everything that needs ffmpeg
 * skips instead of failing, because a machine without it must still pass.
 */

/** Mirrors the cull threshold in derive.ts. */
const MIN_WEIGHT = 0.01

/** A raw rgb24 buffer built from runs of `[r, g, b, count]`. */
function rgbBuffer(runs: Array<[number, number, number, number]>): Buffer {
  const buffer = Buffer.alloc(runs.reduce((total, run) => total + run[3], 0) * 3)
  let at = 0
  for (const [r, g, b, count] of runs) {
    for (let i = 0; i < count; i++) {
      buffer[at++] = r
      buffer[at++] = g
      buffer[at++] = b
    }
  }
  return buffer
}

const chroma = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16))
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!)
}

test('a single color is the whole palette', () => {
  assert.deepEqual(paletteFromRgb(rgbBuffer([[255, 0, 0, 100]])), [{hex: '#ff0000', weight: 1}])
})

test('two colors in equal measure split the weight evenly', () => {
  const palette = paletteFromRgb(rgbBuffer([[255, 0, 0, 50], [0, 0, 255, 50]]))
  assert.deepEqual(palette, [
    {hex: '#0000ff', weight: 0.5},
    {hex: '#ff0000', weight: 0.5},
  ])
})

test('shades nobody could tell apart collapse into one entry', () => {
  // one level apart on every channel is ΔE 3 under the weighted rgb metric
  const palette = paletteFromRgb(rgbBuffer([[100, 100, 100, 500], [101, 101, 101, 500]]))
  assert.deepEqual(palette, [{hex: '#656565', weight: 1}])
})

test('a tiny accent survives the cull that drops an equally tiny grey', () => {
  // 0.6% magenta and 0.4% grey against a white field — a frequency sort keeps
  // neither, and the accent is the one color the reference is actually about
  const palette = paletteFromRgb(rgbBuffer([[255, 255, 255, 1980], [255, 0, 255, 12], [128, 128, 128, 8]]))

  assert.equal(palette.length, 2)
  assert.equal(palette[0]!.hex, '#ffffff')
  assert.equal(palette[1]!.hex, '#ff00ff') // the accent's own colour, not a blend of it
  assert.ok(palette[1]!.weight < MIN_WEIGHT, `accent kept its small weight, got ${palette[1]!.weight}`)
  assert.ok(chroma(palette[1]!.hex) > 150, `accent stayed chromatic, got ${palette[1]!.hex}`)
  assert.equal(palette.some(entry => chroma(entry.hex) === 0 && entry.weight < MIN_WEIGHT), false)
})

test('flat-colour art yields only colours that are actually in it', () => {
  // logos, ui screenshots and vector work are mostly flat colour, and cutting at
  // the median index used to average across a boundary and invent a blend — this
  // buffer reported a #cc0033 that is in none of its pixels. `yoinks brief`
  // hands these hexes to an agent as the reference's own colours, so an invented
  // one is worse than a missing one.
  const palette = paletteFromRgb(rgbBuffer([[255, 0, 0, 600], [0, 255, 0, 300], [0, 0, 255, 100]]))
  const present = new Set(['#ff0000', '#00ff00', '#0000ff'])

  for (const entry of palette) {
    assert.ok(present.has(entry.hex), `invented ${entry.hex}, which is in no pixel of the source`)
  }
  assert.deepEqual(
    palette.map(entry => [entry.hex, Number(entry.weight.toFixed(3))]),
    [['#ff0000', 0.6], ['#00ff00', 0.3], ['#0000ff', 0.1]],
  )
})

test('a hard boundary between two tones yields those two tones and nothing between', () => {
  // 700/300 rather than an even split, whose median lands on the boundary
  // anyway. Both budgets matter: with eight buckets to spend, even an unsnapped
  // cut eventually isolates two colours and the merge step tidies up after it.
  // Narrow the budget and there is nowhere to recover — this is the shape that
  // actually separates a boundary cut from a median one.
  const twoTone = rgbBuffer([[10, 20, 30, 700], [200, 190, 180, 300]])
  const tones = [
    {hex: '#0a141e', weight: 0.7},
    {hex: '#c8beb4', weight: 0.3},
  ]

  assert.deepEqual(paletteFromRgb(twoTone), tones)
  assert.deepEqual(paletteFromRgb(twoTone, 3), tones)
  assert.deepEqual(paletteFromRgb(twoTone, 2), tones)
})

test('a gradient still averages into sensible buckets', () => {
  // snapping must not break what plain median cut is good at: here every
  // neighbouring pixel differs, so the median is already a boundary
  const ramp: Array<[number, number, number, number]> = []
  for (let value = 0; value < 256; value++) ramp.push([value, value, value, 16])
  const palette = paletteFromRgb(rgbBuffer(ramp))

  assert.ok(palette.length >= 4 && palette.length <= 8, `got ${palette.length} buckets`)
  assert.ok(Math.abs(palette.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 1e-9)
  // averaging a grey ramp must not invent a hue, and the palette should still
  // reach both ends of it rather than collapsing to the middle
  for (const entry of palette) assert.equal(chroma(entry.hex), 0, entry.hex)
  const luminance = palette.map(entry => Number.parseInt(entry.hex.slice(1, 3), 16))
  assert.ok(Math.min(...luminance) < 60 && Math.max(...luminance) > 195, JSON.stringify(palette))
})

test('entries come back heaviest first and sum to one', () => {
  const palette = paletteFromRgb(rgbBuffer([[255, 0, 0, 600], [0, 255, 0, 300], [0, 0, 255, 100]]))

  assert.ok(palette.length >= 3)
  assert.equal(palette[0]!.hex, '#ff0000')
  for (let i = 1; i < palette.length; i++) assert.ok(palette[i - 1]!.weight >= palette[i]!.weight)
  assert.ok(Math.abs(palette.reduce((sum, entry) => sum + entry.weight, 0) - 1) < 1e-9)
})

test('the same bytes always produce the same palette', () => {
  const runs: Array<[number, number, number, number]> = [
    [17, 32, 91, 300],
    [240, 12, 60, 120],
    [201, 199, 188, 900],
    [17, 33, 92, 44],
    [8, 8, 9, 7],
  ]
  const first = paletteFromRgb(rgbBuffer(runs))
  const second = paletteFromRgb(rgbBuffer(runs))

  assert.equal(JSON.stringify(first), JSON.stringify(second))

  const capped = [paletteFromRgb(rgbBuffer(runs), 4), paletteFromRgb(rgbBuffer(runs), 4)]
  assert.equal(JSON.stringify(capped[0]), JSON.stringify(capped[1]))
})

test('an empty buffer has no palette', () => {
  assert.deepEqual(paletteFromRgb(Buffer.alloc(0)), [])
  assert.deepEqual(paletteFromRgb(Buffer.from([255, 0])), []) // not even one whole pixel
})

test('a decode that never happened is undefined, not a throw', async () => {
  assert.equal(await decodeRgb(path.join(os.tmpdir(), 'yoinks-nothing-here.png'), 8, 8), undefined)
  assert.equal(await decodeRgb(path.join(os.tmpdir(), 'yoinks-nothing-here.png'), 0, 0), undefined)
  assert.deepEqual(await probeDimensions(path.join(os.tmpdir(), 'yoinks-nothing-here.png')), {})
})

/** A library home for one test, restored afterwards. */
async function freshHome(t: TestContext): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-derive-'))
  const previous = process.env.YOINKS_HOME
  process.env.YOINKS_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.YOINKS_HOME
    else process.env.YOINKS_HOME = previous
    await fs.rm(home, {recursive: true, force: true})
  })
  return home
}

async function plantBlob(sha256: string, meta: BlobMeta): Promise<string> {
  await fs.mkdir(blobDir(sha256), {recursive: true})
  await fs.writeFile(blobMetaPath(sha256), `${JSON.stringify(meta, null, 2)}\n`)
  return blobDir(sha256)
}

const SHA = '9f'.repeat(32)

test('a blob with no meta and a meta with no blob both derive to nothing', async t => {
  await freshHome(t)

  assert.equal(await deriveBlob(SHA), undefined)
  await plantBlob(SHA, {sha256: SHA, kind: 'image', bytes: 0})
  assert.equal(await deriveBlob(SHA), undefined) // meta.json, but no original beside it
})

test('kinds with no pixels get a stamp and no palette', async t => {
  await freshHome(t)
  const dir = await plantBlob(SHA, {sha256: SHA, kind: 'font', bytes: 12})
  await fs.writeFile(path.join(dir, 'original.woff2'), 'not really a font')

  const meta = await deriveBlob(SHA)
  assert.equal(meta?.palette, undefined)
  assert.equal(meta?.deriver_version, DERIVER_VERSION)
  assert.ok(!Number.isNaN(Date.parse(meta?.derived_at ?? '')))
})

test('an image blob picks up its dimensions and its palette', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  await freshHome(t)
  const dir = await plantBlob(SHA, {sha256: SHA, kind: 'image', bytes: 0})
  const original = path.join(dir, 'original.png')
  // deliberately NON-square: sampling a wide image into a square buffer used to
  // letterbox it, and the black bars became a real palette entry
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=96x32', '-frames:v', '1', original]
  await ffmpegRaw(ffmpeg, args)

  const meta = await deriveBlob(SHA)
  assert.equal(meta?.width, 96)
  assert.equal(meta?.height, 32)
  assert.equal(meta?.duration, undefined) // a still has no duration, whatever the demuxer says
  assert.equal(meta?.palette?.length, 1)
  const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(meta!.palette![0]!.hex.slice(at, at + 2), 16))
  assert.ok(b! > 200 && r! < 40 && g! < 40, `expected a blue palette, got ${meta?.palette?.[0]?.hex}`)

  // and it is on disk, not just in the return value
  assert.deepEqual(JSON.parse(await fs.readFile(blobMetaPath(SHA), 'utf8')), meta)
})

test('decoding pads to exactly the requested pixel count', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-decode-'))
  t.after(() => fs.rm(dir, {recursive: true, force: true}))
  const image = path.join(dir, 'wide.png')
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=120x20', '-frames:v', '1', image]
  await ffmpegRaw(ffmpeg, args)

  const frame = await decodeRgb(image, 16, 16)
  assert.equal(frame?.length, 16 * 16 * 3)
  // a 6:1 image in a square frame is letterboxed, so the pad color is in there
  const palette = paletteFromRgb(frame!)
  assert.ok(palette.some(entry => entry.hex === '#000000'), JSON.stringify(palette))

  assert.deepEqual(await probeDimensions(image), {width: 120, height: 20})
})

test('a video is probed for its duration and sampled past the first frame', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  await freshHome(t)
  const dir = await plantBlob(SHA, {sha256: SHA, kind: 'video', bytes: 0})
  const original = path.join(dir, 'original.mp4')
  await ffmpegRaw(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
    '-t', '3', '-pix_fmt', 'yuv420p', original,
  ])

  assert.deepEqual(await probeDimensions(original), {width: 320, height: 240, duration: 3})

  const meta = await deriveBlob(SHA)
  assert.equal(meta?.width, 320)
  assert.equal(meta?.height, 240)
  assert.equal(meta?.duration, 3)
  assert.ok((meta?.palette?.length ?? 0) > 1)
})

test('a clip shorter than the one-second seek still yields a frame', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-decode-'))
  t.after(() => fs.rm(dir, {recursive: true, force: true}))
  const clip = path.join(dir, 'blink.mp4')
  await ffmpegRaw(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:rate=10',
    '-t', '0.4', '-pix_fmt', 'yuv420p', clip,
  ])

  assert.equal((await decodeRgb(clip, 8, 8))?.length, 8 * 8 * 3)
})

test('a wide image gets no black from letterboxing', async t => {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return t.skip('no ffmpeg on this machine')

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-fit-'))
  try {
    const wide = path.join(dir, 'wide.png')
    // 6:1, the shape a banner or a hero screenshot actually is
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=192x32', '-frames:v', '1', wide]
    await ffmpegRaw(ffmpeg, args)

    const padded = await decodeRgb(wide, 64, 64, undefined, 'pad')
    const stretched = await decodeRgb(wide, 64, 64, undefined, 'stretch')
    const blackPixels = (buf: Buffer) => {
      let n = 0
      for (let i = 0; i < buf.length; i += 3) if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0) n++
      return n
    }

    assert.ok(blackPixels(padded!) > 0, 'pad is supposed to letterbox — that is what thumbnails want')
    assert.equal(blackPixels(stretched!), 0, 'stretch must invent no pixels')
    assert.deepEqual(
      paletteFromRgb(stretched!).map(entry => entry.hex),
      ['#0000ff'],
      'a solid blue banner is one colour, not blue plus the bars we drew',
    )
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

