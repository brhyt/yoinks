import {boardKey} from '../store/ingest.js'
import {search, type Hit} from '../store/query.js'
import type {Kind, PaletteEntry} from '../store/types.js'
import {CommandError, envelopeFor, ok, type Envelope} from './json.js'

/**
 * The synthesis pass — everything else returns records, this returns direction.
 *
 * A brief is what an agent reads instead of guessing at your taste: the palette
 * your references actually share, the type they actually show, your own words,
 * and absolute paths so the agent can open the files and look.
 *
 * Two rules hold the whole thing up.
 *
 * Nothing here is a language-model call. The brief is arithmetic over the
 * library — fast, offline, deterministic, identical every run — which matters
 * because it feeds a generator that is already stochastic and must not be handed
 * more noise.
 *
 * And nothing here invents. Every hex traces to a real blob palette or to a
 * weighted merge of near-identical ones; every note is the sentence a person
 * wrote, verbatim, because that a person wrote it about a specific thing is the
 * entire value of the field.
 *
 * See docs/agents.md#brief.
 */

const DEFAULT_LIMIT = 8

/**
 * Two entries closer than this are the same color across references.
 *
 * Measured on `distance()` below — 0 for identical, 765 for black against white,
 * the same metric derive.ts uses and *not* CIE Lab's 0..100, so this is not a
 * ΔE. Tighter than derive.ts's 25 on purpose: inside one image the clusters
 * being merged are two slices of one gradient, while across references they are
 * two designers' separate choices, and averaging those hands an agent a color
 * neither reference contains.
 */
const FUSE_DISTANCE = 8

/** Weights are rounded here so a brief reads as numbers, not float residue. */
const WEIGHT_PLACES = 4

export type BriefPalette = {hex: string; weight: number; role?: string}

export type BriefReference = {
  id: string
  /** absolute path to the original — absent with --no-paths, or when no blob is on disk */
  path?: string
  /** the blob's kind; absent when derivation hasn't written a meta.json yet */
  kind?: Kind
  source: string
  title?: string
  note?: string
  palette: string[]
}

export type Brief = {
  query: string
  matched: number
  palette: BriefPalette[]
  type: {families: Array<{name: string; seen_in: number}>}
  notes: string[]
  references: BriefReference[]
}

// --- palette fusion ---------------------------------------------------------

type Rgb = [number, number, number]

type Cluster = {r: number; g: number; b: number; weight: number}

/**
 * Fuse many blob palettes into one weighted board palette.
 *
 * Pure and deterministic: entries are pooled, sorted by weight then hex, and
 * merged greedily, so the result depends on the multiset of inputs and on
 * nothing else — not on which reference came back first.
 */
export function fusePalettes(palettes: PaletteEntry[][], mergeDistance: number = FUSE_DISTANCE): BriefPalette[] {
  const pooled: Array<{rgb: Rgb; hex: string; weight: number}> = []

  for (const palette of palettes ?? []) {
    const usable: Array<{rgb: Rgb; hex: string; weight: number}> = []
    for (const entry of palette ?? []) {
      const rgb = parseHex(entry?.hex)
      const weight = Number(entry?.weight)
      if (rgb && Number.isFinite(weight) && weight > 0) usable.push({rgb, hex: formatHex(rgb), weight})
    }
    const total = usable.reduce((sum, entry) => sum + entry.weight, 0)
    // one reference, one vote: a palette whose weights happen to sum to three
    // must not outvote the rest of the board by being differently scaled
    for (const entry of usable) pooled.push({...entry, weight: entry.weight / total})
  }
  if (!pooled.length) return []

  pooled.sort((a, b) => b.weight - a.weight || compare(a.hex, b.hex))

  const clusters: Cluster[] = []
  for (const entry of pooled) {
    const [r, g, b] = entry.rgb
    const near = clusters.find(cluster => distance([cluster.r, cluster.g, cluster.b], entry.rgb) < mergeDistance)
    if (!near) {
      clusters.push({r, g, b, weight: entry.weight})
      continue
    }
    const weight = near.weight + entry.weight
    near.r = (near.r * near.weight + r * entry.weight) / weight
    near.g = (near.g * near.weight + g * entry.weight) / weight
    near.b = (near.b * near.weight + b * entry.weight) / weight
    near.weight = weight
  }

  const total = clusters.reduce((sum, cluster) => sum + cluster.weight, 0)
  return clusters
    .map(cluster => ({hex: formatHex([cluster.r, cluster.g, cluster.b]), weight: round(cluster.weight / total)}))
    .sort((a, b) => b.weight - a.weight || compare(a.hex, b.hex))
}

