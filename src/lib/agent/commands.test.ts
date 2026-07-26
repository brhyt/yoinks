import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {Candidate, Kind} from '../extract/types.js'
import {ingest, type IngestInput, type IngestResult} from '../store/ingest.js'
import {loadItems, readRecords} from '../store/log.js'
import type {BlobMeta, Item} from '../store/types.js'
import {
  cmdBoards,
  cmdCapture,
  cmdCompact,
  cmdFind,
  cmdMv,
  cmdNote,
  cmdRm,
  cmdShow,
  cmdTag,
  commandFor,
  HEADLESS_COMMANDS,
  renderHuman,
  selectCandidates,
} from './commands.js'
import {envelopeFor, exitCodeFor, type Envelope, type ErrorCode} from './json.js'

/**
 * Nothing in here goes near a network. `capture`'s picking rules are exercised
 * through `selectCandidates` with hand-made candidates, and the command itself
 * only through the flags it refuses before it would reach for a url.
 */

/** Every test runs against a throwaway $PLUCK_HOME — never a real ~/.pluck. */
async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = process.env.PLUCK_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-commands-'))
  process.env.PLUCK_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.PLUCK_HOME
    else process.env.PLUCK_HOME = previous
    await fs.rm(home, {recursive: true, force: true})
  }
}

let seq = 0

/** A capture that already happened, so the read commands have something to read. */
async function seed(home: string, over: Partial<IngestInput> & {body?: string} = {}): Promise<IngestResult> {
  const {body, ...rest} = over
  const name = `shot-${seq++}.png`
  const dir = path.join(home, 'incoming')
  await fs.mkdir(dir, {recursive: true})
  const file = path.join(dir, name)
  await fs.writeFile(file, body ?? `pixels ${name}`)

  return ingest({
    path: file,
    kind: 'image',
    mime: 'image/png',
    source: {url: 'https://example.com/shot.png', site: 'example.com', title: 'a dark hero'},
    ...rest,
  })
}

function dataOf<T>(envelope: Envelope<unknown>): T {
  if (!envelope.ok) assert.fail(`expected data, got ${envelope.error.code}: ${envelope.error.message}`)
  return envelope.data as T
}

function errorOf(envelope: Envelope<unknown>): {code: ErrorCode; message: string} {
  if (envelope.ok) assert.fail(`expected a failure, got ${JSON.stringify(envelope.data)}`)
  return envelope.error
}

/** The envelope a throw from a non-command helper would have become. */
function thrown(run: () => unknown): {code: ErrorCode; message: string} {
  try {
    run()
  } catch (error) {
    return errorOf(envelopeFor(error))
  }
  return assert.fail('expected that to throw')
}

type Hits = {
  hits: Array<{id: string; kind?: Kind; title?: string; note?: string; tags: string[]; boards: string[]; path?: string}>
}
type Shown = {item: Item; meta?: BlobMeta; path?: string}
type Boards = {boards: Array<{key: string; name: string; note?: string; count: number}>}
type MadeBoard = {board: {key: string; name: string; note?: string}; created: boolean}

// --- find -------------------------------------------------------------------

test('find with nothing to go on returns the library, newest first', async () => {
  await withHome(async home => {
    const first = await seed(home)
    const second = await seed(home)

    const ids = dataOf<Hits>(await cmdFind([])).hits.map(hit => hit.id)
    assert.deepEqual([...ids].sort(), [first.item.id, second.item.id].sort())
    // ulids sort by creation time, so descending id order is newest first
    assert.deepEqual(ids, [...ids].sort().reverse())
  })
})

test('free text narrows to what actually says it', async () => {
  await withHome(async home => {
    const dark = await seed(home, {source: {url: 'https://a.example/1.png', title: 'dark editorial hero'}})
    await seed(home, {source: {url: 'https://b.example/2.png', title: 'bright landing page'}})

    assert.deepEqual(
      dataOf<Hits>(await cmdFind(['dark', 'editorial'])).hits.map(hit => hit.id),
      [dark.item.id],
    )
    assert.deepEqual(dataOf<Hits>(await cmdFind(['brutalist'])).hits, [])
  })
})

