import fs from 'node:fs/promises'
import {loadItems} from './log.js'
import {blobMetaPath, findOriginal} from './paths.js'
import type {BlobMeta, Item, Kind} from './types.js'

/**
 * Library search — what `yoinks find` and the MCP `search_inspiration` tool
 * both call.
 *
 * Filters are AND across kinds and OR within one: `--tag a --tag b --kind
 * image` is "(a or b) and an image". That's the only combination that reads
 * the way people say it out loud, and it's what every search box they already
 * know does.
 *
 * See docs/cli.md#yoinks-find-query.
 */

export type Filters = {
  /** free text over title, note, tags, board, site */
  text?: string
  boards?: string[]
  tags?: string[]
  kinds?: Kind[]
  /** ISO date; a bare `YYYY-MM-DD` covers that whole day */
  since?: string
  until?: string
  /** hex, ranks by palette distance */
  color?: string
  limit?: number
}

export type Hit = {
  item: Item
  /** undefined when the blob has no meta yet — derivation may simply not have run */
  meta?: BlobMeta
  /** absolute path to the original */
  path?: string
  score: number
}

const DEFAULT_LIMIT = 20

/**
 * Per-field weight for free text. `note` wins because why *you* saved
 * something is not recoverable from the pixels, and `site` loses because every
 * asset from one domain shares it, so it separates nothing.
 */
const WEIGHTS = {note: 1, title: 0.7, tag: 0.55, board: 0.4, site: 0.25}

/** Black to white under the weighted metric below. */
const MAX_DISTANCE = Math.sqrt((2 + 4 + 3) * 255 * 255)

export async function search(filters: Filters): Promise<Hit[]> {
  const limit = filters.limit ?? DEFAULT_LIMIT
  const items = await loadItems()

  // kind and color are the only filters that need the blob's meta.json, so
  // everything else decides membership first, without touching disk
  const cheap: Filters = {...filters, kinds: undefined, color: undefined}
  const candidates = items.filter(item => scoreItem(item, undefined, cheap) !== undefined)

  if (!filters.kinds?.length && !filters.color) {
    const ranked = sortHits(candidates.map(item => ({item, score: scoreItem(item, undefined, filters) ?? 0})))
    // nothing in the ranking looked at meta, so only the page we return pays for i/o
    return Promise.all(ranked.slice(0, limit).map(hit => attach(hit)))
  }

  const hydrated = await Promise.all(candidates.map(item => attach({item, score: 0})))
  const hits: Hit[] = []
  for (const hit of hydrated) {
    const score = scoreItem(hit.item, hit.meta, filters)
    if (score !== undefined) hits.push({...hit, score})
  }
  return sortHits(hits).slice(0, limit)
}

/**
 * Exposed for testing and reuse — pure, no i/o.
 *
 * Undefined means "excluded". Text is nominally a ranking signal, but a query
 * word that lands nowhere excludes too: otherwise "dark editorial" would
 * return everything dark, ranked slightly lower.
 */
export function scoreItem(item: Item, meta: BlobMeta | undefined, filters: Filters): number | undefined {
  if (filters.boards?.length && !overlaps(item.boards, filters.boards)) return undefined
  if (filters.tags?.length && !overlaps(item.tags, filters.tags)) return undefined
  // kind lives on the blob, not the item, so an item we have no meta for can't
  // claim to be one
  if (filters.kinds?.length && (!meta || !filters.kinds.includes(meta.kind))) return undefined

  const stamp = item.source.captured_at || item.ts
  if (filters.since && stamp < filters.since) return undefined
  if (filters.until && stamp > endOfDay(filters.until)) return undefined

  let score = 0

  if (filters.text?.trim()) {
    const text = scoreText(item, filters.text)
    if (text === undefined) return undefined
    score += text
  }

  const color = filters.color
  if (color && parseHex(color)) {
    // an item with no palette scores 0 here rather than being dropped: a
    // missing palette means derivation hasn't run, not that the color is wrong.
    // With `color` alone that lands it last, which is the honest place for it.
    const palette = meta?.palette ?? []
    const nearest = palette.reduce((best, entry) => Math.min(best, colorDistance(entry.hex, color)), 1)
    score += 1 - nearest
  }

  return score
}

/**
 * Weighted RGB distance, normalized to 0..1. Green is weighted heaviest
 * because the eye is; it's the cheap stand-in for a perceptual metric and it
 * needs no color-space conversion to rank a palette.
 *
 * Unparseable input is maximally distant rather than a throw — a typo in
 * `--color` should quietly rank nothing, not end the search.
 */
export function colorDistance(a: string, b: string): number {
  const left = parseHex(a)
  const right = parseHex(b)
  if (!left || !right) return 1
  const dr = left[0] - right[0]
  const dg = left[1] - right[1]
  const db = left[2] - right[2]
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / MAX_DISTANCE
}

/** Mean of the best field each word hit, so the result is 0..1 whatever the query length. */
function scoreText(item: Item, text: string): number | undefined {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 0

  const haystacks: Array<readonly [string, number]> = []
  const push = (value: string | undefined, weight: number) => {
    if (value) haystacks.push([value.toLowerCase(), weight] as const)
  }
  push(item.note, WEIGHTS.note)
  push(item.source.title, WEIGHTS.title)
  push(item.tags.join(' '), WEIGHTS.tag)
  push(item.boards.join(' '), WEIGHTS.board)
  push(item.source.site, WEIGHTS.site)

  let total = 0
  for (const word of words) {
    let best = 0
    for (const [value, weight] of haystacks) {
      if (value.includes(word)) best = Math.max(best, weight)
    }
    if (!best) return undefined
    total += best
  }
  return total / words.length
}

function overlaps(have: string[], want: string[]): boolean {
  const present = new Set(have.map(value => value.trim().toLowerCase()))
  return want.some(value => present.has(value.trim().toLowerCase()))
}

/**
 * A bare `--until 2026-01-31` means the end of that day. Compared as iso
 * strings it would otherwise drop everything captured *on* the 31st, which is
 * the opposite of why anyone types it.
 */
function endOfDay(until: string): string {
  return until.includes('T') ? until : `${until}T23:59:59.999Z`
}

function parseHex(value: string | undefined): [number, number, number] | undefined {
  const hex = value?.trim().replace(/^#/, '').toLowerCase()
  if (!hex || !/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex)) return undefined
  const full = hex.length === 3 ? hex.replace(/./g, char => char + char) : hex
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

async function attach(hit: Hit): Promise<Hit> {
  const sha256 = hit.item.sha256
  if (!sha256) return hit
  const [meta, original] = await Promise.all([readMeta(sha256), findOriginal(sha256)])
  return {...hit, meta, path: original}
}

async function readMeta(sha256: string): Promise<BlobMeta | undefined> {
  try {
    return JSON.parse(await fs.readFile(blobMetaPath(sha256), 'utf8')) as BlobMeta
  } catch {
    return undefined // not derived yet, or half-written — a hit without meta is still a hit
  }
}

/** Score desc, then id desc — ulids sort by creation time, so that's newest first. */
function sortHits(hits: Hit[]): Hit[] {
  return hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0
  })
}
