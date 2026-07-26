import assert from 'node:assert/strict'
import {once} from 'node:events'
import {createReadStream, createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable, Writable} from 'node:stream'
import test from 'node:test'
import {cmdExport, cmdImport, exportBundle, importBundle, type Manifest} from './bundle.js'
import {ingest, loadBoards, type IngestInput} from './ingest.js'
import {deleteItem, loadItems} from './log.js'
import {blobDir, blobsDir, findOriginal, itemsLogPath} from './paths.js'
import {isoNow, type Item} from './types.js'

/**
 * Every test runs against a throwaway $PLUCK_HOME, and the round trips run
 * against two of them. Nothing here may look at the developer's real library.
 */
async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const before = process.env.PLUCK_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-bundle-'))
  process.env.PLUCK_HOME = home
  try {
    return await run(home)
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

async function toBuffer(opts: Parameters<typeof exportBundle>[0]): Promise<{bundle: Buffer; manifest: Manifest}> {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk as Buffer))
      done()
    },
  })
  const manifest = await exportBundle(opts, sink)
  return {bundle: Buffer.concat(chunks), manifest}
}

const asStream = (bundle: Buffer): Readable => Readable.from([bundle])

/** Every blob the library still holds, by hash — file name included. */
async function storedBlobs(): Promise<Record<string, {name: string; body: string}>> {
  const found: Record<string, {name: string; body: string}> = {}
  let shards: string[]
  try {
    shards = await fs.readdir(blobsDir())
  } catch {
    return found
  }
  for (const shard of shards) {
    for (const sha256 of await fs.readdir(path.join(blobsDir(), shard))) {
      const original = await findOriginal(sha256)
      if (!original) continue
      found[sha256] = {name: path.basename(original), body: await fs.readFile(original, 'utf8')}
    }
  }
  return found
}

test('a bundle round-trips into a fresh library, items and bytes intact', async () => {
  const source = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a'), {tags: ['dark'], note: 'the rule'}))
    await ingest(capture(await incoming(home, 'b.mp4', 'frames b'), {kind: 'video', mime: 'video/mp4'}))

    const {bundle, manifest} = await toBuffer({})
    return {bundle, manifest, items: await loadItems(), blobs: await storedBlobs()}
  })

  assert.equal(source.manifest.format, 1)
  assert.equal(source.manifest.items, 2)
  assert.equal(source.manifest.blobs, 2)

  await withHome(async () => {
    const result = await importBundle(asStream(source.bundle))
    assert.deepEqual(result, {items: 2, blobs: 2, skipped: 0})

    assert.deepEqual(await loadItems(), source.items)
    assert.deepEqual(await storedBlobs(), source.blobs)

    // meta.json rides along, so the imported blob knows its kind and mime —
    // neither of which is recoverable from the bytes
    const [item] = await loadItems()
    const meta = JSON.parse(await fs.readFile(path.join(blobDir(item!.sha256!), 'meta.json'), 'utf8'))
    assert.equal(meta.sha256, item!.sha256)
    assert.ok(meta.kind)
  })
})

test('importing the same bundle twice is a no-op', async () => {
  const bundle = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a')))
    await ingest(capture(await incoming(home, 'b.png', 'pixels b')))
    return (await toBuffer({})).bundle
  })

  await withHome(async () => {
    await importBundle(asStream(bundle))
    const after = await loadItems()
    const log = await fs.readFile(itemsLogPath(), 'utf8')

    const again = await importBundle(asStream(bundle))
    assert.deepEqual(again, {items: 0, blobs: 0, skipped: 4}, 'two records and two blobs already held')
    assert.deepEqual(await loadItems(), after, 'no duplicate items')
    assert.equal(await fs.readFile(itemsLogPath(), 'utf8'), log, 'and not a line appended')
  })
})

test('a blob you already hold skips the bytes but the item still lands', async () => {
  const bundle = await withHome(async home => {
    await ingest(capture(await incoming(home, 'shot.png', 'pixels')))
    return (await toBuffer({})).bundle
  })

  await withHome(async home => {
    // same bytes, different extension, so a rewritten blob would be visible
    const mine = await ingest(
      capture(await incoming(home, 'shot.webp', 'pixels'), {
        mime: 'image/webp',
        source: {url: 'https://other.example/post'},
      }),
    )

    const result = await importBundle(asStream(bundle))
    assert.deepEqual(result, {items: 1, blobs: 0, skipped: 1})

    const items = await loadItems()
    assert.equal(items.length, 2, 'their save of the picture and mine are different items')
    assert.deepEqual(new Set(items.map(item => item.sha256)), new Set([mine.sha256]), 'and one blob')
    assert.deepEqual(
      (await fs.readdir(blobDir(mine.sha256))).sort(),
      ['meta.json', 'original.webp'],
      'the bytes I already had were not rewritten',
    )
  })
})

