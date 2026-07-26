import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {boardKey, ensureBoard, ingest, loadBoards, type IngestInput} from './ingest.js'
import {loadItems} from './log.js'
import {blobDir, blobsDir, boardsPath, cacheDir, findOriginal} from './paths.js'

/**
 * Every test runs against a throwaway $PLUCK_HOME. Nothing here may look at,
 * let alone write to, the developer's real library.
 */
async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const before = process.env.PLUCK_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-ingest-'))
  process.env.PLUCK_HOME = home
  try {
    await run(home)
  } finally {
    if (before === undefined) delete process.env.PLUCK_HOME
    else process.env.PLUCK_HOME = before
    await fs.rm(home, {recursive: true, force: true})
  }
}

/** A file sitting where an extractor's fetch() would have left it. */
async function incoming(home: string, name: string, body: string): Promise<string> {
  const dir = path.join(home, 'incoming')
  await fs.mkdir(dir, {recursive: true})
  const file = path.join(dir, name)
  await fs.writeFile(file, body)
  return file
}

function capture(file: string, overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    path: file,
    kind: 'image',
    mime: 'image/png',
    source: {url: 'https://example.com/shot.png', site: 'example.com', extractor: 'direct'},
    ...overrides,
  }
}

/** Every stored original, which is exactly what findOriginal will ever match. */
async function originals(): Promise<string[]> {
  const found: string[] = []
  for (const shard of await fs.readdir(blobsDir())) {
    for (const sha of await fs.readdir(path.join(blobsDir(), shard))) {
      const dir = path.join(blobsDir(), shard, sha)
      for (const entry of await fs.readdir(dir)) {
        if (entry.startsWith('original')) found.push(path.join(dir, entry))
      }
    }
  }
  return found.sort()
}

test('a new file writes one blob and one item', async () => {
  await withHome(async home => {
    const result = await ingest(capture(await incoming(home, 'shot.png', 'pixels')))

    assert.equal(result.deduped, false)
    assert.deepEqual(await originals(), [path.join(blobDir(result.sha256), 'original.png')])
    assert.equal(result.blobPath, path.join(blobDir(result.sha256), 'original.png'))
    assert.equal(await fs.readFile(result.blobPath, 'utf8'), 'pixels')

    const items = await loadItems()
    assert.equal(items.length, 1)
    assert.equal(items[0]!.id, result.item.id)
    assert.equal(items[0]!.sha256, result.sha256)
    assert.equal(items[0]!.source.url, 'https://example.com/shot.png')
    assert.equal(items[0]!.source.captured_at, items[0]!.ts)

    // nothing half-written left behind for a later run to trip over
    assert.deepEqual((await fs.readdir(blobDir(result.sha256))).sort(), ['meta.json', 'original.png'])
  })
})

test('the same file twice is one blob and two items', async () => {
  await withHome(async home => {
    const file = await incoming(home, 'shot.png', 'pixels')
    const first = await ingest(capture(file))
    const second = await ingest(capture(file, {source: {url: 'https://other.example/post'}}))

    assert.equal(first.deduped, false)
    assert.equal(second.deduped, true)
    assert.equal(second.sha256, first.sha256)
    assert.equal(second.blobPath, first.blobPath)

    assert.equal((await originals()).length, 1)

    const items = await loadItems()
    assert.equal(items.length, 2)
    assert.notEqual(items[0]!.id, items[1]!.id)
    assert.deepEqual(
      items.map(item => item.source.url).sort(),
      ['https://example.com/shot.png', 'https://other.example/post'],
    )
  })
})

test('different bytes get their own blob', async () => {
  await withHome(async home => {
    const one = await ingest(capture(await incoming(home, 'a.png', 'pixels')))
    const two = await ingest(capture(await incoming(home, 'b.png', 'other pixels')))

    assert.notEqual(one.sha256, two.sha256)
    assert.equal(two.deduped, false)
    assert.equal((await originals()).length, 2)
    assert.equal((await loadItems()).length, 2)
  })
})

test('meta.json records the hash, the real size, the kind and the mime', async () => {
  await withHome(async home => {
    const body = 'pixels'
    const result = await ingest(capture(await incoming(home, 'shot.png', body)))

    const meta = JSON.parse(await fs.readFile(path.join(blobDir(result.sha256), 'meta.json'), 'utf8'))
    assert.deepEqual(meta, {
      sha256: createHash('sha256').update(body).digest('hex'),
      kind: 'image',
      mime: 'image/png',
      bytes: Buffer.byteLength(body),
    })
    assert.equal(meta.sha256, result.sha256)
    // derivation owns these, and their absence is what marks the blob underived
    assert.equal('derived_at' in meta, false)
    assert.equal('deriver_version' in meta, false)
    assert.equal('width' in meta, false)
  })
})

