import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {boardCounts, gridLayout, moveSelection, rectsFor, titleFor, type GridLayout} from './library.js'
import type {Item} from '../lib/store/types.js'

/**
 * Only the pure layout and movement logic — rendering ink in a test proves
 * little and costs a lot. What's tested here is what the click rectangles and
 * the drawn boxes both derive from, so if these agree, a click lands where the
 * thumbnail is.
 */

/** Every terminal anyone plausibly runs this in, plus the two extremes. */
const SIZES: Array<[columns: number, rows: number]> = []
for (const columns of [20, 24, 40, 60, 80, 100, 120, 160, 200, 300, 400]) {
  for (const rows of [10, 12, 16, 24, 30, 50, 80, 100]) SIZES.push([columns, rows])
}

// --- gridLayout -------------------------------------------------------------

test('every layout field is positive at every terminal size from 20x10 to 400x100', () => {
  for (const [columns, rows] of SIZES) {
    for (const count of [0, 1, 7, 60]) {
      const layout = gridLayout(columns, rows, count)
      for (const [field, value] of Object.entries(layout)) {
        assert.ok(Number.isInteger(value), `${field} at ${columns}x${rows} is not an integer: ${value}`)
        assert.ok(value >= 1, `${field} at ${columns}x${rows} count ${count} was ${value}`)
      }
    }
  }
})

test('a row of thumbnails and their gaps always fits the terminal', () => {
  for (const [columns, rows] of SIZES) {
    const {perRow, thumbCols} = gridLayout(columns, rows, 60)
    const used = perRow * thumbCols + 2 * (perRow - 1)
    assert.ok(used <= Math.max(1, columns - 4), `${columns}x${rows} draws ${used} cells into ${columns - 4}`)
  }
})

test('a page of thumbnails always fits the rows the terminal has', () => {
  for (const [columns, rows] of SIZES) {
    const {rowsPerPage, thumbRows} = gridLayout(columns, rows, 60)
    // header (3) + footer (3) + rowsPerPage cell rows of thumb + title + gutter
    assert.ok(6 + rowsPerPage * (thumbRows + 2) <= Math.max(9, rows), `${columns}x${rows} overflows`)
  }
})

test('perRow grows with width and never shrinks', () => {
  let previous = 0
  for (let columns = 20; columns <= 400; columns++) {
    const {perRow} = gridLayout(columns, 40, 60)
    assert.ok(perRow >= previous, `perRow fell from ${previous} to ${perRow} at ${columns} columns`)
    previous = perRow
  }
  assert.equal(gridLayout(20, 40, 60).perRow, 1)
  assert.ok(gridLayout(400, 40, 60).perRow > gridLayout(80, 40, 60).perRow)
  assert.ok(gridLayout(80, 40, 60).perRow > gridLayout(40, 40, 60).perRow)
})

test('pages cover the whole result set, and an empty library is still one page', () => {
  assert.equal(gridLayout(80, 24, 0).pages, 1)
  for (const [columns, rows] of SIZES) {
    const layout = gridLayout(columns, rows, 60)
    assert.ok(layout.pages * layout.perRow * layout.rowsPerPage >= 60, `${columns}x${rows} cannot reach every item`)
  }
})

test('a nonsense size degrades instead of producing NaN', () => {
  for (const layout of [gridLayout(Number.NaN, 24, 3), gridLayout(0, 0, 3), gridLayout(-40, -10, 3)]) {
    for (const value of Object.values(layout)) assert.ok(Number.isInteger(value) && value >= 1)
  }
})

// --- moveSelection ----------------------------------------------------------

const PER_ROW = 4
const COUNT = 10 // 4 + 4 + a partial row of 2

test('left and right wrap around the ends of the list', () => {
  assert.equal(moveSelection(0, 'h', PER_ROW, COUNT), COUNT - 1)
  assert.equal(moveSelection(0, 'left', PER_ROW, COUNT), COUNT - 1)
  assert.equal(moveSelection(COUNT - 1, 'l', PER_ROW, COUNT), 0)
  assert.equal(moveSelection(COUNT - 1, 'right', PER_ROW, COUNT), 0)

  // within a row, and across a row boundary
  assert.equal(moveSelection(2, 'l', PER_ROW, COUNT), 3)
  assert.equal(moveSelection(3, 'l', PER_ROW, COUNT), 4)
  assert.equal(moveSelection(4, 'h', PER_ROW, COUNT), 3)
})

