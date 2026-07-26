import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {ingest, type IngestInput, type IngestResult} from '../store/ingest.js'
import {blobMetaPath} from '../store/paths.js'
import type {BlobMeta, PaletteEntry} from '../store/types.js'
import {assignRoles, buildBrief, cmdBrief, fusePalettes, renderBriefMarkdown, type Brief} from './brief.js'
import type {Envelope, ErrorCode} from './json.js'

/**
 * The fusion and the roles are pure, so they are exercised with hand-built
 * palettes and never touch a disk. Everything below them runs against a
 * throwaway $PLUCK_HOME — never a real ~/.pluck.
 */

const entry = (hex: string, weight: number): PaletteEntry => ({hex, weight})

// --- fusePalettes -----------------------------------------------------------

test('a color two references share outranks a color only one of them has', () => {
  const fused = fusePalettes([
    [entry('#0b0d10', 0.5), entry('#e8e6e3', 0.5)],
    [entry('#0b0d10', 0.5), entry('#ff6b35', 0.5)],
  ])

  assert.deepEqual(
    fused.map(color => color.hex),
    ['#0b0d10', '#e8e6e3', '#ff6b35'],
  )
  assert.equal(fused[0]!.weight, 0.5)
  // the shared color carries both halves; neither loner catches it
  assert.ok(fused[0]!.weight > fused[1]!.weight + fused[2]!.weight - 1e-9)
  assert.equal(fused[1]!.weight, fused[2]!.weight)
})

test('a single loud reference does not outvote the rest of the board', () => {
  const quiet = [entry('#0b0d10', 0.5), entry('#151a20', 0.5)]
  const loud = [entry('#ff6b35', 40), entry('#ff2200', 40)]
  const fused = fusePalettes([quiet, quiet, loud])

  // three references, one vote each, whatever scale their weights arrived on
  assert.equal(fused[0]!.hex, '#0b0d10')
  assert.ok(fused[0]!.weight > 0.3, JSON.stringify(fused))
})

test('weights sum to about one', () => {
  const fused = fusePalettes([
    [entry('#0b0d10', 0.38), entry('#e8e6e3', 0.22), entry('#7d8590', 0.11)],
    [entry('#0b0d10', 0.9), entry('#ff6b35', 0.04)],
    [entry('#123456', 1)],
  ])
  const total = fused.reduce((sum, color) => sum + color.weight, 0)
  assert.ok(Math.abs(total - 1) < 1e-3, `weights summed to ${total}`)
})

test('near-identical colors across references merge and genuinely different ones do not', () => {
  const merged = fusePalettes([[entry('#ff6b35', 1)], [entry('#ff6d37', 1)]])
  assert.equal(merged.length, 1)

  const apart = fusePalettes([[entry('#ff6b35', 1)], [entry('#0b0d10', 1)]])
  assert.equal(apart.length, 2)

  // the threshold is on the 0..765 metric, so it can be turned off entirely
  assert.equal(fusePalettes([[entry('#ff6b35', 1)], [entry('#ff6d37', 1)]], 0).length, 2)
})

test('the same input twice returns a byte-identical result', () => {
  const palettes = () => [
    [entry('#0b0d10', 0.38), entry('#e8e6e3', 0.22), entry('#ff6b35', 0.04)],
    [entry('#0c0e11', 0.5), entry('#7d8590', 0.3), entry('#e8e6e3', 0.2)],
    [entry('#151a20', 0.6), entry('#ff6d37', 0.4)],
  ]

  const first = JSON.stringify(fusePalettes(palettes()))
  const second = JSON.stringify(fusePalettes(palettes()))
  assert.equal(first, second)

  // the pool is sorted before it is merged, so which reference came back first
  // cannot change a single hex
  assert.equal(JSON.stringify(fusePalettes(palettes().reverse())), first)
})

test('nothing to fuse is an empty palette, not a throw', () => {
  assert.deepEqual(fusePalettes([]), [])
  assert.deepEqual(fusePalettes([[], []]), [])
  // an unreadable hex or a weightless entry is dropped, never guessed at
  assert.deepEqual(fusePalettes([[entry('tangerine', 1), entry('#ff6b35', 0)]]), [])
})

