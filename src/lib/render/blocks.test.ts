import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {placeholderRows, renderBlocks, to256} from './blocks.js'

/**
 * Everything under test here is pure: no ffmpeg, no filesystem beyond reading
 * this module's own source back to prove it holds no control bytes.
 */

const ESC = String.fromCharCode(27)
const strip = (row: string) => row.replace(new RegExp(`${ESC}\\[[\\d;]*m`, 'g'), '')

const RED = [255, 0, 0]
const GREEN = [0, 255, 0]
const BLUE = [0, 0, 255]
const YELLOW = [255, 255, 0]

const pixels = (...rgb: number[][]) => Buffer.from(rgb.flat())

/** cols × rows*2 pixels of a deterministic gradient, so widths are testable. */
function ramp(cols: number, pixelRows: number): Buffer {
  const bytes: number[] = []
  for (let i = 0; i < cols * pixelRows; i++) bytes.push(i % 256, (i * 7) % 256, (i * 13) % 256)
  return Buffer.from(bytes)
}

test('one cell row pairs the two pixel rows into a foreground and a background', () => {
  const rows = renderBlocks(pixels(RED, GREEN, BLUE, YELLOW), 2, 1)
  assert.equal(rows.length, 1)
  assert.equal(strip(rows[0]!), '▀▀')
  assert.equal(
    rows[0],
    `${ESC}[38;2;255;0;0m${ESC}[48;2;0;0;255m▀` +
      `${ESC}[38;2;0;255;0m${ESC}[48;2;255;255;0m▀` +
      `${ESC}[0m`,
  )
})

test('every row is exactly cols cells wide once the colors are stripped', () => {
  const rows = renderBlocks(ramp(7, 6), 7, 3)
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.equal(strip(row).length, 7)
    assert.equal(strip(row), '▀'.repeat(7))
    assert.equal(row.endsWith(`${ESC}[0m`), true)
  }
})

test('a buffer of the wrong length is refused rather than misread', () => {
  assert.deepEqual(renderBlocks(pixels(RED, GREEN, BLUE), 2, 1), [])
  assert.deepEqual(renderBlocks(pixels(RED, GREEN, BLUE, YELLOW, RED), 2, 1), [])
  assert.deepEqual(renderBlocks(Buffer.alloc(0), 2, 1), [])
  assert.deepEqual(renderBlocks(ramp(7, 6), 0, 3), [])
  assert.deepEqual(renderBlocks(ramp(7, 6), 7, 0), [])
})

test('an odd pixel height fills the orphaned bottom half with the background', () => {
  // 2 cols × 2 cell rows wants 4 pixel rows; this image only has 3
  const short = pixels(RED, GREEN, BLUE, YELLOW, GREEN, RED)
  const rows = renderBlocks(short, 2, 2, {background: {r: 24, g: 24, b: 27}})
  assert.equal(rows.length, 2)
  assert.equal(strip(rows[1]!), '▀▀')
  assert.equal(
    rows[1],
    `${ESC}[38;2;0;255;0m${ESC}[48;2;24;24;27m▀` +
      `${ESC}[38;2;255;0;0m${ESC}[48;2;24;24;27m▀` +
      `${ESC}[0m`,
  )
  // repeating the top pixel downwards would read as a rendering bug
  assert.equal(rows[1]!.includes('48;2;0;255;0'), false)
  assert.equal(rows[1]!.includes('48;2;255;0;0'), false)
})

test('an orphaned bottom half defaults to black when no background is given', () => {
  const rows = renderBlocks(pixels(RED, GREEN), 2, 1)
  assert.equal(
    rows[0],
    `${ESC}[38;2;255;0;0m${ESC}[48;2;0;0;0m▀${ESC}[38;2;0;255;0m${ESC}[48;2;0;0;0m▀${ESC}[0m`,
  )
})

test('without truecolor every cell quantizes to the 256-color cube', () => {
  const rows = renderBlocks(ramp(6, 4), 6, 2, {truecolor: false})
  for (const row of rows) {
    assert.equal(strip(row).length, 6)
    assert.match(row, /38;5;\d+m/)
    assert.match(row, /48;5;\d+m/)
    assert.equal(row.includes('38;2;'), false)
    assert.equal(row.includes('48;2;'), false)
  }
  assert.equal(
    renderBlocks(pixels(RED, BLUE), 1, 1, {truecolor: false})[0],
    `${ESC}[38;5;196m${ESC}[48;5;21m▀${ESC}[0m`,
  )
})

test('to256 hits the cube ends exactly and routes greys through the 232..255 ramp', () => {
  assert.equal(to256(0, 0, 0), 16)
  assert.equal(to256(255, 255, 255), 231)
  assert.equal(to256(255, 0, 0), 196)
  assert.equal(to256(0, 0, 255), 21)

  const grey = to256(128, 128, 128)
  assert.ok(grey >= 232 && grey <= 255, `expected a ramp entry, got ${grey}`)
  // near-greys take the ramp too, saturated colors never do
  assert.ok(to256(130, 128, 126) >= 232)
  assert.ok(to256(200, 128, 60) < 232)

  assert.equal(to256(128, 128, 128), grey)
  assert.equal(to256(17, 92, 240), to256(17, 92, 240))
  assert.ok(Number.isInteger(to256(17, 92, 240)))
})

test('a placeholder is exactly rows rows of exactly cols cells', () => {
  for (const [cols, rows] of [
    [44, 22],
    [12, 3],
    [4, 2],
  ] as const) {
    const box = placeholderRows(cols, rows, 'no preview')
    assert.equal(box.length, rows)
    for (const row of box) assert.equal(row.length, cols)
    assert.equal(box[0]!.startsWith('╭'), true)
    assert.equal(box[rows - 1]!.endsWith('╯'), true)
  }
  assert.equal(placeholderRows(12, 3, 'kind')[1], '│   kind   │')
})

test('a label too wide for the box is truncated instead of widening it', () => {
  const box = placeholderRows(12, 5, 'a very long label indeed')
  for (const row of box) assert.equal(row.length, 12)
  const labelled = box.find(row => row.includes('…'))
  assert.equal(labelled, '│a very lo…│')
})

test('the source holds no raw control bytes — escapes are written as code points', () => {
  const source = fs.readFileSync(new URL('./blocks.ts', import.meta.url), 'utf8')
  const control = [...source].filter(char => char.codePointAt(0)! < 0x20 && char !== '\n' && char !== '\t')
  assert.deepEqual(control, [])
})
