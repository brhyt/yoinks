import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {ffmpegRaw, resolveFfmpeg} from '../ffmpeg.js'
import {blobMetaPath, findOriginal} from './paths.js'
import {DERIVER_VERSION, isoNow} from './types.js'
import type {BlobMeta, Kind, PaletteEntry} from './types.js'

/**
 * Derived blob facts — dimensions, duration, palette.
 *
 * Everything here is recomputable from the bytes, and that shapes the two rules
 * this file lives by. Nothing throws: derivation runs after a capture has
 * already succeeded, so a failure costs a plainer library, never the save. And
 * nothing is random: the same blob must produce the same `meta.json` on every
 * machine, or derived data stops being reproducible and a future sync gains a
 * conflict nobody can resolve.
 *
 * See docs/rendering.md#palette-extraction.
 */

/** 64×64 — 4096 pixels, enough for a palette and cheap enough to be free. */
const SAMPLE = 64

/** Kinds with no pixels to look at. */
const NON_VISUAL: ReadonlySet<Kind> = new Set<Kind>(['font', 'page', 'snippet'])

/** Only video gets the seek, and a path is all a decode is handed to decide with. */
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.ogv',
])

/**
 * How to make the source fit exactly w×h.
 *
 * `pad` preserves the aspect ratio and letterboxes on black — what a thumbnail
 * wants, because a squashed preview is unrecognisable.
 *
 * `stretch` squashes instead, inventing no pixels — what a palette wants. The
 * letterbox bars are real black pixels as far as the sampler is concerned, so
 * padding a 16:9 screenshot into a 64×64 sample hands back ~44% pure black
 * that exists nowhere in the picture. `brief` sums palettes across a board, so
 * that black would swamp every reference a person ever saved. Colour
 * statistics don't care about aspect ratio; a thumbnail does.
 */
export type Fit = 'pad' | 'stretch'

/**
 * Decode any image or video frame to raw rgb24 at exactly w×h. Undefined when
 * ffmpeg is missing or the file isn't decodable — the caller draws a
 * placeholder and moves on.
 */
export async function decodeRgb(
  file: string,
  w: number,
  h: number,
  signal?: AbortSignal,
  fit: Fit = 'pad',
): Promise<Buffer | undefined> {
  if (w <= 0 || h <= 0) return undefined
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return undefined

  const isVideo = VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())
  // videos skip a second in to miss black opening frames, but a clip shorter
  // than that seek decodes to nothing, so the unseeked run is the fallback
  for (const seek of isVideo ? ['00:00:01', undefined] : [undefined]) {
    const frame = await decodeOnce(ffmpeg, file, w, h, seek, signal, fit)
    if (frame) return frame
  }
  return undefined
}

async function decodeOnce(
  ffmpeg: string,
  file: string,
  w: number,
  h: number,
  seek: string | undefined,
  signal?: AbortSignal,
  fit: Fit = 'pad',
): Promise<Buffer | undefined> {
  const fitted = `scale=${w}:${h}:force_original_aspect_ratio=decrease`
  const bars = `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x000000`
  const filter = fit === 'stretch' ? `scale=${w}:${h}` : `${fitted},${bars}`
  const args = ['-v', 'error']
  if (seek) args.push('-ss', seek)
  args.push('-i', file, '-vf', filter, '-frames:v', '1')
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-')

  try {
    const frame = await ffmpegRaw(ffmpeg, args, signal)
    // a short read is a truncated frame, and reading it as pixels would produce
    // a palette for an image nobody has — better to have no palette at all
    return frame.length === w * h * 3 ? frame : undefined
  } catch {
    return undefined
  }
}

type Cluster = {r: number; g: number; b: number; count: number}

/** Buckets below this share of the sample are noise — unless they're the accent. */
const MIN_WEIGHT = 0.01

/**
 * Two averages closer than this are the same color.
 *
 * Measured on `distance()` below, which runs 0 for identical to 765 for black
 * against white — *not* on CIE Lab's 0..100, which is where the "ΔE < 5" in
 * docs/rendering.md comes from. Five on this scale is one level per channel
 * (already 3), so it would merge only bit-for-bit near-duplicates and leave the
 * merge step doing nothing. 25 is about the same share of the range the doc
 * meant. Don't put it back to 5 without also changing the metric.
 */
const MERGE_DISTANCE = 25

