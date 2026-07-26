import {spawn} from 'node:child_process'

/**
 * A *runnable* ffmpeg command.
 *
 * `findFfmpeg()` in ytdlp.ts deliberately returns undefined when ffmpeg is on
 * PATH — it's telling yt-dlp to resolve its own. The thumbnailer and the
 * palette pass need something they can actually spawn, so this is its sibling.
 *
 * ffmpeg is the whole image toolchain here: it decodes png/jpeg/webp/gif/avif,
 * resizes, and grabs video frames, which is why pluck has no native image
 * dependency. When it's missing, callers degrade to a placeholder rather than
 * failing — browsing your own library must never hard-depend on a media
 * toolchain.
 */

let cached: string | null | undefined

function works(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, ['-version'], {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

export async function resolveFfmpeg(): Promise<string | undefined> {
  if (cached !== undefined) return cached ?? undefined

  if (await works('ffmpeg')) {
    cached = 'ffmpeg'
    return cached
  }
  try {
    const mod = await import('ffmpeg-static')
    const bundled = (mod.default ?? mod) as unknown as string | null
    if (bundled && (await works(bundled))) {
      cached = bundled
      return cached
    }
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }

  cached = null
  return undefined
}

/** Run ffmpeg and collect stdout as raw bytes. Rejects with ffmpeg's own message. */
export function ffmpegRaw(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, {signal})
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(stderr.trim().split('\n').at(-1) ?? `ffmpeg exited with ${code}`))
    })
  })
}