test('a friend’s note on the same blob never clobbers mine', async () => {
  const bundle = await withHome(async home => {
    await ingest(capture(await incoming(home, 'shot.png', 'pixels'), {note: 'theirs'}))
    return (await toBuffer({})).bundle
  })

  await withHome(async home => {
    await ingest(capture(await incoming(home, 'shot.png', 'pixels'), {note: 'mine'}))
    await importBundle(asStream(bundle))

    const notes = (await loadItems()).map(item => item.note).sort()
    assert.deepEqual(notes, ['mine', 'theirs'])
  })
})

test('a tombstone in the bundle is honored', async () => {
  const home = await withHome(async here => {
    await ingest(capture(await incoming(here, 'a.png', 'pixels a')))
    const doomed = await ingest(capture(await incoming(here, 'b.png', 'pixels b')))
    return {first: (await toBuffer({})).bundle, doomed: doomed.item.id, dir: here}
  })
  assert.ok(home.doomed)

  // the delete happens in its own library, then travels as a second bundle
  const second = await withHome(async here => {
    await ingest(capture(await incoming(here, 'a.png', 'pixels a')))
    const doomed = await ingest(capture(await incoming(here, 'b.png', 'pixels b')))
    const before = (await toBuffer({})).bundle
    await deleteItem(doomed.item.id, isoNow())
    return {before, after: (await toBuffer({})).bundle, id: doomed.item.id}
  })

  await withHome(async () => {
    await importBundle(asStream(second.before))
    assert.equal((await loadItems()).length, 2)

    const result = await importBundle(asStream(second.after))
    assert.equal(result.items, 1, 'only the tombstone is new')

    const left = await loadItems()
    assert.equal(left.length, 1)
    assert.equal(
      left.some(item => item.id === second.id),
      false,
    )
  })
})

test('--dry-run reports the merge and writes nothing at all', async () => {
  const bundle = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a')))
    await ingest(capture(await incoming(home, 'b.png', 'pixels b')))
    return (await toBuffer({})).bundle
  })

  await withHome(async home => {
    const result = await importBundle(asStream(bundle), {dryRun: true})
    assert.deepEqual(result, {items: 2, blobs: 2, skipped: 0})
    assert.deepEqual(await fs.readdir(home), [], 'not even a library directory')
    assert.deepEqual(await loadItems(), [])
  })
})

test('a truncated bundle is a clear error and leaves the library untouched', async () => {
  const bundle = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a')))
    await ingest(capture(await incoming(home, 'b.png', 'pixels b')))
    return (await toBuffer({})).bundle
  })

  await withHome(async home => {
    const mine = await ingest(capture(await incoming(home, 'c.png', 'pixels c'), {note: 'still here'}))
    const before = await loadItems()
    const blobs = await storedBlobs()

    await assert.rejects(importBundle(asStream(bundle.subarray(0, bundle.length - 40))), /bundle/)

    assert.deepEqual(await loadItems(), before)
    assert.deepEqual(await storedBlobs(), blobs)
    assert.deepEqual(Object.keys(blobs), [mine.sha256])
    // no staging left behind for a later run to trip over
    const stray = (await fs.readdir(path.join(home, 'library'))).filter(entry => entry.startsWith('.importing'))
    assert.deepEqual(stray, [])
  })
})

test('a file that is not a bundle at all is refused', async () => {
  await withHome(async () => {
    await assert.rejects(importBundle(asStream(Buffer.from('not gzip, not tar, not anything'))), /bundle/)
    assert.deepEqual(await loadItems(), [])
  })
})

test('--board exports only that board’s items and only the blobs they reference', async () => {
  const exported = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a'), {boards: ['Hero Refs'], note: 'hero one'}))
    await ingest(capture(await incoming(home, 'b.png', 'pixels b'), {boards: ['hero refs'], note: 'hero two'}))
    const stranger = await ingest(capture(await incoming(home, 'c.png', 'pixels c'), {boards: ['Other'], note: 'other'}))

    const {bundle, manifest} = await toBuffer({board: 'Hero Refs'})
    return {bundle, manifest, stranger: stranger.sha256}
  })

  assert.equal(exported.manifest.items, 2)
  assert.equal(exported.manifest.blobs, 2)

  await withHome(async () => {
    await importBundle(asStream(exported.bundle))

    const notes = (await loadItems()).map(item => item.note).sort()
    assert.deepEqual(notes, ['hero one', 'hero two'])
    assert.equal(exported.stranger in (await storedBlobs()), false, 'the other board’s bytes stayed home')
  })
})

