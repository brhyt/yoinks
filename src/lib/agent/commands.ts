import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {probeUrl} from '../extract/index.js'
import {KIND_ORDER, type Candidate, type Kind} from '../extract/types.js'
import {formatBytes, truncate} from '../format.js'
import {deriveBlob} from '../store/derive.js'
import {boardKey, ensureBoard, ingest, loadBoards} from '../store/ingest.js'
import {compact, deleteItem, loadItems, putItem} from '../store/log.js'
import {blobMetaPath, findOriginal} from '../store/paths.js'
import {search, type Filters, type Hit} from '../store/query.js'
import {isoNow, type BlobMeta, type Item} from '../store/types.js'
import {CommandError, envelopeFor, ok, render, type Envelope} from './json.js'

/**
 * The headless verbs.
 *
 * One function per command. Each parses its own flags, answers with an
 * Envelope, and writes nothing anywhere — the caller owns stdout and the exit
 * code. Nothing in here throws either: a stack trace on stdout is not an
 * answer, so every body runs inside `guard`.
 *
 * The rule these share is that ambiguity belongs to the caller. A prefix that
 * names two items, a link that offers three downloads, a hex that isn't one —
 * all of those are usage errors naming the alternatives, never a guess.
 *
 * See docs/cli.md#headless.
 */

const DEFAULT_LIMIT = 20
const DEFAULT_TIMEOUT = 30_000

/** Shorter than this and a typo lands on somebody else's asset. */
const MIN_PREFIX = 4

type Runner = (args: string[]) => Promise<Envelope<unknown>>

async function guard<T>(run: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return ok(await run())
  } catch (error) {
    return envelopeFor(error)
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// --- flags ------------------------------------------------------------------

type Spec = {
  boolean?: readonly string[]
  /** takes a value, may be given once */
  single?: readonly string[]
  /** takes a value, may be given many times */
  repeatable?: readonly string[]
}

type Flags = {
  positional: string[]
  values: Map<string, string[]>
  bools: Set<string>
}

/**
 * `--json` is decided by the caller, but it arrives in every command's tail, so
 * every command has to know it isn't a typo.
 */
const ALWAYS_BOOLEAN = ['json']

function parseFlags(args: string[], spec: Spec): Flags {
  const booleans = new Set([...ALWAYS_BOOLEAN, ...(spec.boolean ?? [])])
  const single = new Set(spec.single ?? [])
  const repeatable = new Set(spec.repeatable ?? [])

  const flags: Flags = {positional: [], values: new Map(), bools: new Set()}

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    // everything after a bare `--` is text, so a note can start with a dash
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
    if (!single.has(name) && !repeatable.has(name)) {
      throw new CommandError('usage', `unknown flag “--${name}”`)
    }

    const value = inline ?? args[++index]
    if (value === undefined) throw new CommandError('usage', `--${name} needs a value`)

    const held = flags.values.get(name)
    if (!held) {
      flags.values.set(name, [value])
    } else if (single.has(name)) {
      throw new CommandError('usage', `--${name} can only be given once`)
    } else {
      held.push(value)
    }
  }

  return flags
}

const listOf = (flags: Flags, name: string): string[] => flags.values.get(name) ?? []
const oneOf = (flags: Flags, name: string): string | undefined => flags.values.get(name)?.[0]

function positiveInt(flags: Flags, name: string, fallback: number): number {
  const raw = oneOf(flags, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new CommandError('usage', `--${name} needs a whole number above zero, not “${raw}”`)
  }
  return value
}

/**
 * Validated but not normalized: `search` compares iso strings lexically, and a
 * bare `2026-01-31` is meant to cover that whole day, which only works while it
 * stays short.
 */
