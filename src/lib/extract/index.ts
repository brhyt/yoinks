/**
 * Fan-out probing.
 *
 * One paste runs every extractor whose `matches` says yes, concurrently, and
 * merges their candidates into a single ordered list. Results stream: the
 * caller gets an updated list every time anything arrives, so a fast extractor
 * never waits behind a slow one.
 *
 * Extractors that can decide from the url alone (`urgent`) start before
 * classification returns — the shipped youtube path must not grow a HEAD and a
 * full html GET it never reads.
 *
 * See docs/architecture.md.
 */

import {classify} from './classify.js'
import {directExtractor} from './direct.js'
import {pageExtractor} from './page.js'
import {ytdlpExtractor} from './ytdlp.js'
import {compareCandidates, type Candidate, type Classification, type Extractor, type ExtractorKey} from './types.js'

export const EXTRACTORS: readonly Extractor[] = [directExtractor, pageExtractor, ytdlpExtractor]

export type ProbeEvent =
  | {type: 'classified'; classification: Classification}
  | {type: 'status'; message: string}
  /** the full merged list, re-sorted — not a delta */
  | {type: 'candidates'; candidates: Candidate[]}
  | {type: 'extractor-failed'; extractor: ExtractorKey; message: string}
  | {type: 'done'; candidates: Candidate[]}

export type ProbeOptions = {
  signal?: AbortSignal
  /** injectable for tests — defaults to the real registry */
  extractors?: readonly Extractor[]
  /** injectable for tests — defaults to the real classifier */
  classifyImpl?: typeof classify
}

/** What a producer emits before probeUrl turns it into a ProbeEvent. */
type Raw =
  | {kind: 'candidate'; candidate: Candidate}
  | {kind: 'classified'; classification: Classification}
  | {kind: 'status'; message: string}

type SourceKey = ExtractorKey | 'classify'
type Source = {key: SourceKey; stream: AsyncIterable<Raw>}
type Failure = {extractor: SourceKey; message: string}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const safely = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * Merge several async iterables, yielding values as they arrive.
 *
 * A source that throws is reported and dropped; it never takes the others down
 * with it. One dead extractor must not cost you the candidates the rest found.
 */
async function* mergeStreams(sources: Source[], onError: (key: SourceKey, error: unknown) => void): AsyncGenerator<Raw> {
  type Step = {index: number; ok: true; result: IteratorResult<Raw>} | {index: number; ok: false; error: unknown}

  const iterators = sources.map(source => source.stream[Symbol.asyncIterator]())
  const pending = new Map<number, Promise<Step>>()

  const advance = (index: number) => {
    const step: Promise<Step> = iterators[index]!
      .next()
      .then(result => ({index, ok: true as const, result}))
      .catch(error => ({index, ok: false as const, error}))
    pending.set(index, step)
  }

  iterators.forEach((_, index) => advance(index))

  while (pending.size > 0) {
    const step = await Promise.race(pending.values())
    pending.delete(step.index)
    if (!step.ok) {
      onError(sources[step.index]!.key, step.error)
      continue
    }
    if (step.result.done) continue
    yield step.result.value
    advance(step.index)
  }
}

/**
 * Dedupe across extractors on the resolved media url.
 *
 * The page extractor's og:image and its largest srcset entry are routinely the
 * same file, and a direct hit can restate what the page already offered. The
 * higher score wins, since that's the extractor that understood it better.
 */
function absorb(candidates: Map<string, Candidate>, candidate: Candidate): void {
  const identity = candidate.hint?.url ?? candidate.key
  const existing = candidates.get(identity)
  if (existing && (existing.score ?? 0) >= (candidate.score ?? 0)) return
  candidates.set(identity, candidate)
}