test('up and down clamp at the top and bottom rows', () => {
  for (const index of [0, 1, 2, 3]) {
    assert.equal(moveSelection(index, 'k', PER_ROW, COUNT), index)
    assert.equal(moveSelection(index, 'up', PER_ROW, COUNT), index)
  }
  assert.equal(moveSelection(4, 'k', PER_ROW, COUNT), 0)
  assert.equal(moveSelection(0, 'j', PER_ROW, COUNT), 4)
  assert.equal(moveSelection(4, 'j', PER_ROW, COUNT), 8)

  // the last row is partial: 8 and 9 exist, 10 and 11 do not
  assert.equal(moveSelection(8, 'j', PER_ROW, COUNT), 8)
  assert.equal(moveSelection(6, 'j', PER_ROW, COUNT), 6)
  assert.equal(moveSelection(5, 'j', PER_ROW, COUNT), 9)
})

test('g and G jump to the first and last item', () => {
  assert.equal(moveSelection(5, 'g', PER_ROW, COUNT), 0)
  assert.equal(moveSelection(5, 'G', PER_ROW, COUNT), COUNT - 1)
  assert.equal(moveSelection(0, 'G', PER_ROW, 1), 0)
  assert.equal(moveSelection(0, 'G', PER_ROW, 0), 0)
})

test('an empty or single-item library can never move out of range', () => {
  const keys = ['h', 'j', 'k', 'l', 'left', 'right', 'up', 'down', 'g', 'G', 'b', '/', '']
  for (const key of keys) {
    assert.equal(moveSelection(0, key, PER_ROW, 0), 0, `count 0, key ${key}`)
    assert.equal(moveSelection(3, key, PER_ROW, 0), 0, `count 0, key ${key}`)
    assert.equal(moveSelection(0, key, PER_ROW, 1), 0, `count 1, key ${key}`)
    assert.equal(moveSelection(9, key, PER_ROW, 1), 0, `count 1, key ${key}`)
  }
})

test('any key from any index stays inside the list', () => {
  const keys = ['h', 'j', 'k', 'l', 'left', 'right', 'up', 'down', 'g', 'G', 'x']
  for (const count of [1, 2, 5, 10, 60]) {
    for (const perRow of [1, 3, 4, 18]) {
      for (let index = -3; index <= count + 3; index++) {
        for (const key of keys) {
          const next = moveSelection(index, key, perRow, count)
          assert.ok(next >= 0 && next < count, `${index} + ${key} at ${perRow}/${count} gave ${next}`)
        }
      }
    }
  }
})

test('an unknown key clamps a stale index instead of moving', () => {
  assert.equal(moveSelection(99, 'x', PER_ROW, COUNT), COUNT - 1)
  assert.equal(moveSelection(-4, 'x', PER_ROW, COUNT), 0)
})

// --- rectsFor ---------------------------------------------------------------

const overlaps = (a: [number, number, number, number], b: [number, number, number, number]) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

test('there is exactly one rectangle per visible cell', () => {
  const layout = gridLayout(80, 30, 60)
  for (const count of [0, 1, 5, 12]) {
    assert.equal(rectsFor(layout, count, 3, 4).length, count)
  }
})

test('no two rectangles overlap, at any terminal size', () => {
  for (const [columns, rows] of SIZES) {
    const layout = gridLayout(columns, rows, 60)
    const rects = rectsFor(layout, layout.perRow * layout.rowsPerPage, 3, 4).map(target => target.rect)
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.equal(overlaps(rects[i]!, rects[j]!), false, `${columns}x${rows}: cell ${i} overlaps cell ${j}`)
      }
    }
  }
})

test('every coordinate is a positive cell — the terminal is 1-based', () => {
  for (const [columns, rows] of SIZES) {
    const layout = gridLayout(columns, rows, 60)
    for (const origin of [1, 3]) {
      for (const {rect} of rectsFor(layout, 24, origin, origin)) {
        for (const value of rect) assert.ok(value >= 1, `${columns}x${rows} produced ${rect.join(',')}`)
      }
    }
  }
  // a caller that hands over a 0 or a negative origin still gets drawable cells
  for (const {rect} of rectsFor(gridLayout(80, 30, 60), 6, 0, -5)) {
    for (const value of rect) assert.ok(value >= 1)
  }
})