test('--tag and --since narrow the same way find does', async () => {
  const bundles = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a'), {tags: ['dark', 'editorial']}))
    await ingest(capture(await incoming(home, 'b.png', 'pixels b'), {tags: ['bright']}))

    return {
      tagged: (await toBuffer({tags: ['DARK']})).manifest,
      future: (await toBuffer({since: '2999-01-01'})).manifest,
      past: (await toBuffer({until: '2999-01-01'})).manifest,
    }
  })

  assert.equal(bundles.tagged.items, 1, 'tags match case-insensitively, like find')
  assert.equal(bundles.tagged.blobs, 1)
  assert.equal(bundles.future.items, 0)
  assert.equal(bundles.past.items, 2)
})

test('an empty bundle is valid and imports as nothing', async () => {
  const bundle = await withHome(async () => (await toBuffer({})).bundle)

  await withHome(async () => {
    assert.deepEqual(await importBundle(asStream(bundle)), {items: 0, blobs: 0, skipped: 0})
    assert.deepEqual(await loadItems(), [])
  })
})

test('export --out writes a file that import reads back', async () => {
  const target = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a'), {note: 'kept'}))
    const file = path.join(home, 'hero-refs.pluck')

    const exported = await cmdExport(['--out', file, '--json'])
    assert.equal(exported.ok, true)
    assert.deepEqual(
      exported.ok ? {...(exported.data as Record<string, unknown>), created_at: undefined} : {},
      {format: 1, created_at: undefined, items: 1, blobs: 1, out: file},
    )

    const copy = path.join(os.tmpdir(), `pluck-bundle-copy-${process.pid}.pluck`)
    await fs.copyFile(file, copy)
    return copy
  })

  await withHome(async () => {
    const dry = await cmdImport([target, '--dry-run'])
    assert.equal(dry.ok, true)
    assert.deepEqual(dry.ok ? dry.data : {}, {file: target, dryRun: true, items: 1, blobs: 1, skipped: 0})
    assert.deepEqual(await loadItems(), [])

    const done = await cmdImport([target])
    assert.equal(done.ok, true)
    assert.equal((await loadItems())[0]!.note, 'kept')
  })

  await fs.rm(target, {force: true})
})

test('the commands refuse what they cannot do, with a usage code', async () => {
  await withHome(async home => {
    const noPath = await cmdImport([])
    assert.equal(noPath.ok, false)
    assert.equal(noPath.ok === false && noPath.error.code, 'usage')

    const missing = await cmdImport([path.join(home, 'nope.pluck')])
    assert.equal(missing.ok === false && missing.error.code, 'not_found')

    const stray = await cmdExport(['extra'])
    assert.equal(stray.ok === false && stray.error.code, 'usage')

    const nonsense = await cmdExport(['--board', '!!!'])
    assert.equal(nonsense.ok === false && nonsense.error.code, 'usage')
  })
})

test('a bundle is a real gzipped tar, readable by anything that reads tar', async () => {
  const bundle = await withHome(async home => {
    await ingest(capture(await incoming(home, 'a.png', 'pixels a')))
    return (await toBuffer({})).bundle
  })

  assert.equal(bundle[0], 0x1f, 'gzip magic')
  assert.equal(bundle[1], 0x8b)

  const {gunzipSync} = await import('node:zlib')
  const tar = gunzipSync(bundle)
  assert.equal(tar.length % 512, 0, 'tar is a whole number of blocks')

  const names: string[] = []
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    assert.equal(header.subarray(257, 262).toString('ascii'), 'ustar')
    const end = header.indexOf(0)
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/[^0-7]/g, ''), 8)
    names.push(header.subarray(0, end).toString('utf8'))
    offset += 512 + Math.ceil(size / 512) * 512
  }

  assert.deepEqual(names.slice(0, 2), ['manifest.json', 'items.jsonl'])
  assert.equal(names.length, 4, 'and the blob’s original plus its meta')
  assert.ok(names[2]!.startsWith('blobs/'))
})

