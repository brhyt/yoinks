import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import type {FetchContext, Fetched} from './types.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

/** Refuse anything larger than this — a mistyped url shouldn't fill the disk. */
const MAX_BYTES = 512 * 1024 * 1024

const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
}

// control characters plus the set windows and macos reject in filenames
const UNSAFE_IN_FILENAME = new RegExp('[\\u0000-\\u001f\\u007f<>:"|?*]', 'g')

/** Strip anything that would be awkward or unsafe as a path segment. */
export function safeFilename(name: string, fallback = 'asset'): string {
  const cleaned = name
    .replace(/[/\\]/g, '-')
    .replace(UNSAFE_IN_FILENAME, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return cleaned || fallback
}

/** Best-effort filename for a url + response, always with an extension. */
export function filenameFor(url: string, mime?: string, disposition?: string): string {
  const fromDisposition = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition ?? '')?.[1]
  let base = ''

  if (fromDisposition) {
    try {
      base = decodeURIComponent(fromDisposition)
    } catch {
      base = fromDisposition // malformed percent-encoding — take it literally
    }
  }

  if (!base) {
    try {
      base = decodeURIComponent(path.basename(new URL(url).pathname))
    } catch {
      base = ''
    }
  }
  base = safeFilename(base)

  if (!path.extname(base)) {
    const ext = EXT_FOR_MIME[(mime ?? '').split(';')[0]!.trim().toLowerCase()]
    if (ext) base += ext
  }
  return base
}

/**
 * Stream a url to a file in `ctx.outDir`, reporting progress.
 *
 * Shared by every extractor that has a plain url to fetch, so progress
 * reporting and filename handling stay identical no matter which one produced
 * the candidate.
 */
export async function fetchToFile(url: string, ctx: FetchContext, signal?: AbortSignal): Promise<Fetched> {
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: {'user-agent': UA, accept: '*/*'},
  })

  if (!response.ok || !response.body) {
    throw new Error(`Could not fetch that file (${response.status}).`)
  }

  const mime = response.headers.get('content-type') ?? undefined
  const declared = Number(response.headers.get('content-length'))
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : undefined

  if (totalBytes && totalBytes > MAX_BYTES) {
    throw new Error(`That file is ${Math.round(totalBytes / 1024 / 1024)} MB — too large to yoink.`)
  }

  const filename = filenameFor(response.url || url, mime, response.headers.get('content-disposition') ?? undefined)
  await fs.mkdir(ctx.outDir, {recursive: true})
  const target = path.join(ctx.outDir, filename)

  let downloadedBytes = 0
  const counted = Readable.fromWeb(response.body as never).map((chunk: Buffer) => {
    downloadedBytes += chunk.length
    if (downloadedBytes > MAX_BYTES) throw new Error('That file is too large to yoink.')
    ctx.onProgress?.({downloadedBytes, totalBytes, part: 0, totalParts: 1})
    return chunk
  })

  await pipeline(counted, createWriteStream(target), {signal})
  return {path: target, mime, filename}
}