test('filters cut on tag, board, kind and date, and --limit caps the page', async () => {
  await withHome(async home => {
    await seed(home, {tags: ['dark'], boards: ['Hero Refs']})
    await seed(home, {tags: ['bright']})
    await seed(home, {kind: 'video', mime: 'video/mp4'})

    const hits = async (args: string[]) => dataOf<Hits>(await cmdFind(args)).hits

    assert.equal((await hits(['--tag', 'dark'])).length, 1)
    // typed the way a person says it, matched the way ingest stored it
    assert.equal((await hits(['--board', 'Hero Refs'])).length, 1)
    assert.equal((await hits(['--kind', 'video'])).length, 1)
    assert.equal((await hits(['--kind', 'image', '--kind', 'video'])).length, 3)
    assert.equal((await hits(['--limit', '2'])).length, 2)
    assert.equal((await hits(['--since', '2020-01-01'])).length, 3)
    assert.equal((await hits(['--since', '2099-01-01'])).length, 0)
    assert.equal((await hits(['--until', '2020-01-01'])).length, 0)
  })
})

test('a hit carries what an agent needs to act on it', async () => {
  await withHome(async home => {
    const stored = await seed(home, {tags: ['dark'], boards: ['Hero Refs'], note: 'the rule'})

    const [hit] = dataOf<Hits>(await cmdFind([])).hits
    assert.equal(hit?.id, stored.item.id)
    assert.equal(hit?.kind, 'image')
    assert.equal(hit?.title, 'a dark hero')
    assert.equal(hit?.note, 'the rule')
    assert.deepEqual(hit?.tags, ['dark'])
    assert.deepEqual(hit?.boards, ['hero-refs'])
    assert.equal(hit?.path, stored.blobPath)
    assert.equal(path.isAbsolute(hit?.path ?? ''), true)
  })
})

test('find refuses the flags it cannot honestly answer', async () => {
  await withHome(async () => {
    assert.equal(errorOf(await cmdFind(['--color', 'orange'])).code, 'usage')
    assert.equal(errorOf(await cmdFind(['--limit', '0'])).code, 'usage')
    assert.equal(errorOf(await cmdFind(['--limit', '2.5'])).code, 'usage')
    assert.equal(errorOf(await cmdFind(['--since', 'last tuesday'])).code, 'usage')
    assert.equal(errorOf(await cmdFind(['--kind', 'gif'])).code, 'usage')
    assert.equal(errorOf(await cmdFind(['--tag'])).code, 'usage')
    assert.equal(errorOf(await cmdFind(['--nonsense'])).code, 'usage')

    // a hex that is one goes through
    assert.equal((await cmdFind(['--color', '#ff6b35'])).ok, true)
  })
})

// --- show -------------------------------------------------------------------

test('show takes a full id or an unambiguous prefix, and brings the blob with it', async () => {
  await withHome(async home => {
    const stored = await seed(home)

    const full = dataOf<Shown>(await cmdShow([stored.item.id]))
    assert.equal(full.item.id, stored.item.id)
    assert.equal(full.path, stored.blobPath)
    assert.equal(full.meta?.sha256, stored.sha256)
    assert.equal(full.meta?.kind, 'image')
    assert.equal(full.meta?.mime, 'image/png')

    assert.equal(dataOf<Shown>(await cmdShow([stored.item.id.slice(0, 16)])).item.id, stored.item.id)
    // the sha256 names the same asset from the other side
    assert.equal(dataOf<Shown>(await cmdShow([stored.sha256])).item.id, stored.item.id)
  })
})