test('no invented colors: every fused hex is an input or lies between two merged ones', () => {
  const inputs = ['#0b0d10', '#e8e6e3', '#ff6b35', '#7d8590']
  const fused = fusePalettes([
    [entry('#0b0d10', 0.6), entry('#e8e6e3', 0.4)],
    [entry('#ff6b35', 0.7), entry('#7d8590', 0.3)],
  ])
  assert.deepEqual(fused.map(color => color.hex).sort(), [...inputs].sort())

  // a merge averages, and an average of two near-identical colors sits between
  // them on every channel — it is never a color from somewhere else
  const [blend] = fusePalettes([[entry('#ff6b35', 1)], [entry('#ff6d37', 1)]])
  assert.ok(blend)
  for (const [at, low, high] of [
    [1, 0xff, 0xff],
    [3, 0x6b, 0x6d],
    [5, 0x35, 0x37],
  ] as const) {
    const channel = Number.parseInt(blend.hex.slice(at, at + 2), 16)
    assert.ok(channel >= low && channel <= high, `${blend.hex} channel at ${at} left the inputs`)
  }
})

// --- assignRoles ------------------------------------------------------------

/** The palette from docs/agents.md#schema, with the roles stripped back off. */
const DARK_BOARD: Array<{hex: string; weight: number}> = [
  {hex: '#0b0d10', weight: 0.38},
  {hex: '#e8e6e3', weight: 0.22},
  {hex: '#151a20', weight: 0.19},
  {hex: '#7d8590', weight: 0.11},
  {hex: '#ff6b35', weight: 0.04},
]

test('a dark palette gets a dark background, a light text and the chromatic outlier as accent', () => {
  const roled = assignRoles(DARK_BOARD)
  const roleOf = (hex: string) => roled.find(color => color.hex === hex)?.role

  assert.equal(roleOf('#0b0d10'), 'background')
  assert.equal(roleOf('#e8e6e3'), 'text')
  assert.equal(roleOf('#ff6b35'), 'accent')
  assert.equal(roleOf('#151a20'), 'surface')
  assert.equal(roleOf('#7d8590'), 'muted')
})

test('a light palette flips background and text without flipping the accent', () => {
  const roled = assignRoles([
    {hex: '#ffffff', weight: 0.5},
    {hex: '#111111', weight: 0.3},
    {hex: '#e5e5e5', weight: 0.15},
    {hex: '#0057ff', weight: 0.05},
  ])
  const roleOf = (hex: string) => roled.find(color => color.hex === hex)?.role

  assert.equal(roleOf('#ffffff'), 'background')
  assert.equal(roleOf('#111111'), 'text')
  assert.equal(roleOf('#e5e5e5'), 'surface')
  assert.equal(roleOf('#0057ff'), 'accent')
})

test('one entry, no entries and unreadable entries all survive', () => {
  assert.deepEqual(assignRoles([]), [])
  assert.deepEqual(assignRoles([{hex: '#0b0d10', weight: 1}]), [{hex: '#0b0d10', weight: 1, role: 'background'}])
  assert.deepEqual(assignRoles([{hex: 'tangerine', weight: 1}]), [{hex: 'tangerine', weight: 1}])
})

test('a role nobody is confident about is left off rather than guessed at', () => {
  // every color mid-luminance and gray: nothing is extreme enough to be the
  // page and nothing is chromatic enough to be the accent, so nothing says it is
  const flat = assignRoles([
    {hex: '#8a8a8a', weight: 0.4},
    {hex: '#9a9a9a', weight: 0.35},
    {hex: '#7a7a7a', weight: 0.25},
  ])
  const claimed = new Set(flat.map(color => color.role).filter(Boolean))
  for (const role of ['background', 'text', 'accent', 'surface']) {
    assert.equal(claimed.has(role), false, `nothing here is the ${role}`)
  }

  // and a near-black beside a near-black gets a background but no text
  const dim = assignRoles([
    {hex: '#0b0d10', weight: 0.6},
    {hex: '#151a20', weight: 0.4},
  ])
  assert.equal(dim[0]!.role, 'background')
  assert.equal(dim[1]!.role, 'surface')
})

test('assignRoles leaves its input alone', () => {
  const before = JSON.stringify(DARK_BOARD)
  assignRoles(DARK_BOARD)
  assert.equal(JSON.stringify(DARK_BOARD), before)
})

