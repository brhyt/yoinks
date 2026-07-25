/**
 * What an html page is willing to hand over: the image it picked to represent
 * itself, the images it shows, the webfonts it loads, and the colors it names.
 *
 * Parsed with regex instead of a dom, deliberately. A parser is a dependency,
 * and the html here is whatever the site actually shipped — every pass below
 * is best-effort and skips what it cannot read, so a page that defeats it
 * yields nothing rather than throwing.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {fetchToFile} from './fetch-file.js'
import type {Candidate, Extractor, ProbeContext} from './types.js'

const SCORE = {
  meta: 900,
  twitter: 890,
  font: 600,
  image: 500,
  link: 400,
  palette: 300,
  small: 250,
}

/** Representative-image meta tags, mapped to the label they print and what they rank. */
const IMAGE_META = new Map([
  ['og:image', {label: 'og:image', score: SCORE.meta}],
  ['og:image:url', {label: 'og:image', score: SCORE.meta}],
  ['og:image:secure_url', {label: 'og:image', score: SCORE.meta}],
  ['twitter:image', {label: 'twitter:image', score: SCORE.twitter}],
  ['twitter:image:src', {label: 'twitter:image', score: SCORE.twitter}],
])

/**
 * Declared dimensions are the only cheap signal for interface vs content. A
 * side at or under TINY is an icon or a tracking pixel and never a reference,
 * so it is dropped; under SMALL it ranks below the full-size images but stays,
 * because a thumbnail is now and then the only copy of an image on the page.
 * Declaring nothing counts as full size — most content images declare nothing.
 */
const TINY = 32
const SMALL = 200

/** Lazy-loading conventions, in the order a browser or a hydrating script would pick. */
const IMG_SOURCES = ['srcset', 'data-srcset', 'src', 'data-src', 'data-lazy-src', 'data-original']

/** Attributes holding a srcset rather than a single url. */
const SRCSET_SOURCES = new Set(['srcset', 'data-srcset', 'imagesrcset'])

/** What a `<source>` offers, in precedence order — never its `src`, which may be a movie. */
const SRCSET_SOURCES_ORDER = ['srcset', 'data-srcset']

/** Closes a `<picture>`: its own end tag, or the first tag that cannot be inside one. */
const PICTURE_END = /<\/picture\s*>|<(?!\/?(?:source|img|script|template)\b)[a-z!/]/i

const FONT_EXTENSIONS = new Set(['woff2', 'woff', 'ttf', 'otf'])

const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([^()]*\))$/i

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export const pageExtractor: Extractor = {
  key: 'page',
  tier: 'always',
  matches: (_url, classification) => classification.isHtml && typeof classification.html === 'string',
  probe,
}

async function* probe(ctx: ProbeContext, signal?: AbortSignal): AsyncGenerator<Candidate> {
  const base = ctx.classification.url
  // commented-out markup is still markup to a regex, so drop it up front
  const html = (ctx.classification.html ?? '').replace(/<!--[\s\S]*?-->/g, '')
  // passes run in descending score order, which is what makes dedupe a Set:
  // the first candidate to claim a url is always the highest-scoring one
  const seen = new Set<string>()

  yield* metaImages(html, base, seen)
  if (signal?.aborted) return
  yield* fontFiles(html, base, seen)
  if (signal?.aborted) return
  const inline = inlineImageSources(html, base)
  yield* inlineImages(inline, 'full', seen)
  if (signal?.aborted) return
  yield* linkedImages(html, base, seen)
  if (signal?.aborted) return

  const palette = paletteCandidate(html)
  if (palette) yield palette

  // chrome-sized images go last so they can never claim a url a real one wants
  yield* inlineImages(inline, 'small', seen)
}

function* metaImages(html: string, base: string, seen: Set<string>): Generator<Candidate> {
  const found: {url: string; label: string; score: number}[] = []
  const size: Dimensions = {}

  for (const tag of tags(html, 'meta')) {
    const attrs = attrsOf(tag)
    const name = (attrs.get('property') ?? attrs.get('name') ?? '').trim().toLowerCase()
    // width/height describe the og image object, which og:image, og:image:url
    // and og:image:secure_url are three names for — so they are read once
    if (name === 'og:image:width') size.width ??= pixels(attrs.get('content'))
    if (name === 'og:image:height') size.height ??= pixels(attrs.get('content'))
    const meta = IMAGE_META.get(name)
    if (!meta) continue
    const url = resolve(attrs.get('content'), base)
    if (url) found.push({url, ...meta})
  }

  // og outranks twitter even on a page that declares twitter first: the two
  // usually name the same file, and only the first to claim it gets a row
  for (const entry of found.sort((a, b) => b.score - a.score)) {
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    // the page's own pick — sized for the label, but never sized out of the picker
    yield imageCandidate(entry.url, entry.label, entry.score, entry.label === 'og:image' ? size : undefined)
  }
}

