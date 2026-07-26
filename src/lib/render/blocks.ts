/**
 * Half-block thumbnails. `▀` with both a foreground and a background color
 * turns one cell into two stacked pixels, so a `cols × rows` thumbnail is a
 * `cols × rows*2` image. See docs/rendering.md.
 */

import {truncate} from '../format.js'
import type {Rgb} from './types.js'

/**
 * Built from a code point rather than typed as a literal control byte. Raw
 * escapes in source have twice gone unnoticed through review here; written
 * this way the escape is something a reviewer can actually see.
 */
const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`

/** U+2580, upper half block. */
const UPPER_HALF = '▀'

const BLACK: Rgb = {r: 0, g: 0, b: 0}

/**
 * One pre-composed ANSI string per terminal row.
 *
 * Rows are strings, not arrays of cells: at 44×22 that would be 968 Ink nodes
 * per thumbnail and the reconciler feels every one of them.
 */
export function renderBlocks(
  rgb: Buffer,
  cols: number,
  rows: number,
  opts: {truecolor?: boolean; background?: Rgb} = {},
): string[] {
  if (cols <= 0 || rows <= 0) return []
  const stride = cols * 3
  const full = stride * rows * 2
  // an odd-height image is short exactly the last row's bottom pixels
  if (rgb.length !== full && rgb.length !== full - stride) return []

  const truecolor = opts.truecolor ?? true
  const background = opts.background ?? BLACK
  const composed: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      const top = y * 2 * stride + x * 3
      const bottom = top + stride
      line += sgr(38, rgb[top], rgb[top + 1], rgb[top + 2], truecolor)
      line +=
        bottom + 2 < rgb.length
          ? sgr(48, rgb[bottom], rgb[bottom + 1], rgb[bottom + 2], truecolor)
          : sgr(48, background.r, background.g, background.b, truecolor)
      line += UPPER_HALF
    }
    composed.push(line + RESET)
  }
  return composed
}

/** One SGR color escape. `layer` is 38 for foreground, 48 for background. */
function sgr(layer: 38 | 48, r: number, g: number, b: number, truecolor: boolean): string {
  return truecolor ? `${ESC}[${layer};2;${r};${g};${b}m` : `${ESC}[${layer};5;${to256(r, g, b)}m`
}

/** Widest spread across channels that still counts as grey. */
const GREY_SPREAD = 6

/** Nearest xterm-256 cube index for an rgb triple. */
export function to256(r: number, g: number, b: number): number {
  const red = channel(r)
  const green = channel(g)
  const blue = channel(b)
  if (Math.max(red, green, blue) - Math.min(red, green, blue) <= GREY_SPREAD) {
    // the cube's own greys step by 51, which turns any gradient into bands;
    // the 24-entry ramp exists precisely because that looks broken
    const level = Math.round((red + green + blue) / 3)
    if (level < 8) return 16
    if (level > 246) return 231
    return 232 + Math.min(23, Math.round((level - 8) / 10))
  }
  return 16 + 36 * cube(red) + 6 * cube(green) + cube(blue)
}

const cube = (value: number) => Math.round((value / 255) * 5)

function channel(value: number): number {
  return Number.isFinite(value) ? Math.min(255, Math.max(0, Math.round(value))) : 0
}

/**
 * A bordered placeholder for when there are no pixels to show — no ffmpeg,
 * `NO_COLOR`, or a kind that never had an image.
 */
export function placeholderRows(cols: number, rows: number, label: string): string[] {
  if (rows <= 0 || cols <= 0) return []
  // too small for two corners and two sides, so there is no box to draw
  if (cols < 2 || rows < 2) return Array.from({length: rows}, () => '─'.repeat(cols))

  const inner = cols - 2
  const text = inner > 0 ? truncate(label, inner) : ''
  const left = Math.floor((inner - text.length) / 2)
  const centred = `${' '.repeat(left)}${text}${' '.repeat(inner - left - text.length)}`
  const bar = '─'.repeat(inner)

  const labelRow = Math.floor((rows - 1) / 2)
  return Array.from({length: rows}, (_unused, y) => {
    if (y === 0) return `╭${bar}╮`
    if (y === rows - 1) return `╰${bar}╯`
    return `│${y === labelRow ? centred : ' '.repeat(inner)}│`
  })
}