/**
 * Cut between two distinct values on the split channel, not at the median index.
 *
 * Cutting mid-run leaves two different colours in one bucket, and averaging
 * that bucket invents a colour that appears nowhere in the image — flat-colour
 * art (logos, ui screenshots, vector work) reliably produced a muddy blend
 * between two of its actual colours. A palette entry the reference does not
 * contain is worse than a missing one, because `pluck brief` hands these
 * hexes to an agent as the reference's own colours.
 *
 * Walks outward from the median and takes the first real boundary, lower side
 * first, so the result stays deterministic. The search range is 1..length-1, so
 * neither partition can come back empty; the median return is unreachable belt
 * and braces, since `widest()` only offers a bucket that spans two values on
 * this channel. Gradients are untouched — when every neighbour already differs,
 * the median is itself a boundary, so the case plain median cut is good at
 * behaves exactly as before.
 */
function boundaryNear(pixels: number[], rgb: Buffer, channel: number): number {
  const valueAt = (at: number) => rgb[pixels[at]! * 3 + channel]!
  const mid = pixels.length >> 1
  for (let offset = 0; offset <= pixels.length; offset++) {
    for (const at of [mid - offset, mid + offset]) {
      if (at <= 0 || at >= pixels.length) continue
      if (valueAt(at - 1) !== valueAt(at)) return at
    }
  }
  return mid
}

/**
 * Median-cut palette from a raw rgb24 buffer.
 *
 * Pure and deterministic by construction: every choice — which bucket splits,
 * on which channel, where — is decided by the bytes, with ties broken by pixel
 * order. That is the whole reason this isn't k-means, whose random init would
 * hand two machines two different palettes for one blob.
 */
export function paletteFromRgb(rgb: Buffer, maxColors = 8): PaletteEntry[] {
  const total = Math.floor(rgb.length / 3)
  if (total === 0 || maxColors < 1) return []

  const buckets: number[][] = [Array.from({length: total}, (_, i) => i)]
  while (buckets.length < maxColors) {
    const split = widest(buckets, rgb)
    if (!split) break // every bucket is one flat color, so there is nothing left to cut
    const pixels = buckets[split.index]!
    pixels.sort((a, b) => rgb[a * 3 + split.channel]! - rgb[b * 3 + split.channel]! || a - b)
    const mid = boundaryNear(pixels, rgb, split.channel)
    buckets.splice(split.index, 1, pixels.slice(0, mid), pixels.slice(mid))
  }

  const averaged = buckets.filter(pixels => pixels.length > 0).map(pixels => average(pixels, rgb))
  averaged.sort((a, b) => b.count - a.count || a.r - b.r || a.g - b.g || a.b - b.b)

  const merged: Cluster[] = []
  for (const bucket of averaged) {
    const near = merged.find(cluster => distance(cluster, bucket) < MERGE_DISTANCE)
    if (!near) {
      merged.push({...bucket})
      continue
    }
    const count = near.count + bucket.count
    near.r = (near.r * near.count + bucket.r * bucket.count) / count
    near.g = (near.g * near.count + bucket.g * bucket.count) / count
    near.b = (near.b * near.count + bucket.b * bucket.count) / count
    near.count = count
  }

  // the exemption that makes this useful: a 2% accent is usually the point of a
  // design reference, and it is exactly what a frequency cull throws away first
  const accent = mostChromatic(merged)
  const sampled = merged.reduce((sum, cluster) => sum + cluster.count, 0)
  const kept = merged.filter(cluster => cluster === accent || cluster.count / sampled >= MIN_WEIGHT)

  const keptTotal = kept.reduce((sum, cluster) => sum + cluster.count, 0)
  return kept
    .map(cluster => ({hex: hex(cluster), weight: cluster.count / keptTotal}))
    .sort((a, b) => b.weight - a.weight || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0))
}

/** The bucket with the widest single-channel spread, and the channel to cut on. */
function widest(buckets: number[][], rgb: Buffer): {index: number; channel: number} | undefined {
  let best: {index: number; channel: number; range: number} | undefined

  for (const [index, pixels] of buckets.entries()) {
    if (pixels.length < 2) continue
    const min = [255, 255, 255]
    const max = [0, 0, 0]
    for (const pixel of pixels) {
      for (let c = 0; c < 3; c++) {
        const value = rgb[pixel * 3 + c]!
        if (value < min[c]!) min[c] = value
        if (value > max[c]!) max[c] = value
      }
    }
    let channel = 0
    for (let c = 1; c < 3; c++) if (max[c]! - min[c]! > max[channel]! - min[channel]!) channel = c
    const range = max[channel]! - min[channel]!
    if (range > 0 && (!best || range > best.range)) best = {index, channel, range}
  }
  return best
}

