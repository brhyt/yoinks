import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {pageExtractor} from './page.js'
import type {Candidate, Classification} from './types.js'

/**
 * The page extractor never touches the network here: every case builds a
 * classification by hand around a saved fixture, so the suite stays offline
 * and the parser is tested against the malformed html it will actually meet.
 */

const BASE = 'https://mirador.studio/studio/2026/selected-work'
const COVER = 'https://cdn.mirador.studio/og/cover.jpg?w=1200&fit=crop'
const LAZY_BASE = 'https://kestrel.tools/index.html'

const portfolio = fixture('portfolio.html')
const broken = fixture('broken.html')
const lazy = fixture('lazy.html')

function fixture(name: string): string {
  return fs.readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
}

function classify(html: string, url = BASE): Classification {
  return {url, mime: 'text/html', kind: 'page', isHtml: true, html}
}

async function probe(html: string, url = BASE): Promise<Candidate[]> {
  const found: Candidate[] = []
  for await (const candidate of pageExtractor.probe({url, classification: classify(html, url)})) {
    found.push(candidate)
  }
  return found
}

const urls = (found: Candidate[]) => found.map(candidate => candidate.hint?.url)
const row = (found: Candidate[], needle: string) => found.find(c => c.hint?.url?.includes(needle))

test('matches an html classification only once the body came with it', () => {
  const url = new URL(BASE)
  assert.equal(pageExtractor.key, 'page')
  assert.equal(pageExtractor.tier, 'always')
  assert.equal(pageExtractor.matches(url, classify(portfolio)), true)
  assert.equal(pageExtractor.matches(url, {url: BASE, isHtml: true}), false)
  assert.equal(pageExtractor.matches(url, {url: BASE, isHtml: false, html: portfolio}), false)
})

test('a portfolio page yields its rows in kind, score and label order', async () => {
  const found = await probe(portfolio)
  assert.deepEqual(
    found.map(candidate => [candidate.kind, candidate.score, candidate.label]),
    [
      ['image', 900, 'og:image · jpg · 1200×630'],
      ['image', 890, 'twitter:image · png'],
      ['font', 600, 'font · woff2'],
      ['font', 600, 'font · woff'],
      ['font', 600, 'font · otf'],
      ['image', 500, 'image · webp · 2048×1280'],
      ['image', 500, 'image · png'],
      ['image', 500, 'image · png'],
      ['image', 500, 'image · jpg · 1600×900'],
      ['image', 400, 'image · avif'],
      ['image', 400, 'image · jpg'],
      ['palette', 300, 'palette · 7 colors'],
    ],
  )
  assert.deepEqual(
    found.map(candidate => candidate.key),
    [
      `page:image:${COVER}`,
      'page:image:https://mirador.studio/static/twitter-card.png',
      'page:font:https://mirador.studio/fonts/soehne-buch.woff2',
      'page:font:https://mirador.studio/fonts/soehne-buch.woff',
      'page:font:https://cdn.mirador.studio/fonts/gt-america-mono.otf',
      'page:image:https://mirador.studio/work/dashboard-2048.webp',
      'page:image:https://mirador.studio/work/poster@2x.png',
      'page:image:https://mirador.studio/work/type-specimen.png',
      'page:image:https://mirador.studio/studio/2026/photos/studio-wall.jpg',
      'page:image:https://cdn.mirador.studio/hero/poster.avif',
      'page:image:https://mirador.studio/static/legacy-thumb.jpg',
      'page:palette',
    ],
  )
  assert.equal(new Set(found.map(candidate => candidate.key)).size, found.length)
  assert.ok(found.every(candidate => candidate.extractor === 'page'))
})

test('og:image beats the same file appearing as an <img>, and the query string survives', async () => {
  const cover = (await probe(portfolio)).filter(candidate => candidate.hint?.url === COVER)
  assert.equal(cover.length, 1)
  assert.equal(cover[0]!.score, 900)
  assert.equal(cover[0]!.label, 'og:image · jpg · 1200×630')
  // the fixture writes &amp; — sending that literally is a 404
  assert.ok(COVER.includes('&fit=crop'))
  assert.ok(!cover[0]!.key.includes('&amp;'))
})

test('srcset picks the largest w, falls back to the largest x, and keeps the tag dimensions', async () => {
  const found = await probe(portfolio)
  const dashboard = found.find(candidate => candidate.hint?.url?.includes('dashboard'))
  assert.equal(dashboard?.hint?.url, 'https://mirador.studio/work/dashboard-2048.webp')
  assert.equal(dashboard?.hint?.width, 2048)
  assert.equal(dashboard?.hint?.height, 1280)
  assert.deepEqual(
    urls(found).filter(url => url?.includes('poster@')),
    ['https://mirador.studio/work/poster@2x.png'],
  )
})