// --- library-backed ---------------------------------------------------------

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = process.env.PLUCK_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-brief-'))
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

/** A capture that already happened, with the derived facts a brief reads. */
async function seed(
  home: string,
  over: Partial<IngestInput> & {palette?: PaletteEntry[]; fonts?: string[]} = {},
): Promise<IngestResult> {
  const {palette, fonts, ...rest} = over
  const name = `shot-${seq++}.png`
  const dir = path.join(home, 'incoming')
  await fs.mkdir(dir, {recursive: true})
  const file = path.join(dir, name)
  // distinct bytes per seed, or ingest dedupes them onto one blob and one meta
  await fs.writeFile(file, `pixels ${name}`)

  const stored = await ingest({
    path: file,
    kind: 'image',
    mime: 'image/png',
    source: {url: `https://example.com/${name}`, site: 'example.com', title: 'a dark hero'},
    ...rest,
  })

  if (palette || fonts) {
    const meta: BlobMeta = {
      ...(JSON.parse(await fs.readFile(blobMetaPath(stored.sha256), 'utf8')) as BlobMeta),
      ...(palette ? {palette} : {}),
      ...(fonts ? {fonts} : {}),
    }
    await fs.writeFile(blobMetaPath(stored.sha256), JSON.stringify(meta))
  }
  return stored
}

function dataOf<T>(envelope: Envelope<unknown>): T {
  if (!envelope.ok) assert.fail(`expected data, got ${envelope.error.code}: ${envelope.error.message}`)
  return envelope.data as T
}

function errorOf(envelope: Envelope<unknown>): {code: ErrorCode; message: string} {
  if (envelope.ok) assert.fail(`expected a failure, got ${JSON.stringify(envelope.data)}`)
  return envelope.error
}

test('an empty library is a valid brief, not a failure', async () => {
  await withHome(async () => {
    const brief = await buildBrief({query: 'dark analytics dashboard'})
    assert.deepEqual(brief, {
      query: 'dark analytics dashboard',
      matched: 0,
      palette: [],
      type: {families: []},
      notes: [],
      references: [],
    })

    const envelope = await cmdBrief(['dark', 'analytics', 'dashboard'])
    assert.equal(envelope.ok, true)
    assert.equal(dataOf<Brief>(envelope).matched, 0)
    assert.match(renderBriefMarkdown(brief), /Nothing in the library matched/)
  })
})

test('a brief fuses the palettes of what matched and hands back absolute paths', async () => {
  await withHome(async home => {
    const first = await seed(home, {
      note: 'the way the rule sits under the eyebrow',
      palette: [entry('#0b0d10', 0.6), entry('#e8e6e3', 0.3), entry('#ff6b35', 0.1)],
      fonts: ['Söhne', 'GT America Mono'],
    })
    const second = await seed(home, {
      palette: [entry('#0c0e11', 0.7), entry('#e8e6e3', 0.3)],
      fonts: ['Söhne'],
    })

    const brief = await buildBrief({})
    assert.equal(brief.matched, 2)

    // both references say near-black, so it leads and it leads by a lot
    assert.equal(brief.palette[0]?.role, 'background')
    assert.ok(brief.palette[0]!.weight > 0.5, JSON.stringify(brief.palette))
    assert.ok(brief.palette.some(color => color.hex === '#ff6b35' && color.role === 'accent'))

    assert.deepEqual(brief.type.families, [
      {name: 'Söhne', seen_in: 2},
      {name: 'GT America Mono', seen_in: 1},
    ])
    assert.deepEqual(brief.notes, ['the way the rule sits under the eyebrow'])

    const ids = brief.references.map(reference => reference.id)
    assert.deepEqual([...ids].sort(), [first.item.id, second.item.id].sort())
    for (const reference of brief.references) {
      assert.equal(path.isAbsolute(reference.path ?? ''), true)
      assert.equal(reference.kind, 'image')
      assert.ok(reference.palette.length)
    }
    assert.equal(brief.references.find(reference => reference.id === first.item.id)?.note, brief.notes[0])
  })
})