function average(pixels: number[], rgb: Buffer): Cluster {
  let r = 0
  let g = 0
  let b = 0
  for (const pixel of pixels) {
    r += rgb[pixel * 3]!
    g += rgb[pixel * 3 + 1]!
    b += rgb[pixel * 3 + 2]!
  }
  return {r: r / pixels.length, g: g / pixels.length, b: b / pixels.length, count: pixels.length}
}

/**
 * Weighted rgb distance, `sqrt(2dr² + 4dg² + 3db²)` — the cheap stand-in for a
 * real CIE ΔE, biased toward green the way the eye is. Good enough to decide
 * "same color" and it costs no color-space conversion.
 */
function distance(a: Cluster, b: Cluster): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db)
}

/** Chroma as plain rgb spread. Ties go to the heavier cluster, then to color order. */
function mostChromatic(clusters: Cluster[]): Cluster | undefined {
  let best: Cluster | undefined
  let bestChroma = -1
  for (const cluster of clusters) {
    const chroma = Math.max(cluster.r, cluster.g, cluster.b) - Math.min(cluster.r, cluster.g, cluster.b)
    if (chroma > bestChroma || (chroma === bestChroma && best && cluster.count > best.count)) {
      best = cluster
      bestChroma = chroma
    }
  }
  return best
}

function hex(cluster: Cluster): string {
  const channel = (value: number) =>
    Math.min(255, Math.max(0, Math.round(value)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(cluster.r)}${channel(cluster.g)}${channel(cluster.b)}`
}

// ffmpeg's own stream report, which it writes to stderr even when it refuses to
// run for want of an output file
const STREAM_SIZE = /Stream #\d+:\d+.*: Video:.*?[ ,](\d{1,5})x(\d{1,5})(?![\dx])/
const DURATION = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/

/** Intrinsic dimensions, and duration when the file has one. `{}` when unknowable. */
export async function probeDimensions(
  file: string,
  signal?: AbortSignal,
): Promise<{width?: number; height?: number; duration?: number}> {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return {}

  // no output file: ffmpeg prints the full input analysis, then exits 1 without
  // decoding a single frame. `-f null -` would give the same numbers after
  // transcoding the entire video, which for an hour of footage is not a probe.
  const report = await ffmpegStderr(ffmpeg, ['-hide_banner', '-i', file], signal)

  const probed: {width?: number; height?: number; duration?: number} = {}

  const size = STREAM_SIZE.exec(report)
  if (size) {
    probed.width = Number(size[1])
    probed.height = Number(size[2])
  }

  const duration = DURATION.exec(report)
  const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN
  if (Number.isFinite(seconds)) probed.duration = seconds

  return probed
}

/** ffmpegRaw collects stdout; the stream report lives on stderr, so this is its twin. */
function ffmpegStderr(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(ffmpeg, args, {stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: 20_000})
    } catch {
      resolve('')
      return
    }
    let stderr = ''
    child.stderr?.on('data', chunk => (stderr += chunk))
    child.on('error', () => resolve(''))
    // the probe run exits non-zero by design, so the report is all that matters
    child.on('close', () => resolve(stderr))
  })
}

/**
 * Fill in a blob's derived metadata and rewrite its `meta.json`.
 *
 * Undefined when there is no blob or no meta to enrich. Never throws: this is
 * the last step of a capture that has already worked.
 */
export async function deriveBlob(sha256: string, signal?: AbortSignal): Promise<BlobMeta | undefined> {
  try {
    const target = blobMetaPath(sha256)
    const meta = JSON.parse(await fs.readFile(target, 'utf8')) as BlobMeta
    if (!meta || typeof meta !== 'object') return undefined

    const original = await findOriginal(sha256)
    if (!original) return undefined

    const {width, height, duration} = await probeDimensions(original, signal)
    if (width) meta.width = width
    if (height) meta.height = height
    // a still decodes as a one-frame "duration" on some demuxers, which is noise
    if (duration && (meta.kind === 'video' || meta.kind === 'audio')) meta.duration = duration

    if (!NON_VISUAL.has(meta.kind)) {
      // stretch, never pad — letterbox bars would enter the palette as real black
      const frame = await decodeRgb(original, SAMPLE, SAMPLE, signal, 'stretch')
      const palette = frame && paletteFromRgb(frame)
      if (palette?.length) meta.palette = palette
    }

    meta.derived_at = isoNow()
    meta.deriver_version = DERIVER_VERSION

    const tmp = `${target}.deriving`
    await fs.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`)
    await fs.rename(tmp, target)
    return meta
  } catch {
    return undefined
  }
}