test('urls resolve against the classification url, not the html', async () => {
  assert.ok(urls(await probe(portfolio)).includes('https://mirador.studio/studio/2026/photos/studio-wall.jpg'))
  const moved = await probe(portfolio, 'https://mirador.studio/archive/index.html')
  assert.ok(urls(moved).includes('https://mirador.studio/archive/photos/studio-wall.jpg'))
  assert.ok(urls(moved).includes('https://mirador.studio/static/twitter-card.png'))
})

test('data: and blob: sources are ignored entirely', async () => {
  const found = await probe(portfolio)
  const media = found.filter(candidate => candidate.kind !== 'palette')
  assert.ok(media.every(candidate => candidate.hint?.url?.startsWith('https://')))
  assert.ok(!urls(found).some(url => url?.includes('9c4f8a-e21')))
})

test('fonts come from both @font-face and a preload link, deduped across the two', async () => {
  const fonts = (await probe(portfolio)).filter(candidate => candidate.kind === 'font')
  assert.deepEqual(urls(fonts), [
    'https://mirador.studio/fonts/soehne-buch.woff2',
    'https://mirador.studio/fonts/soehne-buch.woff',
    'https://cdn.mirador.studio/fonts/gt-america-mono.otf',
  ])
  // the @font-face block also loads grain.png through url() — not a font
  assert.ok(!urls(fonts).some(url => url?.endsWith('.png')))
})