test('an ambiguous prefix names its candidates instead of picking one', async () => {
  await withHome(async home => {
    // the same bytes twice is one blob and two items, so the sha256 is shared
    const first = await seed(home, {body: 'identical pixels'})
    const second = await seed(home, {body: 'identical pixels'})
    assert.equal(first.sha256, second.sha256)

    const failure = errorOf(await cmdShow([first.sha256.slice(0, 12)]))
    assert.equal(failure.code, 'usage')
    assert.ok(failure.message.includes(first.item.id), failure.message)
    assert.ok(failure.message.includes(second.item.id), failure.message)
  })
})

test('a too-short prefix is refused and a stranger is not found', async () => {
  await withHome(async home => {
    await seed(home)
    assert.equal(errorOf(await cmdShow(['01K'])).code, 'usage')
    assert.equal(errorOf(await cmdShow([])).code, 'usage')
    assert.equal(errorOf(await cmdShow(['0000000000000000'])).code, 'not_found')
  })
})

// --- tag, mv, note ----------------------------------------------------------

test('tag adds without duplicating, and --rm takes back', async () => {
  await withHome(async home => {
    const stored = await seed(home, {tags: ['dark']})

    const added = dataOf<Shown>(await cmdTag([stored.item.id, 'editorial', 'DARK']))
    assert.deepEqual(added.item.tags, ['dark', 'editorial'])

    const removed = dataOf<Shown>(await cmdTag([stored.item.id, '--rm', 'dark']))
    assert.deepEqual(removed.item.tags, ['editorial'])

    assert.deepEqual(dataOf<Shown>(await cmdShow([stored.item.id])).item.tags, ['editorial'])
    assert.equal(errorOf(await cmdTag([stored.item.id])).code, 'usage')
    assert.equal(errorOf(await cmdTag([])).code, 'usage')
  })
})

test('an edit appends a record and leaves the old one alone', async () => {
  await withHome(async home => {
    const stored = await seed(home)
    const updated = dataOf<Shown>(await cmdTag([stored.item.id, 'dark'])).item

    const records = await readRecords()
    assert.equal(records.length, 2)
    const [original] = records
    assert.equal(original?.op, 'put')
    assert.deepEqual(original?.op === 'put' ? original.tags : undefined, [])

    assert.equal(updated.id, stored.item.id)
    assert.ok(updated.ts >= stored.item.ts)
    assert.deepEqual((await loadItems()).map(item => item.id), [stored.item.id])
  })
})

test('mv moves onto a board, creating it on the way', async () => {
  await withHome(async home => {
    const stored = await seed(home, {boards: ['Old Refs']})

    const moved = dataOf<Shown>(await cmdMv([stored.item.id, '--board', 'Hero Refs']))
    assert.deepEqual(moved.item.boards, ['hero-refs'])

    const listed = dataOf<Boards>(await cmdBoards([])).boards
    assert.deepEqual(
      listed.map(board => [board.key, board.count]),
      [
        ['hero-refs', 1],
        ['old-refs', 0],
      ],
    )
    assert.equal(errorOf(await cmdMv([stored.item.id])).code, 'usage')
    assert.equal(errorOf(await cmdMv([stored.item.id, '--board', '!!!'])).code, 'usage')
  })
})

test('note replaces whatever was there', async () => {
  await withHome(async home => {
    const stored = await seed(home, {note: 'the first thought'})

    const noted = dataOf<Shown>(await cmdNote([stored.item.id, 'the', 'second', 'thought']))
    assert.equal(noted.item.note, 'the second thought')
    assert.equal(dataOf<Shown>(await cmdShow([stored.item.id])).item.note, 'the second thought')
    assert.equal(errorOf(await cmdNote([stored.item.id])).code, 'usage')
  })
})

// --- rm and compact ---------------------------------------------------------