test('the extension follows the source file, then the mime, then nothing', async () => {
  await withHome(async home => {
    const clip = await ingest(capture(await incoming(home, 'clip.mp4', 'frames'), {kind: 'video', mime: 'video/mp4'}))
    assert.equal(path.basename(clip.blobPath), 'original.mp4')

    const named = await ingest(capture(await incoming(home, '9f8a7b6c', 'webp bytes'), {mime: 'image/webp'}))
    assert.equal(path.basename(named.blobPath), 'original.webp')

    const bare = await ingest(capture(await incoming(home, 'mystery', 'unknowable'), {mime: undefined}))
    assert.equal(path.basename(bare.blobPath), 'original')
    assert.equal(await findOriginal(bare.sha256), bare.blobPath)
  })
})

test('boards named at capture are created, and the item stores their keys', async () => {
  await withHome(async home => {
    const result = await ingest(
      capture(await incoming(home, 'shot.png', 'pixels'), {boards: ['Hero Refs', 'hero refs', '  ']}),
    )

    assert.deepEqual(result.item.boards, ['hero-refs'])

    const boards = await loadBoards()
    assert.deepEqual(Object.keys(boards), ['hero-refs'])
    assert.equal(boards['hero-refs']!.name, 'Hero Refs')
    assert.match(boards['hero-refs']!.created_at, /^\d{4}-\d{2}-\d{2}T/)
  })
})

test('ensureBoard is idempotent and never clobbers what is already there', async () => {
  await withHome(async () => {
    const first = await ensureBoard('Hero Refs', 'for the Q3 site')

    const boards = await loadBoards()
    boards['hero-refs']!.cover = 'deadbeef'
    await fs.writeFile(boardsPath(), JSON.stringify(boards, null, 2))

    const again = await ensureBoard('hero refs', 'a different note')
    assert.deepEqual(again, {...first, cover: 'deadbeef'})

    const after = await loadBoards()
    assert.deepEqual(Object.keys(after), ['hero-refs'])
    assert.equal(after['hero-refs']!.note, 'for the Q3 site')
    assert.equal(after['hero-refs']!.created_at, first.created_at)
    assert.equal(after['hero-refs']!.cover, 'deadbeef')
  })
})

test('a board key is the name slugified, and a name with nothing to slug is refused', async () => {
  assert.equal(boardKey('Hero Refs'), 'hero-refs')
  assert.equal(boardKey('  Q3 / marketing site!  '), 'q3--marketing-site')
  assert.equal(boardKey('!!!'), '')
  await withHome(async () => {
    await assert.rejects(ensureBoard('!!!'), /no letters or numbers/)
  })
})

test('boards and tags default to empty arrays', async () => {
  await withHome(async home => {
    const result = await ingest(capture(await incoming(home, 'shot.png', 'pixels')))
    assert.deepEqual(result.item.boards, [])
    assert.deepEqual(result.item.tags, [])
    assert.equal('note' in result.item, false)

    const [stored] = await loadItems()
    assert.deepEqual(stored!.boards, [])
    assert.deepEqual(stored!.tags, [])
    assert.deepEqual(await loadBoards(), {})
  })
})

test('an input path that is missing or is not a file is a clear error', async () => {
  await withHome(async home => {
    await assert.rejects(ingest(capture(path.join(home, 'nope.png'))), /Nothing to pluck/)
    await assert.rejects(ingest(capture(home)), /not a file/)
    assert.equal((await loadItems()).length, 0)
  })
})

test('the library survives losing the whole cache directory', async () => {
  await withHome(async home => {
    const result = await ingest(capture(await incoming(home, 'shot.png', 'pixels'), {tags: ['dark'], note: 'the rule'}))

    await fs.rm(cacheDir(), {recursive: true, force: true})

    const items = await loadItems()
    assert.equal(items.length, 1)
    assert.equal(items[0]!.id, result.item.id)
    assert.equal(items[0]!.note, 'the rule')
    assert.deepEqual(items[0]!.tags, ['dark'])
    assert.equal(await fs.readFile(result.blobPath, 'utf8'), 'pixels')
    assert.equal(await findOriginal(result.sha256), result.blobPath)
  })
})

test('a lost meta.json is healed by capturing the same bytes again', async () => {
  await withHome(async home => {
    const file = await incoming(home, 'shot.png', 'pixels')
    const first = await ingest(capture(file))
    const metaPath = path.join(blobDir(first.sha256), 'meta.json')

    await fs.rm(metaPath)
    const second = await ingest(capture(file))

    // kind and mime come from the extractor, not the bytes, so a dedupe hit is
    // the only chance to rebuild them
    assert.equal(second.deduped, true)
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    assert.equal(meta.kind, 'image')
    assert.equal(meta.mime, 'image/png')
    assert.equal(meta.sha256, first.sha256)
    assert.equal((await originals()).length, 1)
  })
})

test('healing never overwrites derived data already in meta.json', async () => {
  await withHome(async home => {
    const file = await incoming(home, 'shot.png', 'pixels')
    const first = await ingest(capture(file))
    const metaPath = path.join(blobDir(first.sha256), 'meta.json')

    const derived = {...JSON.parse(await fs.readFile(metaPath, 'utf8')), palette: [{hex: '#ff6b35', weight: 1}]}
    await fs.writeFile(metaPath, JSON.stringify(derived))

    await ingest(capture(file))

    const after = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    assert.deepEqual(after.palette, [{hex: '#ff6b35', weight: 1}], 'a re-capture must not wipe the palette')
  })
})