test('every custom property that holds a color lands in one palette candidate', async () => {
  const palette = (await probe(portfolio)).find(candidate => candidate.kind === 'palette')
  assert.ok(palette)
  assert.equal(palette.key, 'page:palette')
  assert.equal(palette.label, 'palette · 7 colors')
  assert.equal(palette.score, 300)

  const outDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pluck-page-')), 'colors')
  try {
    const fetched = await palette.fetch({outDir})
    assert.deepEqual(fetched, {
      path: path.join(outDir, 'palette.json'),
      mime: 'application/json',
      filename: 'palette.json',
    })
    assert.equal(
      await fs.promises.readFile(fetched.path, 'utf8'),
      `${JSON.stringify(
        {
          colors: [
            '#0b0d10',
            '#e8e6e3',
            '#ff6b35',
            'rgba(255, 107, 53, 0.18)',
            'hsl(210 12% 96%)',
            '#0b0d1033',
            '#12151a',
          ],
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await fs.promises.rm(path.dirname(outDir), {recursive: true, force: true})
  }
})

test('a page with no colors yields no palette row at all', async () => {
  const found = await probe('<html><style>:root{--gap:24px;--font:"Söhne",serif}</style><body></body></html>')
  assert.equal(found.length, 0)
})

test('a lazy-loaded page yields every real image and nothing interface-sized', async () => {
  const found = await probe(lazy, LAZY_BASE)
  assert.deepEqual(
    found.map(candidate => [candidate.score, candidate.label]),
    [
      [900, 'og:image · png · 20×20'],
      [890, 'twitter:image · png'],
      [500, 'image · jpg · 400×300'],
      [500, 'image · jpg'],
      [500, 'image · jpg'],
      [500, 'image · jpg'],
      [500, 'image · jpg'],
      [500, 'image · jpg'],
      [500, 'image · webp · 2400×1600'],
      [500, 'image · png'],
      [500, 'image · webp'],
      [500, 'image · webp'],
      [500, 'image · jpg'],
      [400, 'image · avif'],
      [250, 'image · jpg · 150×150'],
    ],
  )
  assert.equal(new Set(found.map(candidate => candidate.key)).size, found.length)
})

test('a declared side of 32px or less is interface, and never reaches the picker', async () => {
  const found = urls(await probe(lazy, LAZY_BASE))
  assert.ok(!found.some(url => url?.includes('px.kestrel.tools'))) // 1×1 tracking pixel
  assert.ok(!found.some(url => url?.includes('chevron'))) // 8×8 icon
  assert.ok(!found.some(url => url?.includes('logo-lockup'))) // 140×11 wordmark
})

test('a thumbnail is ranked down, a big or unmeasured image is not', async () => {
  const found = await probe(lazy, LAZY_BASE)
  assert.equal(row(found, 'thumb-atlas')?.score, 250)
  assert.equal(row(found, 'atlas-hero')?.score, 500)
  // no width/height at all is unknown, which is not the same as small
  assert.equal(row(found, 'undeclared')?.score, 500)
  assert.equal(row(found, 'mural-2400')?.score, 500)
})

test('lazy-loading attributes are read in the order a browser would pick them', async () => {
  const found = urls(await probe(lazy, LAZY_BASE))
  // src holds a data: placeholder, so data-src is what the page actually shows
  assert.ok(found.includes('https://kestrel.tools/work/lazy-loop.jpg'))
  assert.ok(found.includes('https://kestrel.tools/work/lazy-1920.jpg'))
  assert.ok(found.includes('https://kestrel.tools/work/lazy-late.jpg'))
  assert.ok(found.includes('https://kestrel.tools/work/original-only.jpg'))
  // data-lazy-src outranks data-original on the tag that carries both
  assert.ok(!found.includes('https://kestrel.tools/work/never-picked.jpg'))
})

test('an art-directed <picture> is one row at its largest crop, not one row per crop', async () => {
  const found = await probe(lazy, LAZY_BASE)
  // four <source> entries plus an <img> fallback, all of the same photograph
  assert.deepEqual(urls(found).filter(url => url?.includes('mural')), [
    'https://kestrel.tools/work/mural-2400.webp',
  ])
  // the sources carry no dimensions; the fallback <img> is where they live
  assert.equal(row(found, 'mural')?.label, 'image · webp · 2400×1600')
  assert.deepEqual([row(found, 'mural')?.hint?.width, row(found, 'mural')?.hint?.height], [2400, 1600])
})

test('each <picture> is counted separately, down to one holding a single <source>', async () => {
  const found = urls(await probe(lazy, LAZY_BASE))
  assert.deepEqual(found.filter(url => url?.includes('kiosk')), ['https://kestrel.tools/work/kiosk.png'])
  assert.deepEqual(found.filter(url => url?.includes('mural')), ['https://kestrel.tools/work/mural-2400.webp'])
})

test('a <source> with no <picture> around it is still its own row', async () => {
  const found = urls(await probe(lazy, LAZY_BASE))
  assert.deepEqual(found.filter(url => url?.includes('stray')), ['https://kestrel.tools/work/stray-2400.webp'])
  // <source src> inside <video> is a movie, not an image
  assert.ok(!found.some(url => url?.includes('reel.mp4')))
})

test('an unclosed <picture> collapses itself and nothing below it', async () => {
  const found = urls(await probe(lazy, LAZY_BASE))
  assert.deepEqual(found.filter(url => url?.includes('orphan')), [
    'https://kestrel.tools/work/orphan-1600.webp',
    'https://kestrel.tools/work/after-orphan.jpg',
  ])
  // and one that runs off the end of a truncated document still resolves
  const cut = await probe('<picture><source srcset="/a-2400.jpg 2400w"><img src="/a.jpg"', LAZY_BASE)
  assert.deepEqual(urls(cut), ['https://kestrel.tools/a-2400.jpg'])
})

test('a preload link contributes its imagesrcset, not just its href', async () => {
  const hero = row(await probe(lazy, LAZY_BASE), 'wide-')
  assert.equal(hero?.hint?.url, 'https://kestrel.tools/hero/wide-3200.avif')
  assert.equal(hero?.score, 400)
})

test('og outranks twitter on a page that declares twitter first', async () => {
  const meta = (await probe(lazy, LAZY_BASE)).filter(candidate => (candidate.score ?? 0) >= 890)
  assert.deepEqual(
    meta.map(candidate => candidate.hint?.url),
    ['https://kestrel.tools/social/og-card.png', 'https://kestrel.tools/social/twitter-card.png'],
  )
})

test('og:image carries its declared size and is never sized out of the picker', async () => {
  const og = row(await probe(lazy, LAZY_BASE), 'og-card')
  assert.equal(og?.score, 900)
  assert.equal(og?.label, 'og:image · png · 20×20')
  assert.deepEqual([og?.hint?.width, og?.hint?.height], [20, 20])
})

test('malformed and truncated html finds less rather than throwing', async () => {
  assert.deepEqual(await probe(broken), [])
  assert.deepEqual(await probe(''), [])
  assert.deepEqual(await probe('<img src=<<<>>> <meta property="og:image"><style>--x:'), [])

  // cut mid-tag: the og:image above the cut is still readable, nothing below it is
  const cut = await probe(portfolio.slice(0, portfolio.indexOf('og:image:secure_url')))
  assert.deepEqual(
    cut.map(candidate => candidate.label),
    ['og:image · jpg'],
  )
})