test('a bundle round-trips through real files, not just memory streams', async () => {
  // The in-memory round-trip passed while the real path crashed with an
  // unhandled ERR_STREAM_DESTROYED: a Buffer/PassThrough has completely
  // different flow-control and destroy semantics from fs streams, and the
  // blob directory doesn't exist yet when the write stream opens.
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-fs-src-'))
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-fs-dst-'))
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-fs-work-'))
  const previous = process.env.PLUCK_HOME

  try {
    // several hundred KB so the body spans many stream chunks — a single
    // entry inside one 64 KB read never reproduced this
    const big = Buffer.alloc(400_000)
    for (let at = 0; at < big.length; at++) big[at] = at % 251
    const incoming = path.join(work, 'big.png')
    await fs.writeFile(incoming, big)

    process.env.PLUCK_HOME = source
    const stored = await ingest({
      path: incoming,
      kind: 'image',
      mime: 'image/png',
      source: {url: 'https://example.com/big.png'},
      note: 'large enough to span chunks',
    })

    const bundlePath = path.join(work, 'out.pluck')
    const sink = createWriteStream(bundlePath)
    await exportBundle({}, sink)
    // exportBundle deliberately never ends `out` — it may be stdout, and the
    // caller that opened a file is the one that has to close it
    sink.end()
    await once(sink, 'close')

    process.env.PLUCK_HOME = target
    const first = await importBundle(createReadStream(bundlePath))
    assert.equal(first.items, 1)
    assert.equal(first.blobs, 1)

    const landed = await findOriginal(stored.sha256)
    assert.ok(landed, 'the blob should exist in the target library')
    assert.deepEqual(await fs.readFile(landed), big, 'bytes must survive the round trip exactly')

    // and again — importing the same bundle twice changes nothing
    const second = await importBundle(createReadStream(bundlePath))
    assert.equal(second.items, 0)
    assert.equal(second.blobs, 0)
    assert.equal((await loadItems()).length, 1)
  } finally {
    if (previous === undefined) delete process.env.PLUCK_HOME
    else process.env.PLUCK_HOME = previous
    for (const dir of [source, target, work]) await fs.rm(dir, {recursive: true, force: true})
  }
})

test('a bundle that goes bad mid-blob rejects instead of taking the process down', async () => {
  // The crash this guards: a decode error lands while a blob's write stream
  // still has queued writes, the sink is destroyed, and the queued fs write
  // then emits ERR_STREAM_DESTROYED on a stream nobody is listening to — an
  // uncaught exception rather than a failed import. It needs a real file and a
  // blob big enough to still be in flight, so an in-memory stream never sees it.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-bad-'))
  try {
    const bundlePath = path.join(work, 'refs.pluck')

    await withHome(async () => {
      const big = Buffer.alloc(400_000)
      for (let at = 0; at < big.length; at++) big[at] = (at * 7) % 251
      const arrived = path.join(work, 'big.png')
      await fs.writeFile(arrived, big)
      await ingest(capture(arrived))

      const sink = createWriteStream(bundlePath)
      await exportBundle({}, sink)
      sink.end()
      await once(sink, 'close')
    })

    // truncate deep inside the last blob rather than at a tidy boundary
    const whole = await fs.readFile(bundlePath)
    await fs.writeFile(bundlePath, whole.subarray(0, whole.length - 20_000))

    await withHome(async home => {
      const mine = await ingest(capture(await incoming(home, 'mine.png', 'my pixels'), {note: 'untouched'}))

      await assert.rejects(importBundle(createReadStream(bundlePath)), /bundle/)

      const items = await loadItems()
      assert.equal(items.length, 1, 'the failed import must not have applied anything')
      assert.equal(items[0]!.note, 'untouched')
      assert.deepEqual(Object.keys(await storedBlobs()), [mine.sha256])
      const stray = (await fs.readdir(path.join(home, 'library'))).filter(entry => entry.startsWith('.importing'))
      assert.deepEqual(stray, [], 'no staged blob left behind')
    })
  } finally {
    await fs.rm(work, {recursive: true, force: true})
  }
})

test('an imported board is recreated, not just referenced', async () => {
  // boards.json doesn't travel in the bundle. Without recreating it on import,
  // sharing a board — the entire point of a bundle — lands the items while
  // `pluck boards` stays empty and the board is invisible.
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-bd-src-'))
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-bd-dst-'))
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-bd-work-'))
  const previous = process.env.PLUCK_HOME

  try {
    const incoming = path.join(work, 'a.png')
    await fs.writeFile(incoming, 'pixels')

    process.env.PLUCK_HOME = source
    await ingest({
      path: incoming,
      kind: 'image',
      mime: 'image/png',
      source: {url: 'https://example.com/a.png'},
      boards: ['hero refs'],
    })

    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk as Buffer)
        done()
      },
    })
    await exportBundle({}, sink)

    process.env.PLUCK_HOME = target
    await importBundle(Readable.from(Buffer.concat(chunks)))

    const item = (await loadItems())[0]
    assert.deepEqual(item?.boards, ['hero-refs'], 'the item keeps its board key')

    const boards = await loadBoards()
    assert.ok(boards['hero-refs'], 'the board itself must exist on the receiving side')
  } finally {
    if (previous === undefined) delete process.env.PLUCK_HOME
    else process.env.PLUCK_HOME = previous
    for (const dir of [source, target, work]) await fs.rm(dir, {recursive: true, force: true})
  }
})
