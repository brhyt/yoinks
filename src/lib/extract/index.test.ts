import assert from 'node:assert/strict'
import test from 'node:test'
import {probeUrl, type ProbeEvent} from './index.js'
import type {Candidate, Classification, Extractor, ExtractorKey, Kind} from './types.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const htmlClassification: Classification = {
  url: 'https://example.com/shot',
  mime: 'text/html',
  kind: 'page',
  isHtml: true,
  html: '<html></html>',
}

const fakeClassify = (classification = htmlClassification) => async () => classification

function candidate(key: string, kind: Kind, extra: Partial<Candidate> = {}): Candidate {
  return {
    key,
    kind,
    label: key,
    extractor: 'page',
    fetch: async () => ({path: `/tmp/${key}`}),
    ...extra,
  }
}

/** An extractor that yields the given candidates, optionally slowly or fatally. */
function fake(
  key: ExtractorKey,
  candidates: Candidate[],
  opts: {delayMs?: number; throwsAfter?: number; matches?: boolean; matchThrows?: boolean} = {},
): Extractor {
  return {
    key,
    tier: 'always',
    matches: () => {
      if (opts.matchThrows) throw new Error('bad matcher')
      return opts.matches ?? true
    },
    async *probe() {
      for (const [index, item] of candidates.entries()) {
        if (opts.delayMs) await sleep(opts.delayMs)
        if (opts.throwsAfter !== undefined && index === opts.throwsAfter) throw new Error(`${key} exploded`)
        yield item
      }
    },
  }
}

async function collect(url: string, extractors: Extractor[], classification?: Classification): Promise<ProbeEvent[]> {
  const events: ProbeEvent[] = []
  for await (const event of probeUrl(url, {extractors, classifyImpl: fakeClassify(classification) as never})) {
    events.push(event)
  }
  return events
}

const finalCandidates = (events: ProbeEvent[]): Candidate[] => {
  const done = events.find(e => e.type === 'done')
  return done && done.type === 'done' ? done.candidates : []
}

test('merges candidates from every matching extractor', async () => {
  const events = await collect('https://example.com/shot', [
    fake('page', [candidate('a', 'image')]),
    fake('ytdlp', [candidate('b', 'video')]),
  ])
  assert.deepEqual(
    finalCandidates(events).map(c => c.key),
    ['a', 'b'],
  )
})

test('one extractor throwing does not lose the others', async () => {
  const events = await collect('https://example.com/shot', [
    fake('page', [candidate('a', 'image'), candidate('b', 'image')], {throwsAfter: 1}),
    fake('ytdlp', [candidate('c', 'video')]),
  ])

  const failed = events.filter(e => e.type === 'extractor-failed')
  assert.equal(failed.length, 1)
  assert.match((failed[0] as {message: string}).message, /page exploded/)

  // 'a' arrived before the throw, and the healthy extractor is untouched
  assert.deepEqual(
    finalCandidates(events).map(c => c.key),
    ['a', 'c'],
  )
})

test('a throwing matcher just means that extractor sits out', async () => {
  const events = await collect('https://example.com/shot', [
    fake('page', [candidate('a', 'image')], {matchThrows: true}),
    fake('ytdlp', [candidate('b', 'video')]),
  ])
  assert.deepEqual(
    finalCandidates(events).map(c => c.key),
    ['b'],
  )
})

test('dedupes on resolved url, keeping the higher score', async () => {
  const shared = 'https://cdn.example.com/hero.png'
  const events = await collect('https://example.com/shot', [
    fake('page', [candidate('og', 'image', {score: 900, hint: {url: shared}})]),
    fake('direct', [candidate('img', 'image', {score: 500, hint: {url: shared}})]),
  ])

  const final = finalCandidates(events)
  assert.equal(final.length, 1)
  assert.equal(final[0]!.key, 'og')
})

test('dedupe is order-independent — the low score arriving first still loses', async () => {
  const shared = 'https://cdn.example.com/hero.png'
  const events = await collect('https://example.com/shot', [
    fake('direct', [candidate('img', 'image', {score: 500, hint: {url: shared}})]),
    fake('page', [candidate('og', 'image', {score: 900, hint: {url: shared}})], {delayMs: 5}),
  ])

  const final = finalCandidates(events)
  assert.equal(final.length, 1)
  assert.equal(final[0]!.key, 'og')
})

test('orders by kind group, then score, then key', async () => {
  const events = await collect('https://example.com/shot', [
    fake('page', [
      candidate('z-font', 'font', {score: 10}),
      candidate('low-image', 'image', {score: 1}),
      candidate('high-image', 'image', {score: 99}),
      candidate('a-video', 'video', {score: 50}),
    ]),
  ])

  assert.deepEqual(
    finalCandidates(events).map(c => c.key),
    ['high-image', 'low-image', 'a-video', 'z-font'],
  )
})