// --- roles ------------------------------------------------------------------

/** Beyond these a color is dark enough or light enough to sit under everything else. */
const DARK_ENOUGH = 0.35
const LIGHT_ENOUGH = 0.65

/** Below this the two colors are too close to call one of them the writing. */
const MIN_TEXT_CONTRAST = 0.3

/** Rgb spread, 0..255. A gray is never an accent however rare it is. */
const MIN_ACCENT_CHROMA = 40
const MAX_MUTED_CHROMA = 40

const MUTED_LOW = 0.25
const MUTED_HIGH = 0.75

/** On the 0..765 metric — a surface is a shade of the background, not another color. */
const NEAR_BACKGROUND = 120

/**
 * Label background / surface / text / muted / accent by luminance and chroma.
 *
 * A role is a hint to whoever reads the brief, never a claim about the
 * references: pluck has seen color statistics, not a layout, so it cannot know
 * that the heaviest dark color was the page background. Anything the heuristic
 * isn't confident about is left unlabeled rather than guessed at, and a
 * consumer is free to ignore every one of these and use the weights.
 */
export function assignRoles(palette: BriefPalette[]): BriefPalette[] {
  const rgbs = palette.map(entry => parseHex(entry.hex))
  const roles = new Map<number, string>()

  // heaviest first, so every "pick one" below resolves ties toward the color
  // the references lean on most
  const order = palette
    .map((_, index) => index)
    .sort((a, b) => palette[b]!.weight - palette[a]!.weight || compare(palette[a]!.hex, palette[b]!.hex))
  const open = () => order.filter(index => rgbs[index] && !roles.has(index))
  const rgb = (index: number) => rgbs[index]!

  const background = open().find(index => {
    const light = luminance(rgb(index))
    return light <= DARK_ENOUGH || light >= LIGHT_ENOUGH
  })
  if (background !== undefined) roles.set(background, 'background')

  if (background !== undefined) {
    const anchor = luminance(rgb(background))
    const text = best(open(), index => {
      const contrast = Math.abs(luminance(rgb(index)) - anchor)
      return contrast >= MIN_TEXT_CONTRAST ? contrast : undefined
    })
    if (text !== undefined) roles.set(text, 'text')
  }

  // the accent is the color a reference spends least and means most by — which
  // is exactly what ranking on weight alone throws away first
  const average = palette.reduce((sum, entry) => sum + entry.weight, 0) / (palette.length || 1)
  const accent = best(open(), index => {
    if (palette[index]!.weight > average) return undefined
    const paint = chroma(rgb(index))
    return paint >= MIN_ACCENT_CHROMA ? paint : undefined
  })
  if (accent !== undefined) roles.set(accent, 'accent')

  if (background !== undefined) {
    const anchor = rgb(background)
    const surface = open().find(index => distance(rgb(index), anchor) < NEAR_BACKGROUND)
    if (surface !== undefined) roles.set(surface, 'surface')
  }

  const muted = open().find(index => {
    const light = luminance(rgb(index))
    return chroma(rgb(index)) <= MAX_MUTED_CHROMA && light > MUTED_LOW && light < MUTED_HIGH
  })
  if (muted !== undefined) roles.set(muted, 'muted')

  return palette.map((entry, index) => {
    const role = roles.get(index)
    return role ? {...entry, role} : {...entry}
  })
}

/** First candidate wins a tie, and candidates arrive heaviest first. */
function best(indices: number[], score: (index: number) => number | undefined): number | undefined {
  let winner: number | undefined
  let top = -Infinity
  for (const index of indices) {
    const value = score(index)
    if (value !== undefined && value > top) {
      winner = index
      top = value
    }
  }
  return winner
}

// --- the brief --------------------------------------------------------------

