import {formatBytes} from '../format.js'
import {fetchToFile} from './fetch-file.js'
import type {Candidate, Classification, Extractor, ProbeContext} from './types.js'

/**
 * Mimes whose subtype isn't the extension anyone expects to read. Everything
 * else falls through to the subtype itself, which is already right for the
 * long tail — `image/png`, `video/mp4`, `font/woff2`.
 */
const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'audio/mpeg': 'mp3',
  'application/font-woff': 'woff',
  'application/font-woff2': 'woff2',
  'application/x-font-ttf': 'ttf',
  'application/x-font-otf': 'otf',
  'application/vnd.ms-fontobject': 'eot',
}

/** A subtype only doubles as an extension when it's short and alphanumeric. */
const PLAIN_SUBTYPE = /^[a-z0-9]{2,5}$/

const PATH_EXTENSION = /\.([a-z0-9]{1,8})$/i

function extFromMime(mime: string | undefined): string {
  const type = (mime ?? '').split(';')[0]!.trim().toLowerCase()
  const known = EXT_FOR_MIME[type]
  if (known) return known
  const subtype = type.split('/')[1] ?? ''
  return PLAIN_SUBTYPE.test(subtype) ? subtype : ''
}

function extFromUrl(url: string): string {
  try {
    return PATH_EXTENSION.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

/**
 * The mime wins over the path: image CDNs happily serve a png from a `.php`
 * url, and a generic `application/octet-stream` yields nothing to win with.
 */
function labelFor(classification: Classification): string {
  const ext = extFromMime(classification.mime) || extFromUrl(classification.url)
  const size = classification.bytes ? formatBytes(classification.bytes) : ''
  return ['original', ext, size && `~${size}`].filter(Boolean).join(' · ')
}

export const directExtractor: Extractor = {
  key: 'direct',
  tier: 'always',

  matches(_url, classification) {
    return !classification.isHtml && classification.kind !== undefined
  },

  async *probe(ctx: ProbeContext): AsyncGenerator<Candidate> {
    const {classification} = ctx
    const {kind} = classification
    // only reachable when something probed without matching first
    if (!kind) return

    yield {
      key: `direct:${classification.url}`,
      kind,
      label: labelFor(classification),
      extractor: 'direct',
      fetch: (fetchCtx, signal) => fetchToFile(classification.url, fetchCtx, signal),
      hint: {bytes: classification.bytes, mime: classification.mime, url: classification.url},
      // the url *is* the asset — nothing another extractor finds beats it
      score: 1000,
    }
  },
}
