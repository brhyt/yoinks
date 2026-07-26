import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {putItem} from './log.js'
import {blobDir, blobMetaPath} from './paths.js'
import {colorDistance, scoreItem, search} from './query.js'
import type {BlobMeta, Item} from './types.js'

/** Sortable stand-ins for ulids: 26 chars, lexicographic order is capture order. */
const id = (marker: string) => `01${marker.repeat(24)}`
const OLD = id('A')
const MID = id('B')
const NEW = id('C')

const SHA = 'a'.repeat(64)

function makeItem(over: Partial<Item> & {id: string}): Item {
  const {source, ...rest} = over
  return {
    ts: '2026-03-15T12:00:00.000Z',
    sha256: SHA,
    boards: [],
    tags: [],
    ...rest,
    source: {url: 'https://example.com/a', captured_at: '2026-03-15T12:00:00.000Z', ...source},
  }
}

function makeMeta(over: Partial<BlobMeta> = {}): BlobMeta {
  return {sha256: SHA, kind: 'image', bytes: 1, ...over}
}

// --- hard filters -----------------------------------------------------------

test('boards and tags include on any match and exclude on none', () => {
  const item = makeItem({id: OLD, boards: ['hero-refs'], tags: ['dark', 'editorial']})

  assert.notEqual(scoreItem(item, undefined, {boards: ['hero-refs']}), undefined)
  assert.notEqual(scoreItem(item, undefined, {boards: ['nope', 'hero-refs']}), undefined)
  assert.equal(scoreItem(item, undefined, {boards: ['nope']}), undefined)

  assert.notEqual(scoreItem(item, undefined, {tags: ['dark']}), undefined)
  assert.notEqual(scoreItem(item, undefined, {tags: ['orange', 'editorial']}), undefined)
  assert.equal(scoreItem(item, undefined, {tags: ['orange']}), undefined)

  // case and stray whitespace shouldn't decide whether you find your own work
  assert.notEqual(scoreItem(item, undefined, {tags: [' DARK ']}), undefined)
})

test('values within a filter are OR, filters are AND', () => {
  const item = makeItem({id: OLD, boards: ['hero-refs'], tags: ['dark']})

  assert.notEqual(scoreItem(item, undefined, {tags: ['dark', 'orange'], boards: ['hero-refs']}), undefined)
  // the tag matches, the board does not — AND across filters kills it
  assert.equal(scoreItem(item, undefined, {tags: ['dark', 'orange'], boards: ['other']}), undefined)
})

test('kind filters on the blob meta, and an item with no meta cannot claim one', () => {
  const item = makeItem({id: OLD})

  assert.notEqual(scoreItem(item, makeMeta({kind: 'image'}), {kinds: ['image']}), undefined)
  assert.notEqual(scoreItem(item, makeMeta({kind: 'video'}), {kinds: ['image', 'video']}), undefined)
  assert.equal(scoreItem(item, makeMeta({kind: 'video'}), {kinds: ['image']}), undefined)
  assert.equal(scoreItem(item, undefined, {kinds: ['image']}), undefined)
})

test('since and until are inclusive of the day they name', () => {
  const item = makeItem({id: OLD, source: {url: 'u', captured_at: '2026-03-15T12:00:00.000Z'}})

  assert.notEqual(scoreItem(item, undefined, {since: '2026-03-15'}), undefined)
  assert.notEqual(scoreItem(item, undefined, {since: '2026-03-15T12:00:00.000Z'}), undefined)
  assert.equal(scoreItem(item, undefined, {since: '2026-03-16'}), undefined)

  // the whole of the 15th, not midnight on the 15th
  assert.notEqual(scoreItem(item, undefined, {until: '2026-03-15'}), undefined)
  assert.equal(scoreItem(item, undefined, {until: '2026-03-14'}), undefined)

  assert.notEqual(scoreItem(item, undefined, {since: '2026-03-01', until: '2026-03-31'}), undefined)
  assert.equal(scoreItem(item, undefined, {since: '2026-03-01', until: '2026-03-10'}), undefined)
})

// --- text -------------------------------------------------------------------

test('text matches case-insensitive substrings across every field', () => {
  const fields = [
    makeItem({id: OLD, note: 'the ORANGE overlay'}),
    makeItem({id: OLD, source: {url: 'u', captured_at: '2026-03-15T12:00:00.000Z', title: 'Orange county'}}),
    makeItem({id: OLD, tags: ['orange']}),
    makeItem({id: OLD, boards: ['orange-refs']}),
    makeItem({id: OLD, source: {url: 'u', captured_at: '2026-03-15T12:00:00.000Z', site: 'orange.com'}}),
  ]
  for (const item of fields) assert.notEqual(scoreItem(item, undefined, {text: 'orange'}), undefined)

  assert.equal(scoreItem(makeItem({id: OLD, note: 'blue'}), undefined, {text: 'orange'}), undefined)
})