function* fontFiles(html: string, base: string, seen: Set<string>): Generator<Candidate> {
  for (const block of styleBlocks(html)) {
    for (const face of fontFaces(block)) {
      for (const raw of cssUrls(face)) {
        const url = resolve(raw, base)
        if (!url || seen.has(url) || !FONT_EXTENSIONS.has(extensionOf(url))) continue
        seen.add(url)
        yield fontCandidate(url)
      }
    }
  }

  for (const tag of tags(html, 'link')) {
    const attrs = attrsOf(tag)
    if (!relTokens(attrs).has('preload') || (attrs.get('as') ?? '').toLowerCase() !== 'font') continue
    const url = resolve(attrs.get('href'), base)
    if (!url || seen.has(url)) continue
    seen.add(url)
    yield fontCandidate(url)
  }
}

/**
 * Every image the body shows, in document order — with each `<picture>` counted
 * once. Art-directed markup ships four crops of one photograph under four urls,
 * which url dedupe cannot see; the enclosing `<picture>` is the only signal that
 * they are one reference, so each block is resolved to a single best url.
 */
function inlineImageSources(html: string, base: string): ImageSource[] {
  const found: ImageSource[] = []
  let cursor = 0

  for (const block of pictureBlocks(html)) {
    found.push(...looseImageSources(html.slice(cursor, block.start), base))
    const picked = pictureSource(block.inner, base)
    if (picked) found.push(picked)
    cursor = block.end
  }
  found.push(...looseImageSources(html.slice(cursor), base))

  return found
}

/** Every `<img>` and `<source>` outside a `<picture>`, each one its own row. */
function looseImageSources(html: string, base: string): ImageSource[] {
  const found: ImageSource[] = []
  for (const [name, tag] of elements(html, ['img', 'source'])) {
    const attrs = attrsOf(tag)
    // a <source> outside a <picture> belongs to <video> or <audio>, where src
    // is a movie and not an image — only srcset is ever ours
    const url = firstUrl(attrs, name === 'img' ? IMG_SOURCES : SRCSET_SOURCES_ORDER, base)
    if (!url) continue
    const size = dimensionsOf(attrs)
    const scale = scaleOf(size)
    if (scale !== 'tiny') found.push({url, scale, size})
  }
  return found
}

/**
 * One `<picture>` is one reference however many crops it ships: take the
 * largest url across every `<source>` and the fallback `<img>` together. Size
 * comes from the `<img>`, which is where a `<picture>` declares it — the
 * sources carry media queries, not dimensions.
 */
function pictureSource(inner: string, base: string): ImageSource | undefined {
  const pool: SrcsetEntry[] = []
  let fallback: string | undefined
  let size: Dimensions | undefined

  for (const [name, tag] of elements(inner, ['img', 'source'])) {
    const attrs = attrsOf(tag)
    for (const attribute of SRCSET_SOURCES_ORDER) {
      const raw = attrs.get(attribute)
      if (raw) pool.push(...resolvedEntries(raw, base))
    }
    if (name !== 'img') continue
    fallback ??= firstUrl(attrs, IMG_SOURCES, base)
    size ??= dimensionsOf(attrs)
  }

  const url = largest(pool)?.url ?? fallback
  if (!url) return undefined
  const scale = scaleOf(size ?? {})
  return scale === 'tiny' ? undefined : {url, scale, size: size ?? {}}
}

/**
 * `<picture>` bodies with their bounds. A block that is never closed ends at
 * the next tag that cannot legally sit inside one, or at the end of the
 * document — a missing `</picture>` should cost the page one row, not every
 * row below it.
 */
function pictureBlocks(html: string): {start: number; end: number; inner: string}[] {
  const blocks: {start: number; end: number; inner: string}[] = []
  const opener = /<picture\b[^>]*>/gi

  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    const from = match.index + match[0].length
    const closer = PICTURE_END.exec(html.slice(from))
    const at = closer ? from + closer.index : html.length
    const end = closer && /^<\/picture/i.test(closer[0]) ? at + closer[0].length : at
    blocks.push({start: match.index, end, inner: html.slice(from, at)})
    opener.lastIndex = end
  }

  return blocks
}