function isoDate(flags: Flags, name: string): string | undefined {
  const raw = oneOf(flags, name)
  if (raw === undefined) return undefined
  if (Number.isNaN(Date.parse(raw))) {
    throw new CommandError('usage', `--${name} needs an ISO date like 2026-01-31, not “${raw}”`)
  }
  return raw
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

const KINDS = new Set<string>(KIND_ORDER)

function asKind(value: string): Kind {
  if (!KINDS.has(value)) {
    throw new CommandError('usage', `unknown kind “${value}” — use one of ${KIND_ORDER.join(', ')}`)
  }
  return value as Kind
}

function requireEmpty(flags: Flags, usage: string): void {
  if (flags.positional.length) throw new CommandError('usage', usage)
}

// --- shared library access --------------------------------------------------

async function readMeta(sha256: string): Promise<BlobMeta | undefined> {
  try {
    return JSON.parse(await fs.readFile(blobMetaPath(sha256), 'utf8')) as BlobMeta
  } catch {
    return undefined // not derived yet, or half-written — an item without meta is still an item
  }
}

/**
 * One item from an id, a sha256, or an unambiguous prefix of either.
 *
 * A sha256 can name several items — the same picture saved from two articles is
 * one blob and two items — and those items differ in note, tags and boards, so
 * that is ambiguous like any other prefix rather than a silent pick of the
 * newest.
 */
async function resolveItem(query: string): Promise<Item> {
  const wanted = query.trim().toLowerCase()
  if (wanted.length < MIN_PREFIX) {
    throw new CommandError('usage', `“${query}” is too short — give at least ${MIN_PREFIX} characters of an id`)
  }

  const items = await loadItems()
  const exact = items.find(item => item.id.toLowerCase() === wanted)
  if (exact) return exact

  const matches = items.filter(
    item => item.id.toLowerCase().startsWith(wanted) || Boolean(item.sha256?.toLowerCase().startsWith(wanted)),
  )
  if (matches.length === 0) throw new CommandError('not_found', `Nothing in the library matches “${query}”.`)
  if (matches.length === 1) return matches[0]!

  const named = matches.slice(0, 5).map(item => item.id)
  const rest = matches.length > named.length ? `, and ${matches.length - named.length} more` : ''
  throw new CommandError(
    'usage',
    `“${query}” matches ${matches.length} items: ${named.join(', ')}${rest}. Use more of the id.`,
  )
}

/**
 * Append a new record for an item that already exists. The log is history, so
 * an edit is another line with a fresher `ts`, never a rewrite of the old one.
 */
const reviseItem = (item: Item, changes: Partial<Item>): Promise<Item> =>
  putItem({...item, ...changes, ts: isoNow()})

async function itemPayload(item: Item): Promise<{item: Item; meta?: BlobMeta; path?: string}> {
  if (!item.sha256) return {item}
  const [meta, original] = await Promise.all([readMeta(item.sha256), findOriginal(item.sha256)])
  return {item, meta, path: original}
}

// --- capture ----------------------------------------------------------------

export async function cmdCapture(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {
      boolean: ['all', 'best', 'dry-run'],
      single: ['board', 'note', 'timeout'],
      repeatable: ['kind', 'tag'],
    })

    const [url, ...extra] = flags.positional
    if (!url) throw new CommandError('usage', 'pluck capture <url> — a url is required')
    if (extra.length) throw new CommandError('usage', 'capture takes a single url')
    try {
      new URL(url)
    } catch {
      throw new CommandError(
        'usage',
        `“${url}” isn’t a link — paste a full url, like https://example.com/cat.jpg`,
      )
    }

    const all = flags.bools.has('all')
    const best = flags.bools.has('best')
    if (all && best) throw new CommandError('usage', '--all and --best ask for different things — pick one')

    const kinds = listOf(flags, 'kind').map(asKind)
    const timeout = positiveInt(flags, 'timeout', DEFAULT_TIMEOUT)
    const board = oneOf(flags, 'board')
    if (board !== undefined && !boardKey(board)) {
      throw new CommandError('usage', `“${board}” has no letters or numbers to make a board out of`)
    }
    const tags = listOf(flags, 'tag')
      .map(tag => tag.trim())
      .filter(Boolean)
    const note = oneOf(flags, 'note')

    const probed = await probeCandidates(url, timeout)
    const candidates = kinds.length ? probed.filter(candidate => kinds.includes(candidate.kind)) : probed
    if (!candidates.length) {
      const found = [...new Set(probed.map(candidate => candidate.kind))].join(', ')
      throw new CommandError(
        'no_candidates',
        found
          ? `Nothing of kind ${kinds.join(', ')} on that page — it offers ${found}.`
          : 'Nothing pluckable on that page.',
      )
    }

    if (flags.bools.has('dry-run')) {
      return {dryRun: true, url, candidates: candidates.map(candidatePayload)}
    }

    return captureAll(selectCandidates(candidates, {all, best}), {
      url,
      boards: board ? [board] : undefined,
      tags,
      note,
    })
  })
}