test('every word in a multi-word query has to land somewhere', () => {
  const both = makeItem({id: OLD, note: 'dark editorial layout'})
  const one = makeItem({id: MID, note: 'dark dashboard'})

  assert.notEqual(scoreItem(both, undefined, {text: 'dark editorial'}), undefined)
  assert.equal(scoreItem(one, undefined, {text: 'dark editorial'}), undefined)

  // the words may land in different fields, they just all have to land
  const split = makeItem({id: NEW, note: 'dark', tags: ['editorial']})
  assert.notEqual(scoreItem(split, undefined, {text: 'dark editorial'}), undefined)
})

test('a note match outranks a title match, which outranks a site match', () => {
  const stamp = '2026-03-15T12:00:00.000Z'
  const note = makeItem({id: OLD, note: 'orange'})
  const title = makeItem({id: MID, source: {url: 'u', captured_at: stamp, title: 'orange'}})
  const site = makeItem({id: NEW, source: {url: 'u', captured_at: stamp, site: 'orange.com'}})

  const scores = [note, title, site].map(item => scoreItem(item, undefined, {text: 'orange'}) ?? 0)
  assert.ok(scores[0] > scores[1], 'note should beat title')
  assert.ok(scores[1] > scores[2], 'title should beat site')
})

test('text score is normalized, so a longer query is not automatically a better one', () => {
  const item = makeItem({id: OLD, note: 'dark editorial layout'})
  assert.equal(scoreItem(item, undefined, {text: 'dark'}), 1)
  assert.equal(scoreItem(item, undefined, {text: 'dark editorial layout'}), 1)
})

// --- color ------------------------------------------------------------------

test('identical colors are zero apart and black to white is the maximum', () => {
  assert.equal(colorDistance('#ff0000', '#ff0000'), 0)
  assert.equal(colorDistance('#ff0000', 'FF0000'), 0)
  assert.equal(colorDistance('#000000', '#ffffff'), 1)
  assert.equal(colorDistance('#ffffff', '#000000'), 1)
  assert.ok(colorDistance('#ff6b35', '#ff6f3a') < 0.05)
})

test('shorthand, bare and mixed-case hex all parse the same', () => {
  assert.equal(colorDistance('#abc', '#aabbcc'), 0)
  assert.equal(colorDistance('abc', '#AABBCC'), 0)
  assert.equal(colorDistance('  #ABC  ', 'aabbcc'), 0)
})

test('unparseable hex is maximally distant rather than a throw', () => {
  assert.equal(colorDistance('nope', '#000000'), 1)
  assert.equal(colorDistance('#gg0000', '#000000'), 1)
  assert.equal(colorDistance('#abcd', '#000000'), 1)
})

test('color ranks by the nearest palette entry', () => {
  const item = makeItem({id: OLD})
  const near = makeMeta({palette: [{hex: '#0b0d10', weight: 0.6}, {hex: '#ff6b35', weight: 0.1}]})
  const far = makeMeta({palette: [{hex: '#0b0d10', weight: 0.9}]})

  const hot = scoreItem(item, near, {color: '#ff6b35'}) ?? 0
  const cold = scoreItem(item, far, {color: '#ff6b35'}) ?? 0
  assert.equal(hot, 1)
  assert.ok(hot > cold)
})

test('no palette scores zero for color but is never excluded by it', () => {
  const item = makeItem({id: OLD})
  assert.equal(scoreItem(item, undefined, {color: '#ff6b35'}), 0)
  assert.equal(scoreItem(item, makeMeta({palette: []}), {color: '#ff6b35'}), 0)
})

test('invalid color is ignored instead of throwing or excluding', () => {
  const item = makeItem({id: OLD, note: 'orange'})
  assert.equal(scoreItem(item, makeMeta({palette: [{hex: '#ff6b35', weight: 1}]}), {color: 'tangerine'}), 0)
  assert.equal(scoreItem(item, undefined, {text: 'orange', color: '#zzz'}), 1)
})

test('a hard filter still excludes even when text and color would have scored', () => {
  const item = makeItem({id: OLD, note: 'orange', tags: ['dark']})
  const meta = makeMeta({palette: [{hex: '#ff6b35', weight: 1}]})
  assert.equal(scoreItem(item, meta, {text: 'orange', color: '#ff6b35', tags: ['blue']}), undefined)
})

