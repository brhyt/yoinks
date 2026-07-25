/**
 * What a url is, before anything downloads it.
 *
 * One HEAD decides the shape of the fan-out, and html pays for a single GET
 * whose body every extractor then shares. Sniffing the file extension instead
 * is a trap: image CDNs happily serve a png from a `.php` url, and plenty of
 * `.jpg` urls are html landing pages.
 *
 * A rejected request is only fatal when we have no headers at all. A server
 * that refuses HEAD, names no content-type, or won't hand over the body still
 * classifies as far as it let us get — an error screen is for a link we can't
 * use and a host we can't reach, nothing else.
 *
 * See docs/architecture.md for the pipeline this sits in.
 */

import {kindForMime, type Classification} from './types.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

/** 405 and 501 are honest about disliking HEAD; 403 is how most CDNs say it. */
const RETRY_WITH_GET = new Set([403, 405, 501])

/**
 * The html body is held in memory and passed to every extractor, so it needs a
 * ceiling. Real markup lands far under this; anything past it is a stream that
 * called itself a page.
 */
const MAX_HTML_BYTES = 2 * 1024 * 1024

export type ClassifyOptions = {
  signal?: AbortSignal
  /** injectable so tests never touch the network */
  fetchImpl?: typeof fetch
}

export async function classify(url: string, opts: ClassifyOptions = {}): Promise<Classification> {
  const {signal, fetchImpl = fetch} = opts
  const target = requireHttpUrl(url)

  const head = await attempt(fetchImpl, target, 'HEAD', signal)
  if (head) discardBody(head) // a few servers answer HEAD with a body anyway

  const get = head && !refusedHead(head) ? undefined : await attempt(fetchImpl, target, 'GET', signal)
  const source = get ?? head
  if (!source) throw unreachable(target)

  const mime = source.headers.get('content-type') ?? undefined
  const declared = Number(source.headers.get('content-length'))
  const kind = kindForMime(mime)
  // types.ts owns the mime table, and `page` is the kind html and only html maps to
  const isHtml = kind === 'page'

  const classification: Classification = {
    url: source.url || target.href,
    mime,
    bytes: Number.isFinite(declared) && declared > 0 ? declared : undefined,
    kind,
    isHtml,
    status: source.status,
  }

  if (!isHtml) {
    if (get) discardBody(get)
    return classification
  }

  const body = get ?? (await attempt(fetchImpl, target, 'GET', signal))
  if (!body) return classification
  return {...classification, html: await readCapped(body).catch(() => undefined)}
}

function requireHttpUrl(input: string): URL {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    throw new Error('That doesn’t look like a link — paste a full url, like https://example.com/cat.jpg')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const scheme = parsed.protocol.replace(':', '')
    throw new Error(`That doesn’t look like a link — yoinks opens http and https urls, not ${scheme}.`)
  }
  return parsed
}

function unreachable(target: URL): Error {
  return new Error(`Could not reach ${target.hostname}. Check your connection and try again.`)
}

function refusedHead(response: Response): boolean {
  return RETRY_WITH_GET.has(response.status) || !response.headers.get('content-type')
}

async function attempt(
  fetchImpl: typeof fetch,
  target: URL,
  method: 'HEAD' | 'GET',
  signal?: AbortSignal,
): Promise<Response | undefined> {
  try {
    return await fetchImpl(target.href, {
      method,
      signal,
      redirect: 'follow',
      headers: {'user-agent': UA, accept: '*/*'},
    })
  } catch (error) {
    // a cancelled probe is not a server that dislikes HEAD — never retry it
    if (signal?.aborted) throw error
    return undefined
  }
}

/** The headers were the whole point — drop the connection rather than read a file we don't want. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

/** Read up to the cap, then stop pulling. Never buffer a body of unknown size. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return await response.text()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let read = 0
  let html = ''

  while (read < MAX_HTML_BYTES) {
    const {done, value} = await reader.read()
    if (done) break
    if (!value) continue
    const room = MAX_HTML_BYTES - read
    const slice = value.length > room ? value.subarray(0, room) : value
    read += slice.length
    html += decoder.decode(slice, {stream: true})
  }

  await reader.cancel().catch(() => {})
  return html + decoder.decode()
}
