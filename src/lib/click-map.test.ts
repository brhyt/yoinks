import assert from 'node:assert/strict'
import test from 'node:test'
import {captureFrames, clickTargetAt, findFrameRow, frameRowSpan, type ClickTarget} from './click-map.js'

/** Feed lines through the same proxy ink writes to, so tests use the real path. */
function paint(lines: string[]): void {
  const sink = {write: () => true} as unknown as NodeJS.WriteStream
  captureFrames(sink).write(lines.join('\n'))
}

const hit = (targets: ClickTarget[], x: number, y: number) => clickTargetAt(x, y, targets)

test('a rectangle target is hit inside and missed outside', () => {
  const target: ClickTarget = {rect: [5, 3, 4, 2], action: () => {}}

  // corners of a 4x2 box at (5,3): x 5..8, y 3..4
  for (const [x, y] of [[5, 3], [8, 3], [5, 4], [8, 4], [6, 4]]) {
    assert.equal(hit([target], x!, y!), target, `expected a hit at ${x},${y}`)
  }
  for (const [x, y] of [[4, 3], [9, 3], [5, 2], [5, 5]]) {
    assert.equal(hit([target], x!, y!), undefined, `expected a miss at ${x},${y}`)
  }
})

test('a degenerate rectangle can never be hit', () => {
  assert.equal(hit([{rect: [5, 5, 0, 3], action: () => {}}], 5, 5), undefined)
  assert.equal(hit([{rect: [5, 5, 3, 0], action: () => {}}], 5, 5), undefined)
})

test('rectangles need no frame text — a grid of identical cells still resolves', () => {
  // every cell renders as the same half-block, which is exactly why text
  // matching cannot tell them apart
  paint(['▀▀▀▀▀▀▀▀', '▀▀▀▀▀▀▀▀'])
  const first: ClickTarget = {rect: [1, 1, 4, 2], action: () => {}}
  const second: ClickTarget = {rect: [5, 1, 4, 2], action: () => {}}

  assert.equal(hit([first, second], 2, 1), first)
  assert.equal(hit([first, second], 6, 2), second)
})

test('text targets still work alongside rectangles', () => {
  paint(['', '   pluck here', ''])
  const text: ClickTarget = {match: 'pluck here', action: () => {}}
  const rect: ClickTarget = {rect: [1, 3, 5, 1], action: () => {}}

  assert.equal(hit([text, rect], 5, 2), text)
  assert.equal(hit([text, rect], 3, 3), rect)
  assert.equal(hit([text, rect], 40, 2), undefined)
})

test('the first matching target wins', () => {
  const front: ClickTarget = {rect: [1, 1, 10, 10], action: () => {}}
  const behind: ClickTarget = {rect: [1, 1, 10, 10], action: () => {}}
  assert.equal(hit([front, behind], 5, 5), front)
})

test('an empty match string never swallows a click', () => {
  paint(['some text'])
  assert.equal(hit([{match: '', action: () => {}}], 3, 1), undefined)
})

test('padX widens a text target, padY reaches the rows around it', () => {
  paint(['', '  ok', ''])
  const padded: ClickTarget = {match: 'ok', padX: 2, padY: 1, action: () => {}}

  assert.equal(hit([padded], 3, 2), padded)
  assert.equal(hit([padded], 1, 2), padded) // two cells left of 'ok' at column 3
  assert.equal(hit([padded], 3, 1), padded) // the row above
  assert.equal(hit([padded], 3, 3), padded) // and below
})

test('colors are stripped before matching', () => {
  paint(['[38;2;255;0;0m  pluck  [0m'])
  const target: ClickTarget = {match: 'pluck', action: () => {}}
  assert.equal(hit([target], 4, 1), target)
})

test('frame helpers read the last painted frame', () => {
  paint(['first', '   second   ', 'third'])
  assert.equal(findFrameRow('second'), 1)
  assert.equal(findFrameRow('nowhere'), -1)
  // 1-based first printable column, through the last — trailing space excluded
  assert.deepEqual(frameRowSpan(1), [4, 9])
  assert.equal(frameRowSpan(99), undefined)
})

test('a cursor-only write does not clobber the frame', () => {
  paint(['real content'])
  const sink = {write: () => true} as unknown as NodeJS.WriteStream
  captureFrames(sink).write('[?25l') // hide cursor, no printable text
  assert.equal(findFrameRow('real content'), 0)
})