test('rm tombstones, so find forgets the item and the bytes stay', async () => {
  await withHome(async home => {
    const gone = await seed(home)
    const kept = await seed(home)

    assert.deepEqual(dataOf<{removed: string[]}>(await cmdRm([gone.item.id])).removed, [gone.item.id])
    assert.deepEqual(dataOf<Hits>(await cmdFind([])).hits.map(hit => hit.id), [kept.item.id])
    assert.equal(errorOf(await cmdShow([gone.item.id])).code, 'not_found')

    // a tombstone hides an item; only compaction reclaims anything
    await fs.access(gone.blobPath)
  })
})

test('rm resolves every id before it deletes any', async () => {
  await withHome(async home => {
    const stored = await seed(home)
    assert.equal(errorOf(await cmdRm([stored.item.id, '0000000000000000'])).code, 'not_found')
    assert.equal((await loadItems()).length, 1)
    assert.equal(errorOf(await cmdRm([])).code, 'usage')
  })
})

test('compact reports the records before and after', async () => {
  await withHome(async home => {
    const stored = await seed(home)
    await cmdTag([stored.item.id, 'dark'])
    await cmdTag([stored.item.id, 'editorial'])

    assert.deepEqual(dataOf<{before: number; after: number}>(await cmdCompact([])), {before: 3, after: 1})
    assert.deepEqual((await loadItems()).map(item => item.tags), [['dark', 'editorial']])

    assert.deepEqual(dataOf<{before: number; after: number}>(await cmdCompact([])), {before: 1, after: 1})
    assert.equal(errorOf(await cmdCompact(['now'])).code, 'usage')
  })
})

// --- boards -----------------------------------------------------------------

test('boards lists what exists with its item counts', async () => {
  await withHome(async home => {
    await seed(home, {boards: ['Hero Refs']})
    await seed(home, {boards: ['Hero Refs']})
    await cmdBoards(['new', 'Type Scale', '--note', 'for later'])

    const listed = dataOf<Boards>(await cmdBoards([])).boards
    assert.deepEqual(
      listed.map(board => [board.key, board.name, board.count]),
      [
        ['hero-refs', 'Hero Refs', 2],
        ['type-scale', 'Type Scale', 0],
      ],
    )
    assert.equal(listed[1]?.note, 'for later')
  })
})

test('boards new says whether it made one, and refuses a name that is not one', async () => {
  await withHome(async () => {
    const made = dataOf<MadeBoard>(await cmdBoards(['new', 'Hero Refs']))
    assert.equal(made.created, true)
    assert.equal(made.board.key, 'hero-refs')

    const again = dataOf<MadeBoard>(await cmdBoards(['new', 'hero refs']))
    assert.equal(again.created, false)
    assert.equal(again.board.name, 'Hero Refs') // the first spelling keeps the board

    assert.equal(errorOf(await cmdBoards(['new'])).code, 'usage')
    assert.equal(errorOf(await cmdBoards(['new', '!!!'])).code, 'usage')
    assert.equal(errorOf(await cmdBoards(['list'])).code, 'usage')
  })
})

// --- capture ----------------------------------------------------------------

test('capture refuses bad flags before it would touch a network', async () => {
  await withHome(async () => {
    const url = 'https://example.com/shot.png'
    assert.equal(errorOf(await cmdCapture([])).code, 'usage')
    assert.equal(errorOf(await cmdCapture(['not-a-url'])).code, 'usage')
    assert.equal(errorOf(await cmdCapture([url, 'https://example.com/other.png'])).code, 'usage')
    assert.equal(errorOf(await cmdCapture([url, '--all', '--best'])).code, 'usage')
    assert.equal(errorOf(await cmdCapture([url, '--kind', 'gif'])).code, 'usage')
    assert.equal(errorOf(await cmdCapture([url, '--timeout', 'soon'])).code, 'usage')
    assert.equal(errorOf(await cmdCapture([url, '--board', '!!!'])).code, 'usage')
    assert.equal(errorOf(await cmdCapture([url, '--tag'])).code, 'usage')
    assert.equal(errorOf(await cmdCapture([url, '--dry-run=yes'])).code, 'usage')

    // every one of those refused before probing, so the library is untouched
    assert.deepEqual(await loadItems(), [])
  })
})