function* inlineImages(sources: ImageSource[], scale: Scale, seen: Set<string>): Generator<Candidate> {
  for (const source of sources) {
    if (source.scale !== scale || seen.has(source.url)) continue
    seen.add(source.url)
    yield imageCandidate(source.url, 'image', scale === 'small' ? SCORE.small : SCORE.image, source.size)
  }
}

function* linkedImages(html: string, base: string, seen: Set<string>): Generator<Candidate> {
  for (const tag of tags(html, 'link')) {
    const attrs = attrsOf(tag)
    const rel = relTokens(attrs)
    const preloaded = rel.has('preload') && (attrs.get('as') ?? '').toLowerCase() === 'image'
    if (!preloaded && !rel.has('image_src')) continue
    const url = firstUrl(attrs, ['imagesrcset', 'href'], base)
    if (!url || seen.has(url)) continue
    seen.add(url)
    yield imageCandidate(url, 'image', SCORE.link)
  }
}

/** First attribute that carries a usable http(s) url — a srcset of data urls falls through. */
function firstUrl(attrs: Map<string, string>, names: string[], base: string): string | undefined {
  for (const name of names) {
    const raw = attrs.get(name)
    if (raw === undefined) continue
    const url = resolve(SRCSET_SOURCES.has(name) ? largestSrcsetUrl(raw) : raw, base)
    if (url) return url
  }
  return undefined
}

function paletteCandidate(html: string): Candidate | undefined {
  const colors = cssColors(html)
  if (colors.length === 0) return undefined

  return {
    key: 'page:palette',
    kind: 'palette',
    label: `palette · ${colors.length} ${colors.length === 1 ? 'color' : 'colors'}`,
    extractor: 'page',
    fetch: async ctx => {
      await fs.mkdir(ctx.outDir, {recursive: true})
      const target = path.join(ctx.outDir, 'palette.json')
      await fs.writeFile(target, `${JSON.stringify({colors}, null, 2)}\n`)
      return {path: target, mime: 'application/json', filename: 'palette.json'}
    },
    score: SCORE.palette,
  }
}

function imageCandidate(url: string, prefix: string, score: number, size?: Dimensions): Candidate {
  const dimensions = size?.width && size.height ? `${size.width}×${size.height}` : ''
  return {
    key: `page:image:${url}`,
    kind: 'image',
    label: [prefix, extensionOf(url), dimensions].filter(Boolean).join(' · '),
    extractor: 'page',
    fetch: (ctx, signal) => fetchToFile(url, ctx, signal),
    hint: {url, width: size?.width, height: size?.height},
    score,
  }
}

function fontCandidate(url: string): Candidate {
  return {
    key: `page:font:${url}`,
    kind: 'font',
    label: ['font', extensionOf(url)].filter(Boolean).join(' · '),
    extractor: 'page',
    fetch: (ctx, signal) => fetchToFile(url, ctx, signal),
    hint: {url},
    score: SCORE.font,
  }
}

/**
 * Attribute values carry `>` often enough — alt text, inline json, a `<` in a
 * title — that `<img[^>]*>` silently truncates real tags. Scan forward
 * tracking quote state instead, and treat an unterminated tag as the end of
 * the document: truncated html should find less, never throw.
 */
function* elements(html: string, names: string[]): Generator<[name: string, tag: string]> {
  const opener = new RegExp(`<(${names.join('|')})\\b`, 'gi')
  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    const start = match.index + match[0].length
    let quote = ''
    let i = start
    for (; i < html.length; i++) {
      const char = html[i]!
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (i >= html.length) return
    yield [match[1]!.toLowerCase(), html.slice(start, i)]
    opener.lastIndex = i
  }
}

function* tags(html: string, name: string): Generator<string> {
  for (const [, tag] of elements(html, [name])) yield tag
}

function attrsOf(tag: string): Map<string, string> {
  const attribute = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  const attrs = new Map<string, string>()
  for (let match = attribute.exec(tag); match; match = attribute.exec(tag)) {
    const name = match[1]!.toLowerCase()
    if (!attrs.has(name)) attrs.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''))
  }
  return attrs
}

