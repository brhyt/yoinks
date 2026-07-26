/**
 * Terminal image rendering contracts.
 *
 * A moodboard that shows you filenames is not a moodboard, so this has to put
 * real pixels in a terminal — everywhere, without a native dependency.
 *
 * Half-block is the baseline and is not a consolation prize: `▀` with a
 * 24-bit foreground and background makes one cell two stacked pixels, and
 * because that's *just characters*, Ink lays it out like any other element and
 * the existing centring, resizing and theming keep working untouched. Graphics
 * protocols are exact but bypass Ink's diffing entirely, so they're confined to
 * the detail view.
 *
 * See docs/rendering.md.
 */

export type Protocol = 'kitty' | 'iterm' | 'blocks' | 'off'

export type Caps = {
  protocol: Protocol
  /** 24-bit color. Without it, half-blocks quantize to the 256-color cube. */
  truecolor: boolean
  /** why this protocol was chosen — surfaced by `pluck doctor` */
  reason: string
}

export type Rgb = {r: number; g: number; b: number}

/** A thumbnail's size in terminal cells. Pixels are cols × (rows*2). */
export type CellSize = {cols: number; rows: number}

/**
 * Cell height for an image drawn `cols` wide, preserving aspect.
 *
 * Terminal cells are roughly twice as tall as they are wide, and half-blocks
 * already halve vertical resolution, so the two effects cancel: a square image
 * is a square block of cells. Don't chase per-font cell ratios — it varies by
 * font, isn't queryable, and being 5% off is invisible.
 */
export function cellHeightFor(cols: number, width: number, height: number): number {
  if (!width || !height) return Math.max(1, Math.round(cols / 2))
  return Math.max(1, Math.round((cols * height) / width / 2))
}