export async function buildBrief(opts: {query?: string; board?: string; limit?: number}): Promise<Brief> {
  const query = opts.query?.trim() ?? ''
  const board = opts.board?.trim()

  const hits = await search({
    text: query || undefined,
    // items store board *keys*, so a board named as it was typed has to be
    // slugified the way ingest slugified it
    boards: board ? [boardKey(board)] : undefined,
    limit: opts.limit ?? DEFAULT_LIMIT,
  })

  const palettes = hits.map(hit => hit.meta?.palette ?? []).filter(entries => entries.length > 0)

  return {
    query,
    matched: hits.length,
    palette: assignRoles(fusePalettes(palettes)),
    type: {families: familiesOf(hits)},
    notes: notesOf(hits),
    references: hits.map(referenceOf),
  }
}

/** Ranked by how many references show them, not by how often one page repeats one. */
function familiesOf(hits: readonly Hit[]): Array<{name: string; seen_in: number}> {
  const counts = new Map<string, number>()
  for (const hit of hits) {
    const families = new Set((hit.meta?.fonts ?? []).map(name => name.trim()).filter(Boolean))
    for (const name of families) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, seen_in]) => ({name, seen_in}))
    .sort((a, b) => b.seen_in - a.seen_in || compare(a.name, b.name))
}

function notesOf(hits: readonly Hit[]): string[] {
  const notes: string[] = []
  for (const hit of hits) {
    const note = hit.item.note?.trim()
    // verbatim, and once: the same picture saved from two articles carries the
    // same sentence twice, and repeating it reads like two people agreeing
    if (note && !notes.includes(note)) notes.push(note)
  }
  return notes
}

function referenceOf(hit: Hit): BriefReference {
  const title = hit.item.source.title?.trim()
  const note = hit.item.note?.trim()
  return {
    id: hit.item.id,
    ...(hit.path ? {path: hit.path} : {}),
    ...(hit.meta ? {kind: hit.meta.kind} : {}),
    source: hit.item.source.url,
    ...(title ? {title} : {}),
    ...(note ? {note} : {}),
    palette: hit.meta?.palette?.map(entry => entry.hex) ?? [],
  }
}

/** `--no-paths` and `--no-notes` drop fields. Neither ever rewrites one. */
function shaped(brief: Brief, keep: {paths: boolean; notes: boolean}): Brief {
  if (keep.paths && keep.notes) return brief
  return {
    ...brief,
    // the key stays, empty: a consumer reading `notes.length` should see none of
    // them, not trip over an undefined
    notes: keep.notes ? brief.notes : [],
    references: brief.references.map(reference => ({
      id: reference.id,
      ...(keep.paths && reference.path ? {path: reference.path} : {}),
      ...(reference.kind ? {kind: reference.kind} : {}),
      source: reference.source,
      ...(reference.title ? {title: reference.title} : {}),
      ...(keep.notes && reference.note ? {note: reference.note} : {}),
      palette: reference.palette,
    })),
  }
}

// --- flags ------------------------------------------------------------------

type Flags = {positional: string[]; values: Map<string, string>; bools: Set<string>}

/** `--json` is the caller's business, but it arrives in every tail, so it isn't a typo. */
const ALWAYS_BOOLEAN = ['json']

function parseFlags(args: string[], spec: {boolean: readonly string[]; single: readonly string[]}): Flags {
  const booleans = new Set([...ALWAYS_BOOLEAN, ...spec.boolean])
  const single = new Set(spec.single)
  const flags: Flags = {positional: [], values: new Map(), bools: new Set()}

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    // everything after a bare `--` is text, so a query can start with a dash
    if (arg === '--') {
      flags.positional.push(...args.slice(index + 1))
      break
    }
    if (!arg.startsWith('--')) {
      flags.positional.push(arg)
      continue
    }

    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    const inline = equals === -1 ? undefined : arg.slice(equals + 1)

    if (booleans.has(name)) {
      if (inline !== undefined) throw new CommandError('usage', `--${name} takes no value`)
      flags.bools.add(name)
      continue
    }
    if (!single.has(name)) throw new CommandError('usage', `unknown flag “--${name}”`)

    const value = inline ?? args[++index]
    if (value === undefined) throw new CommandError('usage', `--${name} needs a value`)
    if (flags.values.has(name)) throw new CommandError('usage', `--${name} can only be given once`)
    flags.values.set(name, value)
  }

  return flags
}