/**
 * Which candidates a capture takes.
 *
 * Exported because this is the whole judgement of `capture` and it must be
 * testable without a network: everything above it is flag parsing, everything
 * below it is bytes.
 */
export function selectCandidates(
  candidates: readonly Candidate[],
  opts: {all?: boolean; best?: boolean},
): Candidate[] {
  if (!candidates.length) throw new CommandError('no_candidates', 'Nothing pluckable on that page.')
  if (opts.all) return [...candidates]

  if (opts.best) {
    const winners = new Map<Kind, Candidate>()
    for (const candidate of candidates) {
      const held = winners.get(candidate.kind)
      if (!held || (candidate.score ?? 0) > (held.score ?? 0)) winners.set(candidate.kind, candidate)
    }
    return [...winners.values()]
  }

  if (candidates.length === 1) return [candidates[0]!]

  const offered = candidates.map(candidate => `${candidate.kind} “${truncate(candidate.label, 40)}”`).join(', ')
  throw new CommandError(
    'usage',
    `That link offers ${candidates.length} things to pluck — ${offered}. ` +
      'Narrow it with --kind, or take --best or --all.',
  )
}

type CaptureRecord = {id: string; sha256: string; kind: Kind; path: string; deduped: boolean}

async function captureAll(
  chosen: readonly Candidate[],
  about: {url: string; boards?: string[]; tags: string[]; note?: string},
): Promise<{captured: CaptureRecord[]; skipped: Array<{label: string; reason: string}>}> {
  const captured: CaptureRecord[] = []
  const skipped: Array<{label: string; reason: string}> = []

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-capture-'))
  try {
    for (const candidate of chosen) {
      try {
        const fetched = await candidate.fetch({outDir})
        const stored = await ingest({
          path: fetched.path,
          kind: candidate.kind,
          mime: fetched.mime ?? candidate.hint?.mime,
          source: {
            url: about.url,
            site: hostOf(about.url),
            title: candidate.hint?.title,
            extractor: candidate.extractor,
          },
          boards: about.boards,
          tags: about.tags,
          note: about.note,
        })

        // awaited, unlike the interactive path: this process exits as soon as
        // the envelope is printed, so a floating derive would simply be killed
        await deriveBlob(stored.sha256)
        await fs.rm(fetched.path, {force: true})

        captured.push({
          id: stored.item.id,
          sha256: stored.sha256,
          kind: candidate.kind,
          path: stored.blobPath,
          deduped: stored.deduped,
        })
      } catch (error) {
        // one dead url must not cost the caller the candidates that did work
        skipped.push({label: candidate.label, reason: messageOf(error)})
      }
    }
  } finally {
    await fs.rm(outDir, {recursive: true, force: true})
  }

  return {captured, skipped}
}

/** The probe budget only. A download is bounded by its own size cap, not by the clock. */
async function probeCandidates(url: string, timeout: number): Promise<Candidate[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  let latest: Candidate[] = []
  let finished = false
  try {
    for await (const event of probeUrl(url, {signal: controller.signal})) {
      if (event.type === 'candidates') latest = event.candidates
      else if (event.type === 'done') {
        latest = event.candidates
        finished = true
      }
    }
  } catch (error) {
    throw new CommandError('fetch_failed', messageOf(error))
  } finally {
    clearTimeout(timer)
  }

  // an aborted probe never reaches its `done` event, so what arrived first is
  // all there is — and if nothing did, the clock is the answer, not the page
  if (!finished && controller.signal.aborted && !latest.length) {
    throw new CommandError('cancelled', `That link took longer than ${timeout}ms to look at.`)
  }
  return latest
}

