/**
 * Extractor contracts.
 *
 * One paste fans out across every extractor that matches the url, and their
 * candidates merge into a single picker. Extractors never talk to each other
 * and never touch the store — they turn a url into things you could yoink,
 * and nothing else.
 *
 * See docs/architecture.md for the pipeline this sits in.
 */

export type Kind = 'image' | 'video' | 'audio' | 'font' | 'page' | 'palette' | 'snippet'

export type ExtractorKey = 'direct' | 'page' | 'ytdlp' | 'shot'

/**
 * Picker grouping order. Fixed, so rows never reshuffle as late candidates
 * stream in — a moving cursor under someone's finger is worse than a slow one.
 */
export const KIND_ORDER: readonly Kind[] = [
  'image',
  'video',
  'audio',
  'font',
  'palette',
  'page',
  'snippet',
] as const

/**
 * Cost tier, not capability. Decides *when* an extractor runs.
 * - `always`  every paste, sub-second budget
 * - `signal`  only when the url or the page body suggests it will find something
 * - `demand`  contributes a picker row, does the work only if that row is chosen
 */
export type Tier = 'always' | 'signal' | 'demand'

/** What one HEAD (plus one GET for html) established about a url. */
export type Classification = {
  /** final url after redirects — extractors should use this, not the input */
  url: string
  mime?: string
  bytes?: number
  /** inferred from mime; undefined when the server was unhelpful */
  kind?: Kind
  isHtml: boolean
  /**
   * Response status. A 404 error page is still `text/html`, so without this the
   * page extractor would happily mine a dead link's error page for og:image.
   */
  status?: number
  /**
   * Body, populated only for html. Fetched once here and shared, so the page
   * extractor and the og:video signal check don't each pay for a GET.
   */
  html?: string
}

export type ProbeContext = {
  /** convenience — same as classification.url */
  url: string
  classification: Classification
  /**
   * Progress chatter during probing, for extractors that do slow work before
   * they can name a candidate (yt-dlp bootstrapping its binary, say).
   */
  onStatus?: (message: string) => void
}

export type FetchProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  /** which file of a multi-file fetch (a video+audio merge is 2) */
  part: number
  totalParts: number
}

export type FetchContext = {
  /** where to write. The caller owns cleanup, including on cancel. */
  outDir: string
  onProgress?: (progress: FetchProgress) => void
  onStatus?: (message: string) => void
}

export type Fetched = {
  /** absolute path to the file on disk */
  path: string
  mime?: string
  /** preferred filename, if the extractor knows better than the path does */
  filename?: string
}

export type Candidate = {
  /**
   * Stable within one probe. The picker tracks the cursor by key rather than
   * by index, so a slow extractor's late arrival can't move the selection.
   */
  key: string
  kind: Kind
  /** the picker row text */
  label: string
  extractor: ExtractorKey
  /**
   * Get the bytes. A closure rather than a url because `demand`-tier
   * candidates (a screenshot) have nothing to point at until they're chosen.
   */
  fetch: (ctx: FetchContext, signal?: AbortSignal) => Promise<Fetched>
  /** best-effort, for the label and for metadata before the bytes land */
  hint?: {
    bytes?: number
    width?: number
    height?: number
    duration?: number
    mime?: string
    /** resolved media url, when there is one — used to dedupe across extractors */
    url?: string
    title?: string
  }
  /** ordering within a kind, higher first */
  score?: number
}

export type Extractor = {
  key: ExtractorKey
  tier: Tier
  /** cheap and synchronous — no i/o here, the fan-out calls it for every url */
  matches: (url: URL, classification: Classification) => boolean
  /**
   * Decidable from the url alone. An extractor that says yes here starts
   * *before* classification finishes.
   *
   * This exists to protect the shipped path: pasting a youtube link used to go
   * straight to yt-dlp, and it must not start paying for a HEAD plus a full
   * html GET it will never read.
   */
  urgent?: (url: URL) => boolean
  probe: (ctx: ProbeContext, signal?: AbortSignal) => AsyncIterable<Candidate>
}

/** Sort key for the merged picker: kind group first, then score, then key. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const kindDelta = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  if (kindDelta !== 0) return kindDelta
  const scoreDelta = (b.score ?? 0) - (a.score ?? 0)
  if (scoreDelta !== 0) return scoreDelta
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** Kind implied by a content-type. Undefined when it tells us nothing useful. */
export function kindForMime(mime: string | undefined): Kind | undefined {
  if (!mime) return undefined
  const type = mime.split(';')[0]!.trim().toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('font/') || FONT_MIMES.has(type)) return 'font'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'page'
  return undefined
}

const FONT_MIMES = new Set([
  'application/font-woff',
  'application/font-woff2',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/vnd.ms-fontobject',
])