test('rectangles run left to right then top to bottom, and match the drawn geometry', () => {
  const layout = gridLayout(80, 30, 60)
  const rects = rectsFor(layout, layout.perRow + 1, 3, 4).map(target => target.rect)

  assert.deepEqual(rects[0], [3, 4, layout.thumbCols, layout.thumbRows + 1])
  assert.deepEqual(rects[1], [3 + layout.thumbCols + 2, 4, layout.thumbCols, layout.thumbRows + 1])
  // wrapping to the next row costs the thumbnail, its title and one gutter row
  assert.deepEqual(rects[layout.perRow], [3, 4 + layout.thumbRows + 2, layout.thumbCols, layout.thumbRows + 1])
})

test('a rectangle action reports the index it was built for', () => {
  const picked: number[] = []
  const targets = rectsFor(gridLayout(80, 30, 60), 5, 3, 4, index => picked.push(index))
  targets[3]!.action()
  targets[0]!.action()
  assert.deepEqual(picked, [3, 0])

  // no handler is not a crash — the grid registers rects before it can act on them
  assert.doesNotThrow(() => rectsFor(gridLayout(80, 30, 60), 2, 3, 4)[0]!.action())
})

test('a degenerate layout still yields hittable rectangles', () => {
  const broken: GridLayout = {perRow: 0, rowsPerPage: 0, thumbCols: 0, thumbRows: 0, pages: 0}
  for (const {rect} of rectsFor(broken, 3, 1, 1)) {
    assert.ok(rect[2] >= 1 && rect[3] >= 1, `degenerate rect ${rect.join(',')}`)
  }
})

// --- items ------------------------------------------------------------------

function makeItem(over: Partial<Item> & {id: string}): Item {
  const {source, ...rest} = over
  return {
    ts: '2026-03-15T12:00:00.000Z',
    boards: [],
    tags: [],
    ...rest,
    source: {url: 'https://example.com/a', captured_at: '2026-03-15T12:00:00.000Z', ...source},
  }
}

test('boards are counted from the items that are actually filed in them', () => {
  const items = [
    makeItem({id: '1', boards: ['hero-refs']}),
    makeItem({id: '2', boards: ['hero-refs', 'dark']}),
    // casing and stray whitespace are the same board to a person, so they are here
    makeItem({id: '3', boards: [' Hero-Refs ']}),
    makeItem({id: '4', boards: ['']}),
    makeItem({id: '5'}),
  ]
  assert.deepEqual(boardCounts(items), [
    {name: 'hero-refs', count: 3},
    {name: 'dark', count: 1},
  ])
  assert.deepEqual(boardCounts([]), [])
})

test('an item always has something to be called', () => {
  assert.equal(titleFor(makeItem({id: '1', source: {url: 'u', captured_at: 'now', title: 'A title'}})), 'A title')
  assert.equal(titleFor(makeItem({id: '1', note: 'my note'})), 'my note')
  assert.equal(titleFor(makeItem({id: '1', source: {url: 'u', captured_at: 'now', site: 'example.com'}})), 'example.com')
  assert.equal(titleFor(makeItem({id: '1'})), 'https://example.com/a')
  assert.equal(titleFor(makeItem({id: '1', source: {url: '', captured_at: 'now', title: '   '}})), 'untitled')
})

// --- the store ---------------------------------------------------------------

test('the module never reads the real library — YOINKS_HOME decides where it looks', async () => {
  const previous = process.env.YOINKS_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-library-'))
  process.env.YOINKS_HOME = home
  try {
    const {loadItems} = await import('../lib/store/log.js')
    assert.deepEqual(await loadItems(), [])
    assert.deepEqual(boardCounts(await loadItems()), [])
  } finally {
    if (previous === undefined) delete process.env.YOINKS_HOME
    else process.env.YOINKS_HOME = previous
    await fs.rm(home, {recursive: true, force: true})
  }
})

test('the source holds no raw control bytes — escapes stay inside blocks.ts', async () => {
  const source = await fs.readFile(new URL('./library.tsx', import.meta.url), 'utf8')
  const control = [...source].filter(char => char.codePointAt(0)! < 0x20 && char !== '\n' && char !== '\t')
  assert.deepEqual(control, [])
})