const candidatePayload = (candidate: Candidate) => ({
  key: candidate.key,
  kind: candidate.kind,
  label: candidate.label,
  extractor: candidate.extractor,
  score: candidate.score ?? 0,
  hint: candidate.hint,
})

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

// --- find -------------------------------------------------------------------

export async function cmdFind(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {
      repeatable: ['board', 'tag', 'kind'],
      single: ['since', 'until', 'limit', 'color'],
    })

    const color = oneOf(flags, 'color')?.trim()
    if (color !== undefined && !HEX.test(color)) {
      // search() treats an unreadable hex as maximally distant and ranks on
      // regardless, which would quietly hand back a result set nobody asked for
      throw new CommandError('usage', `--color needs a hex like #ff6b35, not “${color}”`)
    }

    const kinds = listOf(flags, 'kind').map(asKind)
    // items store board *keys*, so a filter typed as “Hero Refs” has to be
    // slugified the same way ingest slugified it
    const boards = listOf(flags, 'board').map(boardKey).filter(Boolean)
    const tags = listOf(flags, 'tag')
      .map(tag => tag.trim())
      .filter(Boolean)

    const filters: Filters = {
      text: flags.positional.join(' ').trim() || undefined,
      boards: boards.length ? boards : undefined,
      tags: tags.length ? tags : undefined,
      kinds: kinds.length ? kinds : undefined,
      since: isoDate(flags, 'since'),
      until: isoDate(flags, 'until'),
      color,
      limit: positiveInt(flags, 'limit', DEFAULT_LIMIT),
    }

    return {hits: (await search(filters)).map(hitPayload)}
  })
}

const hitPayload = (hit: Hit) => ({
  id: hit.item.id,
  kind: hit.meta?.kind,
  title: hit.item.source.title,
  source: hit.item.source.url,
  note: hit.item.note,
  tags: hit.item.tags,
  boards: hit.item.boards,
  // hexes only — `show` carries the weights, and a result list wants the colors
  palette: hit.meta?.palette?.map(entry => entry.hex),
  path: hit.path,
  score: Math.round(hit.score * 1000) / 1000,
})

// --- show -------------------------------------------------------------------

export async function cmdShow(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {})
    const [id, ...extra] = flags.positional
    if (!id) throw new CommandError('usage', 'pluck show <id|sha256> — an id is required')
    if (extra.length) throw new CommandError('usage', 'show takes a single id')
    return itemPayload(await resolveItem(id))
  })
}

// --- boards -----------------------------------------------------------------

export async function cmdBoards(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {single: ['note']})
    const [verb, ...rest] = flags.positional

    if (verb === 'new') {
      const name = rest.join(' ').trim()
      if (!name) throw new CommandError('usage', 'pluck boards new <name> — a name is required')
      const key = boardKey(name)
      if (!key) throw new CommandError('usage', `“${name}” has no letters or numbers to make a board out of`)

      const created = !(key in (await loadBoards()))
      const board = await ensureBoard(name, oneOf(flags, 'note'))
      return {board: {key, ...board}, created}
    }

    if (verb !== undefined) {
      throw new CommandError(
        'usage',
        `unknown boards subcommand “${verb}” — try “boards” or “boards new <name>”`,
      )
    }

    const [boards, items] = await Promise.all([loadBoards(), loadItems()])
    const counts = new Map<string, number>()
    for (const item of items) {
      for (const key of item.boards) counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const listed = Object.entries(boards)
      .map(([key, board]) => ({key, ...board, count: counts.get(key) ?? 0}))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return {boards: listed}
  })
}

// --- tag · mv · note · rm ---------------------------------------------------