/** An extractor's candidates, with its status chatter interleaved in order. */
function extractorSource(
  extractor: Extractor,
  ctx: {url: string; classification: Classification},
  signal?: AbortSignal,
): Source {
  // A queue rather than draining around each candidate: yt-dlp reports
  // "fetching video info…" seconds before it can name a single format, and
  // buffering that until the first candidate leaves the probing screen stale.
  const queue: Raw[] = []
  let wake: (() => void) | undefined
  const push = (item: Raw) => {
    queue.push(item)
    wake?.()
    wake = undefined
  }

  async function* stream(): AsyncGenerator<Raw> {
    let finished = false
    const running = (async () => {
      const probeCtx = {...ctx, onStatus: (message: string) => push({kind: 'status', message})}
      for await (const candidate of extractor.probe(probeCtx, signal)) {
        push({kind: 'candidate', candidate})
      }
    })().finally(() => {
      finished = true
      wake?.()
      wake = undefined
    })

    for (;;) {
      while (queue.length > 0) yield queue.shift()!
      if (finished) break
      await new Promise<void>(resolve => (wake = resolve))
    }
    await running // a rejection here is the extractor's failure, and must surface
  }

  return {key: extractor.key, stream: stream()}
}

export async function* probeUrl(url: string, opts: ProbeOptions = {}): AsyncGenerator<ProbeEvent> {
  const {signal, extractors = EXTRACTORS, classifyImpl = classify} = opts

  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error('That doesn’t look like a link — paste a full url, like https://example.com/cat.jpg')
  }

  const failures: Failure[] = []
  const record = (extractor: SourceKey, error: unknown) => failures.push({extractor, message: message(error)})

  const urgent = extractors.filter(extractor => safely(() => extractor.urgent?.(parsed) ?? false, false))
  const rest = extractors.filter(extractor => !urgent.includes(extractor))

  const sources: Source[] = []

  // Anything decidable from the url alone starts now, against a provisional
  // classification. Nothing here may read `html` — it isn't fetched yet.
  const provisional: Classification = {url, isHtml: false}
  for (const extractor of urgent) {
    sources.push(extractorSource(extractor, {url, classification: provisional}, signal))
  }

  // Classification, and everything that depends on it, as one producer.
  sources.push({
    key: 'classify',
    stream: (async function* (): AsyncGenerator<Raw> {
      yield {kind: 'status', message: 'looking at that link…'}
      const classification = await classifyImpl(url, {signal})
      if (signal?.aborted) return
      yield {kind: 'classified', classification}

      // A dead link still serves a perfectly valid html error page. Mining it
      // would fill the picker with the site's 404 artwork.
      if (classification.status !== undefined && classification.status >= 400) {
        throw new Error(`That link is dead (${classification.status}).`)
      }

      const base = safely(() => new URL(classification.url), parsed)
      const matched = rest.filter(extractor => safely(() => extractor.matches(base, classification), false))
      if (matched.length === 0) return

      const ctx = {url: classification.url, classification}
      yield* mergeStreams(
        matched.map(extractor => extractorSource(extractor, ctx, signal)),
        record,
      )
    })(),
  })

  const merged = new Map<string, Candidate>()
  let produced = false

  const flushFailures = function* (): Generator<ProbeEvent> {
    while (failures.length > 0) {
      const failure = failures.shift()!
      // 'classify' isn't an extractor; surfacing it as one would be a lie
      if (failure.extractor === 'classify') continue
      yield {type: 'extractor-failed', extractor: failure.extractor, message: failure.message}
    }
  }

  let classifyError: string | undefined
  const stream = mergeStreams(sources, (key, error) => {
    if (key === 'classify') classifyError = message(error)
    record(key, error)
  })

  for await (const raw of stream) {
    if (signal?.aborted) return
    yield* flushFailures()

    if (raw.kind === 'status') {
      yield {type: 'status', message: raw.message}
    } else if (raw.kind === 'classified') {
      yield {type: 'classified', classification: raw.classification}
    } else {
      absorb(merged, raw.candidate)
      produced = true
      yield {type: 'candidates', candidates: [...merged.values()].sort(compareCandidates)}
    }
  }

  yield* flushFailures()

  // A link we couldn't even look at is a real error. A link we looked at and
  // found nothing on is an empty picker, which is a different message.
  if (classifyError && !produced) throw new Error(classifyError)

  yield {type: 'done', candidates: [...merged.values()].sort(compareCandidates)}
}