const candidateOf = (over: Partial<Candidate> & {key: string; kind: Kind}): Candidate => ({
  label: over.key,
  extractor: 'direct',
  fetch: async () => ({path: '/nowhere'}),
  ...over,
})

test('one candidate needs no flag; several are the caller’s to resolve', () => {
  const only = candidateOf({key: 'only', kind: 'image'})
  assert.deepEqual(selectCandidates([only], {}), [only])

  const small = candidateOf({key: 'small', kind: 'image', score: 1})
  const big = candidateOf({key: 'big', kind: 'image', score: 9})
  const clip = candidateOf({key: 'clip', kind: 'video', score: 5})

  const failure = thrown(() => selectCandidates([small, big, clip], {}))
  assert.equal(failure.code, 'usage')
  assert.match(failure.message, /--best/)
  assert.match(failure.message, /--all/)

  assert.deepEqual(selectCandidates([small, big, clip], {all: true}), [small, big, clip])
  // --best is per kind, not overall
  assert.deepEqual(selectCandidates([small, big, clip], {best: true}), [big, clip])
  assert.equal(thrown(() => selectCandidates([], {all: true})).code, 'no_candidates')
})

// --- dispatch and exit codes ------------------------------------------------

test('every headless command dispatches, and nothing else does', () => {
  assert.deepEqual(
    [...HEADLESS_COMMANDS].sort(),
    ['boards', 'capture', 'compact', 'find', 'mv', 'note', 'rm', 'show', 'tag'],
  )
  assert.equal(commandFor('find'), cmdFind)
  assert.equal(commandFor('lib'), undefined)
  // a Map, so an inherited property cannot pass for a command
  assert.equal(commandFor('toString'), undefined)
  assert.equal(commandFor('constructor'), undefined)
})

test('a bad flag is an envelope for every command, never a throw', async () => {
  await withHome(async () => {
    for (const name of HEADLESS_COMMANDS) {
      const envelope = await commandFor(name)!(['--nonsense'])
      assert.equal(envelope.ok, false, `${name} should have refused`)
      assert.equal(exitCodeFor(envelope), 2, `${name} should have exited 2`)
    }
  })
})

test('exit codes separate calling it wrong from it not working out', async () => {
  await withHome(async home => {
    await seed(home)
    assert.equal(exitCodeFor(await cmdFind([])), 0)
    assert.equal(exitCodeFor(await cmdShow(['01K'])), 2)
    assert.equal(exitCodeFor(await cmdShow(['0000000000000000'])), 1)
  })
})

// --- human rendering --------------------------------------------------------

test('the human rendering is plain text, and its ids paste back', async () => {
  await withHome(async home => {
    const stored = await seed(home, {tags: ['dark'], boards: ['Hero Refs']})

    const found = renderHuman('find', await cmdFind([]))
    assert.equal(/\u001b/.test(found), false, 'no escape sequences — this may be piped')
    assert.match(found, /dark/)
    assert.match(found, /1 item$/)

    const printed = found.split('\n')[1]!.split(' ')[0]!
    assert.equal(dataOf<Shown>(await cmdShow([printed])).item.id, stored.item.id)

    assert.match(renderHuman('boards', await cmdBoards([])), /Hero Refs/)
    assert.match(renderHuman('show', await cmdShow([stored.item.id])), /hero-refs/)
    assert.match(renderHuman('compact', await cmdCompact([])), /nothing to compact/)
  })
})

test('an empty library and a failure both render as a sentence', async () => {
  await withHome(async () => {
    assert.equal(renderHuman('find', await cmdFind([])), 'no matches')
    assert.equal(renderHuman('boards', await cmdBoards([])), 'no boards yet')

    const failure = renderHuman('show', await cmdShow(['0000000000000000']))
    assert.match(failure, /not_found/)
    assert.equal(/\u001b/.test(failure), false)
  })
})