export async function cmdTag(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {boolean: ['rm']})
    const [id, ...words] = flags.positional
    if (!id) throw new CommandError('usage', 'pluck tag <id> <tag>… — an id and at least one tag')

    const tags = words.map(tag => tag.trim()).filter(Boolean)
    if (!tags.length) throw new CommandError('usage', 'pluck tag <id> <tag>… — at least one tag')

    const item = await resolveItem(id)
    const has = (list: string[], tag: string) => list.some(held => held.toLowerCase() === tag.toLowerCase())

    let next: string[]
    if (flags.bools.has('rm')) {
      next = item.tags.filter(held => !has(tags, held))
    } else {
      next = [...item.tags]
      for (const tag of tags) if (!has(next, tag)) next.push(tag)
    }

    return itemPayload(await reviseItem(item, {tags: next}))
  })
}

export async function cmdMv(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {single: ['board']})
    const [id, ...extra] = flags.positional
    if (!id) throw new CommandError('usage', 'pluck mv <id> --board <board> — an id is required')
    if (extra.length) throw new CommandError('usage', 'mv takes one id; name the board with --board')

    const name = oneOf(flags, 'board')
    if (!name) throw new CommandError('usage', 'pluck mv <id> --board <board> — --board is required')
    const key = boardKey(name)
    if (!key) throw new CommandError('usage', `“${name}” has no letters or numbers to make a board out of`)

    const item = await resolveItem(id)
    await ensureBoard(name)
    // mv moves: the item lands on that board and leaves the ones it was on
    return itemPayload(await reviseItem(item, {boards: [key]}))
  })
}

export async function cmdNote(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {})
    const [id, ...words] = flags.positional
    if (!id) throw new CommandError('usage', 'pluck note <id> <text>… — an id is required')

    const note = words.join(' ').trim()
    if (!note) throw new CommandError('usage', 'pluck note <id> <text>… — the note text is required')

    return itemPayload(await reviseItem(await resolveItem(id), {note}))
  })
}

export async function cmdRm(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    const flags = parseFlags(args, {})
    if (!flags.positional.length) throw new CommandError('usage', 'pluck rm <id>… — at least one id')

    // every id resolves before anything is tombstoned, so a typo in the third
    // argument doesn't leave the first two deleted
    const items: Item[] = []
    for (const query of flags.positional) {
      const item = await resolveItem(query)
      if (!items.some(held => held.id === item.id)) items.push(item)
    }

    const ts = isoNow()
    for (const item of items) await deleteItem(item.id, ts)
    return {removed: items.map(item => item.id)}
  })
}

export async function cmdCompact(args: string[]): Promise<Envelope<unknown>> {
  return guard(async () => {
    requireEmpty(parseFlags(args, {}), 'compact takes no arguments')
    return compact()
  })
}

// --- dispatch ---------------------------------------------------------------

// a Map, not an object: `commandFor('toString')` must be undefined, not
// Object.prototype's
const REGISTRY = new Map<string, Runner>([
  ['capture', cmdCapture],
  ['find', cmdFind],
  ['show', cmdShow],
  ['boards', cmdBoards],
  ['tag', cmdTag],
  ['mv', cmdMv],
  ['note', cmdNote],
  ['rm', cmdRm],
  ['compact', cmdCompact],
])

export const HEADLESS_COMMANDS: readonly string[] = [...REGISTRY.keys()]

/** Dispatch by name. Undefined for anything else, so the caller can fall through. */
export function commandFor(name: string): Runner | undefined {
  return REGISTRY.get(name)
}

// --- human rendering --------------------------------------------------------

/**
 * Ten characters of a ULID, and deliberately no ellipsis: `show` takes
 * prefixes, so what's printed here has to survive being pasted back.
 */
const ID_WIDTH = 10

type HitRow = {
  id: string
  kind?: string
  title?: string
  source?: string
  tags?: string[]
  boards?: string[]
}

type BoardRow = {key: string; name: string; note?: string; count: number}