/**
 * Enough of the entity table to keep urls working. An undecoded `&amp;` in a
 * query string is a 404, which is the whole reason this exists.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES[body.toLowerCase()] ?? whole
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
    return String.fromCodePoint(code)
  })
}

/** Absolute http(s) url, or nothing. data:, blob: and javascript: fall out here. */
function resolve(raw: string | undefined, base: string): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  try {
    const url = new URL(value, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

type SrcsetEntry = {url: string; w?: number; x?: number}

function largestSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset ? largest(srcsetEntries(srcset))?.url : undefined
}

/** Largest by `w`, else largest by `x`, else the first — ties keep the earliest entry. */
function largest(entries: SrcsetEntry[]): SrcsetEntry | undefined {
  const widths = entries.filter(entry => entry.w !== undefined)
  const pool = widths.length > 0 ? widths : entries.filter(entry => entry.x !== undefined)
  if (pool.length === 0) return entries[0]
  return pool.reduce((best, entry) => ((entry.w ?? entry.x ?? 0) > (best.w ?? best.x ?? 0) ? entry : best))
}

/** Entries of a srcset that resolve, carrying their descriptors so a group can be ranked as one. */
function resolvedEntries(srcset: string, base: string): SrcsetEntry[] {
  const found: SrcsetEntry[] = []
  for (const entry of srcsetEntries(srcset)) {
    const url = resolve(entry.url, base)
    if (url) found.push({...entry, url})
  }
  return found
}

/**
 * Splitting a srcset on commas is the obvious implementation and it is wrong —
 * urls carry commas (cdn transform strings, data urls). Read the url as a run
 * of non-whitespace the way the spec does, then take the descriptor up to the
 * next comma.
 */
function srcsetEntries(srcset: string): SrcsetEntry[] {
  const entries: SrcsetEntry[] = []
  let i = 0

  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i]!)) i++
    const start = i
    while (i < srcset.length && !/\s/.test(srcset[i]!)) i++
    let url = srcset.slice(start, i)
    let descriptor = ''

    if (url.endsWith(',')) url = url.replace(/,+$/, '')
    else {
      while (i < srcset.length && /\s/.test(srcset[i]!)) i++
      const from = i
      while (i < srcset.length && srcset[i] !== ',') i++
      descriptor = srcset.slice(from, i)
      i++
    }

    if (!url) continue
    const w = /(\d+(?:\.\d+)?)\s*w\b/i.exec(descriptor)?.[1]
    const x = /(\d+(?:\.\d+)?)\s*x\b/i.exec(descriptor)?.[1]
    entries.push({url, w: w ? Number(w) : undefined, x: x ? Number(x) : undefined})
  }

  return entries
}

type Dimensions = {width?: number; height?: number}

type Scale = 'tiny' | 'small' | 'full'

type ImageSource = {url: string; scale: Scale; size: Dimensions}

function dimensionsOf(attrs: Map<string, string>): Dimensions {
  return {width: pixels(attrs.get('width')), height: pixels(attrs.get('height'))}
}

function scaleOf(size: Dimensions): Scale {
  const sides = [size.width, size.height].filter(side => side !== undefined)
  if (sides.some(side => side <= TINY)) return 'tiny'
  if (sides.some(side => side < SMALL)) return 'small'
  return 'full'
}

function pixels(raw: string | undefined): number | undefined {
  const value = raw?.trim() ?? ''
  if (!/^\d+$/.test(value)) return undefined
  const number = Number(value)
  return number > 0 ? number : undefined
}

function extensionOf(url: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(url.split(/[?#]/)[0]!)?.[1]?.toLowerCase() ?? ''
}

function relTokens(attrs: Map<string, string>): Set<string> {
  return new Set((attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean))
}

/** Bodies of every inline `<style>`, including an unclosed one at the end of a cut-off page. */
function* styleBlocks(html: string): Generator<string> {
  const block = /<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi
  for (let match = block.exec(html); match; match = block.exec(html)) yield match[1]!
}

function* styleAttributes(html: string): Generator<string> {
  const attribute = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  for (let match = attribute.exec(html); match; match = attribute.exec(html)) yield match[1] ?? match[2] ?? ''
}

function* fontFaces(css: string): Generator<string> {
  const face = /@font-face\s*\{([^{}]*)(?:\}|$)/gi
  for (let match = face.exec(css); match; match = face.exec(css)) yield match[1]!
}

function* cssUrls(css: string): Generator<string> {
  const url = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi
  for (let match = url.exec(css); match; match = url.exec(css)) yield match[1] ?? match[2] ?? match[3] ?? ''
}

/** Every custom property that holds a color, in declaration order, deduped. */
function cssColors(html: string): string[] {
  const colors: string[] = []
  const seen = new Set<string>()

  for (const chunk of [...styleBlocks(html), ...styleAttributes(html)]) {
    const declaration = /--[\w-]+\s*:\s*([^;}]+)/g
    for (let match = declaration.exec(chunk); match; match = declaration.exec(chunk)) {
      const value = match[1]!.replace(/!important\s*$/i, '').trim().toLowerCase()
      if (!COLOR.test(value) || seen.has(value)) continue
      seen.add(value)
      colors.push(value)
    }
  }

  return colors
}