// --- search -----------------------------------------------------------------

async function withHome(run: () => Promise<void>): Promise<void> {
  const previous = process.env.PLUCK_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-query-'))
  process.env.PLUCK_HOME = home
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.PLUCK_HOME
    else process.env.PLUCK_HOME = previous
    await fs.rm(home, {recursive: true, force: true})
  }
}

async function writeBlob(meta: BlobMeta): Promise<void> {
  await fs.mkdir(blobDir(meta.sha256), {recursive: true})
  await fs.writeFile(path.join(blobDir(meta.sha256), 'original.png'), 'not really a png')
  await fs.writeFile(blobMetaPath(meta.sha256), JSON.stringify(meta))
}

test('search returns newest first by default and respects the limit', async () => {
  await withHome(async () => {
    for (const itemId of [MID, OLD, NEW]) await putItem(makeItem({id: itemId}))

    const all = await search({})
    assert.deepEqual(all.map(hit => hit.item.id), [NEW, MID, OLD])

    const page = await search({limit: 2})
    assert.deepEqual(page.map(hit => hit.item.id), [NEW, MID])
  })
})

test('search attaches meta and the original path', async () => {
  await withHome(async () => {
    await putItem(makeItem({id: OLD}))
    await writeBlob(makeMeta({kind: 'image', width: 24}))

    const [hit] = await search({})
    assert.equal(hit?.meta?.width, 24)
    assert.equal(hit?.path, path.join(blobDir(SHA), 'original.png'))
  })
})

test('a missing or corrupt meta.json leaves meta undefined instead of blowing up', async () => {
  await withHome(async () => {
    await putItem(makeItem({id: OLD}))
    await putItem(makeItem({id: NEW, sha256: 'b'.repeat(64)}))
    await fs.mkdir(blobDir('b'.repeat(64)), {recursive: true})
    await fs.writeFile(blobMetaPath('b'.repeat(64)), '{ this is not json')

    const hits = await search({})
    assert.deepEqual(hits.map(hit => hit.item.id), [NEW, OLD])
    assert.deepEqual(hits.map(hit => hit.meta), [undefined, undefined])
    assert.deepEqual(hits.map(hit => hit.path), [undefined, undefined])
  })
})

test('search applies hard filters and ranks the survivors', async () => {
  await withHome(async () => {
    await putItem(makeItem({id: OLD, tags: ['dark'], note: 'a dark hero'}))
    await putItem(makeItem({id: MID, tags: ['dark'], boards: ['hero-refs']}))
    await putItem(makeItem({id: NEW, tags: ['bright']}))

    const dark = await search({tags: ['dark']})
    assert.deepEqual(dark.map(hit => hit.item.id), [MID, OLD])

    // the note match on the older item beats the newer item with no match at all
    const hero = await search({text: 'hero'})
    assert.deepEqual(hero.map(hit => hit.item.id), [OLD, MID])
  })
})

test('kind filtering reads the blob meta each candidate points at', async () => {
  await withHome(async () => {
    const video = 'c'.repeat(64)
    await putItem(makeItem({id: OLD}))
    await putItem(makeItem({id: NEW, sha256: video}))
    await writeBlob(makeMeta({kind: 'image'}))
    await writeBlob(makeMeta({sha256: video, kind: 'video'}))

    const images = await search({kinds: ['image']})
    assert.deepEqual(images.map(hit => hit.item.id), [OLD])

    const both = await search({kinds: ['image', 'video']})
    assert.deepEqual(both.map(hit => hit.item.id), [NEW, OLD])
  })
})

test('color ranks by palette distance and puts palette-less items last', async () => {
  await withHome(async () => {
    const cold = 'd'.repeat(64)
    // the closest match is the oldest item, so recency alone would get this wrong
    await putItem(makeItem({id: OLD}))
    await putItem(makeItem({id: MID, sha256: cold}))
    await putItem(makeItem({id: NEW, sha256: 'e'.repeat(64)}))
    await writeBlob(makeMeta({palette: [{hex: '#ff6b35', weight: 0.2}]}))
    await writeBlob(makeMeta({sha256: cold, palette: [{hex: '#0b0d10', weight: 0.9}]}))

    const hits = await search({color: '#ff6b35'})
    assert.deepEqual(hits.map(hit => hit.item.id), [OLD, MID, NEW])
    assert.equal(hits[0]?.score, 1)
    assert.equal(hits.at(-1)?.score, 0, 'the palette-less item scores nothing for color')
  })
})