function positiveInt(flags: Flags, name: string, fallback: number): number {
  const raw = flags.values.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new CommandError('usage', `--${name} needs a whole number above zero, not “${raw}”`)
  }
  return value
}

// --- command ----------------------------------------------------------------

export async function cmdBrief(args: string[]): Promise<Envelope<unknown>> {
  try {
    const flags = parseFlags(args, {boolean: ['md', 'no-paths', 'no-notes'], single: ['board', 'limit']})

    const board = flags.values.get('board')
    if (board !== undefined && !boardKey(board)) {
      throw new CommandError('usage', `“${board}” has no letters or numbers to make a board out of`)
    }

    const brief = shaped(
      await buildBrief({
        query: flags.positional.join(' ').trim(),
        board,
        limit: positiveInt(flags, 'limit', DEFAULT_LIMIT),
      }),
      {paths: !flags.bools.has('no-paths'), notes: !flags.bools.has('no-notes')},
    )

    return ok(flags.bools.has('md') ? {markdown: renderBriefMarkdown(brief)} : brief)
  } catch (error) {
    return envelopeFor(error)
  }
}

// --- markdown ---------------------------------------------------------------

/**
 * The same data, for pasting into a prompt by hand. Whatever the envelope was
 * shaped by — dropped paths, dropped notes — is already gone by the time this
 * renders, so the two surfaces can never disagree about what was withheld.
 */
export function renderBriefMarkdown(brief: Brief): string {
  const lines: string[] = [brief.query ? `# Brief — ${brief.query}` : '# Brief']

  if (!brief.matched) {
    lines.push('', 'Nothing in the library matched.')
    return lines.join('\n')
  }
  lines.push('', `${plural(brief.matched, 'reference')}.`)

  const section = (title: string, body: string[]) => {
    if (body.length) lines.push('', `## ${title}`, '', ...body)
  }

  section(
    'Palette',
    brief.palette.map(entry => {
      const share = `${(entry.weight * 100).toFixed(1)}%`
      return `- \`${entry.hex}\` — ${share}${entry.role ? ` · ${entry.role}` : ''}`
    }),
  )
  section(
    'Type',
    brief.type.families.map(family => `- ${family.name} — seen in ${plural(family.seen_in, 'reference')}`),
  )
  section('Notes', brief.notes.map(note => `- ${note}`))

  const references: string[] = []
  brief.references.forEach((reference, index) => {
    const kind = reference.kind ? ` · ${reference.kind}` : ''
    references.push(`${index + 1}. ${reference.title || reference.source}${kind}`)
    const detail = (value: string | undefined) => {
      if (value) references.push(`   ${value}`)
    }
    detail(reference.title ? reference.source : undefined)
    detail(reference.path)
    detail(reference.note ? `“${reference.note}”` : undefined)
    detail(reference.palette.join(' '))
  })
  section('References', references)

  // an agent that skips this step is back to writing an ordinary style prompt
  if (brief.references.some(reference => reference.path)) {
    lines.push('', 'Open the files above before building — the paths are the point.')
  }

  return lines.join('\n')
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

// --- color ------------------------------------------------------------------

function parseHex(value: string | undefined): Rgb | undefined {
  const hex = value?.trim().replace(/^#/, '').toLowerCase()
  if (!hex || !/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex)) return undefined
  const full = hex.length === 3 ? hex.replace(/./g, char => char + char) : hex
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function formatHex(rgb: Rgb): string {
  const channel = (value: number) =>
    Math.min(255, Math.max(0, Math.round(value)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

/**
 * Weighted rgb distance, `sqrt(2dr² + 4dg² + 3db²)` — derive.ts's metric, kept
 * identical so one threshold means the same thing on both sides of the library.
 * Runs 0 for identical to 765 for black against white.
 */
function distance(a: Rgb, b: Rgb): number {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db)
}

/** Rec. 709 weights on raw channels, 0..1. No gamma: this ranks colors, it doesn't render them. */
function luminance(rgb: Rgb): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
}

/** Chroma as plain rgb spread, 0..255 — the same cheap stand-in derive.ts uses. */
function chroma(rgb: Rgb): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const round = (value: number): number => {
  const scale = 10 ** WEIGHT_PLACES
  return Math.round(value * scale) / scale
}