test('candidates stream — each arrival re-emits the full list', async () => {
  const events = await collect('https://example.com/shot', [
    fake('page', [candidate('a', 'image'), candidate('b', 'image'), candidate('c', 'image')]),
  ])

  const snapshots = events.filter(e => e.type === 'candidates').map(e => (e as {candidates: Candidate[]}).candidates.length)
  assert.deepEqual(snapshots, [1, 2, 3])
})

test('a fast extractor is not blocked behind a slow one', async () => {
  const events = await collect('https://example.com/shot', [
    fake('ytdlp', [candidate('slow', 'video')], {delayMs: 40}),
    fake('page', [candidate('fast', 'image')], {delayMs: 1}),
  ])

  const firstSnapshot = events.find(e => e.type === 'candidates') as {candidates: Candidate[]}
  assert.deepEqual(
    firstSnapshot.candidates.map(c => c.key),
    ['fast'],
  )
})

test('nothing matching is a real outcome, not an error', async () => {
  const events = await collect('https://example.com/shot', [fake('page', [candidate('a', 'image')], {matches: false})])
  assert.deepEqual(finalCandidates(events), [])
  assert.ok(!events.some(e => e.type === 'extractor-failed'))
})

test('many rows from one extractor all survive the merge', async () => {
  // the shipped format picker: 1080p/720p/480p/360p/audio all describe the same
  // page, and a shared dedupe identity once collapsed them into a single row
  const rows = [
    candidate('1080p', 'video', {score: 800, hint: {title: 'clip'}}),
    candidate('720p', 'video', {score: 799, hint: {title: 'clip'}}),
    candidate('480p', 'video', {score: 798, hint: {title: 'clip'}}),
    candidate('audio', 'audio', {score: 797, hint: {title: 'clip'}}),
  ]
  const events = await collect('https://youtu.be/abc', [fake('ytdlp', rows)])
  assert.deepEqual(
    finalCandidates(events).map(c => c.key),
    ['1080p', '720p', '480p', 'audio'],
  )
})

test('an urgent extractor starts without waiting for classification', async () => {
  // the shipped youtube path: yt-dlp must not sit behind a HEAD it never reads
  let classifyResolved = false
  let sawCandidateBeforeClassify = false

  const slowClassify = (async () => {
    await sleep(50)
    classifyResolved = true
    return htmlClassification
  }) as never

  const urgentExtractor: Extractor = {
    ...fake('ytdlp', [candidate('video', 'video')]),
    urgent: () => true,
  }

  const events: ProbeEvent[] = []
  for await (const event of probeUrl('https://youtu.be/abc', {
    extractors: [urgentExtractor],
    classifyImpl: slowClassify,
  })) {
    if (event.type === 'candidates' && !classifyResolved) sawCandidateBeforeClassify = true
    events.push(event)
  }

  assert.ok(sawCandidateBeforeClassify, 'urgent extractor should produce before classification resolves')
  assert.deepEqual(
    finalCandidates(events).map(c => c.key),
    ['video'],
  )
})

test('an urgent extractor sees no html — the body has not been fetched', async () => {
  let seen: string | undefined = 'unset'
  const urgentExtractor: Extractor = {
    key: 'ytdlp',
    tier: 'signal',
    urgent: () => true,
    matches: () => true,
    async *probe(ctx) {
      seen = ctx.classification.html
      yield candidate('video', 'video')
    },
  }

  for await (const _ of probeUrl('https://youtu.be/abc', {
    extractors: [urgentExtractor],
    classifyImpl: fakeClassify() as never,
  })) {
    // drain
  }
  assert.equal(seen, undefined)
})

test('a dead link does not get mined for its error page', async () => {
  const dead: Classification = {...htmlClassification, status: 404, html: '<img src="/404-art.png">'}
  await assert.rejects(
    async () => {
      for await (const _ of probeUrl('https://example.com/gone', {
        extractors: [fake('page', [candidate('a', 'image')])],
        classifyImpl: fakeClassify(dead) as never,
      })) {
        // drain
      }
    },
    /dead \(404\)/,
  )
})

test('classification is reported before any candidate', async () => {
  const events = await collect('https://example.com/shot', [fake('page', [candidate('a', 'image')])])
  const classifiedAt = events.findIndex(e => e.type === 'classified')
  const firstCandidateAt = events.findIndex(e => e.type === 'candidates')
  assert.ok(classifiedAt >= 0)
  assert.ok(classifiedAt < firstCandidateAt)
})
