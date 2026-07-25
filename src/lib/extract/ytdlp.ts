import {detectPlatform} from '../platforms.js'
import {buildChoices, download, ensureYtDlp, findFfmpeg, probe as probeYtDlp} from '../ytdlp.js'
import type {Candidate, Extractor, ProbeContext} from './types.js'

const VIDEO_HOSTS = new Set(['youtube', 'x', 'instagram', 'threads', 'tiktok', 'vimeo', 'twitch', 'reddit', 'facebook'])

// yt-dlp resolution is slow and the answer never changes within a run
let cachedBinary = ''

/** A page that advertises a player is worth asking yt-dlp about, whatever its host. */
function advertisesVideo(html: string | undefined): boolean {
  if (!html) return false
  return /property=["']og:video|name=["']twitter:player|<video[\s>]/i.test(html)
}

export const ytdlpExtractor: Extractor = {
  key: 'ytdlp',
  tier: 'signal',

  // a known video host needs no classification to be worth asking yt-dlp about,
  // and waiting for one would add a HEAD plus a full html GET to the path 0.3.1
  // answered immediately
  urgent(url) {
    return VIDEO_HOSTS.has(detectPlatform(url.href).key)
  },

  matches(url, classification) {
    if (VIDEO_HOSTS.has(detectPlatform(url.href).key)) return true
    if (classification.kind === 'video') return true
    return classification.isHtml && advertisesVideo(classification.html)
  },

  async *probe(ctx: ProbeContext, signal?: AbortSignal): AsyncGenerator<Candidate> {
    const binary = cachedBinary || (await ensureYtDlp(message => ctx.onStatus?.(message), signal))
    cachedBinary = binary
    if (signal?.aborted) return

    ctx.onStatus?.('fetching video info…')
    const {info, infoJsonPath} = await probeYtDlp(binary, ctx.url, signal)
    if (signal?.aborted) return

    for (const [index, choice] of buildChoices(info).entries()) {
      yield {
        // the format spec is what actually distinguishes two rows; the index
        // keeps the key unique if yt-dlp ever hands back a duplicate
        key: `ytdlp:${index}:${choice.args.join(' ')}`,
        kind: choice.kind === 'audio' ? 'audio' : 'video',
        label: choice.label,
        extractor: 'ytdlp',
        score: 800 - index,
        // deliberately no hint.url: that field is the *media* url and is what
        // cross-extractor dedupe keys on. Every format row shares one webpage
        // url, so setting it here collapsed the whole picker into one row.
        hint: {
          title: info.title,
          duration: info.duration,
        },
        fetch: async (fetchCtx, fetchSignal) => {
          const ffmpegLocation = await findFfmpeg()
          const base = {
            ytdlp: binary,
            ffmpegLocation,
            url: ctx.url,
            choice,
            outDir: fetchCtx.outDir,
          }
          const handlers = {
            onProgress: fetchCtx.onProgress ?? (() => {}),
            onProcessing: () => fetchCtx.onStatus?.('processing…'),
          }
          let path: string
          try {
            // reuse the probe's metadata — starts immediately instead of re-extracting
            path = await download({...base, infoJsonPath}, handlers, fetchSignal)
          } catch (error) {
            if (fetchSignal?.aborted) throw error
            // media urls in the cached info can expire — retry with a fresh extraction
            fetchCtx.onStatus?.('link expired — grabbing a fresh one…')
            path = await download(base, handlers, fetchSignal)
          }
          return {path}
        },
      }
    }
  },
}