test('the query and the board both narrow what the brief is about', async () => {
  await withHome(async home => {
    await seed(home, {source: {url: 'https://a.example/1.png', title: 'dark editorial hero'}, boards: ['Hero Refs']})
    await seed(home, {source: {url: 'https://b.example/2.png', title: 'bright landing page'}})

    assert.equal((await buildBrief({query: 'dark editorial'})).matched, 1)
    assert.equal((await buildBrief({query: 'brutalist'})).matched, 0)
    // typed the way a person says it, matched the way ingest stored it
    assert.equal((await buildBrief({board: 'Hero Refs'})).matched, 1)
    assert.equal((await buildBrief({board: 'hero-refs'})).matched, 1)
    assert.equal((await buildBrief({limit: 1})).matched, 1)
  })
})

test('two runs over one library return byte-identical briefs', async () => {
  await withHome(async home => {
    await seed(home, {note: 'hairlines only', palette: [entry('#0b0d10', 0.7), entry('#ff6b35', 0.3)]})
    await seed(home, {palette: [entry('#0c0e11', 0.6), entry('#e8e6e3', 0.4)]})

    assert.equal(JSON.stringify(await buildBrief({})), JSON.stringify(await buildBrief({})))
  })
})

test('--no-paths and --no-notes actually omit what they promise to', async () => {
  await withHome(async home => {
    await seed(home, {note: 'no card shadows anywhere — hairlines only'})

    const full = dataOf<Brief>(await cmdBrief([]))
    assert.equal(full.notes.length, 1)
    assert.ok(full.references[0]!.path)

    const noPaths = dataOf<Brief>(await cmdBrief(['--no-paths']))
    assert.equal('path' in noPaths.references[0]!, false)
    assert.deepEqual(noPaths.notes, full.notes)

    const noNotes = dataOf<Brief>(await cmdBrief(['--no-notes']))
    assert.deepEqual(noNotes.notes, [])
    assert.equal('note' in noNotes.references[0]!, false)
    assert.ok(noNotes.references[0]!.path, 'only the notes were asked for')

    // and the markdown is rendered from the shaped brief, so it cannot disagree
    const markdown = dataOf<{markdown: string}>(await cmdBrief(['--md', '--no-notes', '--no-paths'])).markdown
    assert.equal(/hairlines/.test(markdown), false)
    assert.equal(markdown.includes(process.env.PLUCK_HOME!), false)
  })
})

test('--md renders the same brief as text to paste into a prompt', async () => {
  await withHome(async home => {
    await seed(home, {
      note: 'the way the rule sits under the eyebrow',
      palette: [entry('#0b0d10', 0.6), entry('#e8e6e3', 0.4)],
      fonts: ['Söhne'],
    })

    const markdown = dataOf<{markdown: string}>(await cmdBrief(['dark', '--md'])).markdown
    assert.match(markdown, /^# Brief — dark$/m)
    assert.match(markdown, /1 reference\./)
    assert.match(markdown, /#0b0d10/)
    assert.match(markdown, /Söhne — seen in 1 reference/)
    assert.match(markdown, /the way the rule sits under the eyebrow/)
    assert.equal(/\u001b/.test(markdown), false, 'no escape sequences — this gets pasted')
  })
})

test('brief refuses the flags it cannot honestly answer, and throws for nothing else', async () => {
  await withHome(async () => {
    assert.equal(errorOf(await cmdBrief(['--nonsense'])).code, 'usage')
    assert.equal(errorOf(await cmdBrief(['--limit', '0'])).code, 'usage')
    assert.equal(errorOf(await cmdBrief(['--limit', '2.5'])).code, 'usage')
    assert.equal(errorOf(await cmdBrief(['--limit'])).code, 'usage')
    assert.equal(errorOf(await cmdBrief(['--board'])).code, 'usage')
    assert.equal(errorOf(await cmdBrief(['--board', '!!!'])).code, 'usage')
    assert.equal(errorOf(await cmdBrief(['--md=yes'])).code, 'usage')
    assert.equal(errorOf(await cmdBrief(['--board', 'a', '--board', 'b'])).code, 'usage')

    // a query that starts with a dash is still a query
    assert.equal((await cmdBrief(['--', '--dark'])).ok, true)
    assert.equal((await cmdBrief(['--json', '--limit', '3'])).ok, true)
  })
})