export function renderHuman(name: string, envelope: Envelope<unknown>): string {
  if (!envelope.ok) return `${envelope.error.message} (${envelope.error.code})`
  const data = (envelope.data ?? {}) as Record<string, unknown>

  switch (name) {
    case 'find':
      return renderHits((data.hits ?? []) as HitRow[])
    case 'boards':
      return data.board ? renderBoardCreated(data) : renderBoards((data.boards ?? []) as BoardRow[])
    case 'capture':
      return renderCapture(data)
    case 'show':
    case 'tag':
    case 'mv':
    case 'note':
      return renderItem(data)
    case 'rm': {
      const removed = (data.removed ?? []) as string[]
      return removed.length ? `removed ${plural(removed.length, 'item')}\n${removed.join('\n')}` : 'removed nothing'
    }
    case 'compact': {
      const {before = 0, after = 0} = data as {before?: number; after?: number}
      return before === after ? `nothing to compact (${plural(before, 'record')})` : `${before} records → ${after}`
    }
    default:
      return render(envelope)
  }
}

function renderHits(hits: HitRow[]): string {
  if (!hits.length) return 'no matches'
  const rows = [
    ['id', 'kind', 'title', 'tags', 'board'],
    ...hits.map(hit => [
      hit.id.slice(0, ID_WIDTH),
      hit.kind ?? '',
      truncate(hit.title || hit.source || '', 46),
      truncate((hit.tags ?? []).join(', '), 20),
      truncate((hit.boards ?? []).join(', '), 16),
    ]),
  ]
  return `${table(rows)}\n${plural(hits.length, 'item')}`
}

function renderBoards(boards: BoardRow[]): string {
  if (!boards.length) return 'no boards yet'
  const rows = [
    ['board', 'items', 'note'],
    ...boards.map(board => [board.name, String(board.count).padStart(5), truncate(board.note ?? '', 60)]),
  ]
  return table(rows)
}

function renderBoardCreated(data: Record<string, unknown>): string {
  const board = data.board as {key: string; name: string} | undefined
  if (!board) return 'no board'
  return `${data.created ? 'created' : 'already there'}: ${board.name} (${board.key})`
}

function renderCapture(data: Record<string, unknown>): string {
  if (data.dryRun) {
    const candidates = (data.candidates ?? []) as Array<{kind: string; label: string; extractor: string}>
    if (!candidates.length) return 'nothing pluckable'
    const rows = [
      ['kind', 'label', 'from'],
      ...candidates.map(candidate => [candidate.kind, truncate(candidate.label, 60), candidate.extractor]),
    ]
    return `${table(rows)}\n${plural(candidates.length, 'candidate')}, captured nothing`
  }

  const captured = (data.captured ?? []) as CaptureRecord[]
  const skipped = (data.skipped ?? []) as Array<{label: string; reason: string}>
  const lines = captured.map(record => `${record.kind}  ${record.path}${record.deduped ? '  (deduped)' : ''}`)
  for (const miss of skipped) lines.push(`skipped ${miss.label} — ${miss.reason}`)
  const summary = skipped.length
    ? `captured ${captured.length}, skipped ${skipped.length}`
    : `captured ${plural(captured.length, 'item')}`
  return [summary, ...lines].join('\n')
}

function renderItem(data: Record<string, unknown>): string {
  const item = data.item as Item | undefined
  if (!item) return 'no item'
  const meta = data.meta as BlobMeta | undefined

  const size = [
    meta?.width && meta.height ? `${meta.width}x${meta.height}` : '',
    meta ? formatBytes(meta.bytes) : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const rows: string[][] = [['id', item.id]]
  const add = (label: string, value: string | undefined) => {
    if (value) rows.push([label, value])
  }
  add('kind', meta?.kind)
  add('title', item.source.title)
  add('source', item.source.url)
  add('note', item.note)
  add('tags', item.tags.join(', '))
  add('boards', item.boards.join(', '))
  add('size', size)
  add('palette', meta?.palette?.map(entry => entry.hex).join(' '))
  add('path', data.path as string | undefined)
  return table(rows)
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Left-aligned columns, two spaces apart. The last column is never padded. */
function table(rows: string[][]): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)))
  }
  return rows
    .map(row => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!))).join('  '))
    .join('\n')
}
