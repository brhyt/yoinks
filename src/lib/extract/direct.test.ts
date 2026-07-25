import assert from 'node:assert/strict'
import test from 'node:test'
import {directExtractor} from './direct.js'
import type {Candidate, Classification, Kind} from './types.js'

function classify(overrides: Partial<Classification> = {}): Classification {
  return {
    url: 'https://example.com/shot.png',
    mime: 'image/png',
    bytes: 2048,
    kind: 'image',
    isHtml: false,
    ...overrides,
  }
}

async function probeAll(classification: Classification): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for await (const candidate of directExtractor.probe({url: classification.url, classification})) {
    candidates.push(candidate)
  }
  return candidates
}

async function labelFor(overrides: Partial<Classification>): Promise<string> {
  const [candidate] = await probeAll(classify(overrides))
  return candidate!.label
}

test('claims every url that is already the asset', () => {
  const url = new URL('https://example.com/shot.png')
  const kinds: Kind[] = ['image', 'video', 'audio', 'font']
  for (const kind of kinds) {
    assert.equal(directExtractor.matches(url, classify({kind})), true, kind)
  }
})

test('declines html pages and anything the server left unclassified', () => {
  const url = new URL('https://example.com/shot.png')
  assert.equal(directExtractor.matches(url, classify({kind: 'page', mime: 'text/html', isHtml: true})), false)
  assert.equal(directExtractor.matches(url, classify({kind: undefined, mime: 'application/zip'})), false)
})

test('reads as a picker row with the extension and the size', async () => {
  assert.equal(await labelFor({}), 'original · png · ~2.0 KB')
  assert.equal(await labelFor({url: 'https://example.com/clip.mp4', mime: 'video/mp4', kind: 'video'}), 'original · mp4 · ~2.0 KB')
})

test('drops the size segment and its separator when the size is unknown', async () => {
  const unknown = await labelFor({bytes: undefined})
  assert.equal(unknown, 'original · png')
  assert.equal(unknown.includes('~'), false)

  // a content-length of 0 is just as unknown, and must not render as ~0 B
  assert.equal(await labelFor({bytes: 0}), 'original · png')
})

test('takes the extension from the mime when the url path has none', async () => {
  assert.equal(await labelFor({url: 'https://cdn.example.com/assets/9f8a7b6c', mime: 'image/webp'}), 'original · webp · ~2.0 KB')
  assert.equal(
    await labelFor({url: 'https://cdn.example.com/f/2b41', mime: 'font/woff2', kind: 'font'}),
    'original · woff2 · ~2.0 KB',
  )
  assert.equal(await labelFor({url: 'https://cdn.example.com/i/44dd.php', mime: 'image/jpeg'}), 'original · jpg · ~2.0 KB')
})

test('falls back to the url when the mime is too generic to name a format', async () => {
  const label = await labelFor({
    url: 'https://cdn.example.com/clip.mp4?token=abc',
    mime: 'application/octet-stream',
    kind: 'video',
  })
  assert.equal(label, 'original · mp4 · ~2.0 KB')
})

test('yields exactly one candidate, keyed and scored to sort first', async () => {
  const candidates = await probeAll(classify())
  assert.equal(candidates.length, 1)

  const candidate = candidates[0]!
  assert.equal(candidate.key, 'direct:https://example.com/shot.png')
  assert.equal(candidate.score, 1000)
  assert.equal(candidate.extractor, 'direct')
  assert.equal(candidate.kind, 'image')
  assert.deepEqual(candidate.hint, {bytes: 2048, mime: 'image/png', url: 'https://example.com/shot.png'})
  assert.equal(typeof candidate.fetch, 'function')
})

test('offers nothing rather than throwing when probed without a kind', async () => {
  assert.deepEqual(await probeAll(classify({kind: undefined})), [])
})
