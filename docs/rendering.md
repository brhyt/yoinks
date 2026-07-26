# Rendering

> Target state for v1.0. Status: ⬜ planned throughout — none of this exists in 0.3.1.

A moodboard that shows you filenames is not a moodboard. This document is
how pluck puts actual pixels in a terminal, everywhere, without a native
dependency.

## Two paths

| | Cells | Quality | Works in |
|---|---|---|---|
| **Half-block** | 1 char = 1×2 px, 24-bit color | good enough for a grid | everywhere with truecolor |
| **Graphics protocol** | true pixel addressing | exact | Kitty, Ghostty, WezTerm, iTerm2 |

Half-block is the baseline and gets built first. It is not a consolation
prize — at grid sizes the difference is small, and it composes with Ink's
layout in a way graphics escapes fundamentally cannot.

## Half-block

### The trick

`▀` (U+2580, upper half block) fills the top half of a cell with the
foreground color and leaves the bottom half showing the background. Set both
and one character becomes two independently-colored pixels stacked
vertically.

```
cell (col, row)  →  pixel (col, row*2)     as foreground
                    pixel (col, row*2 + 1) as background
```

A thumbnail `W` cells wide by `H` cells tall is a `W × 2H` pixel image.
At 44×22 cells that's 44×44 px — small, but a designer recognizes their own
reference at 44×44, which is the entire requirement.

### Aspect ratio

Terminal cells are roughly twice as tall as they are wide, and half-blocks
already halve vertical resolution, so the two effects cancel and a square
image is a square cell block:

```
cellsH = round(cellsW * imgH / imgW / 2)
```

Do not try to correct for per-font cell ratios. It varies by font, it isn't
queryable, and being off by 5% is invisible while the code to chase it is
not.

### Emitting

Build each row as one pre-composed ANSI string rather than one Ink `<Text>`
per cell — a 44×22 grid cell is 968 nodes otherwise, times however many
thumbnails are on screen, and Ink's reconciler will feel every one of them.

```ts
// one row of the thumbnail
let row = ''
for (let x = 0; x < w; x++) {
  const top = px(x, y * 2)
  const bot = px(x, y * 2 + 1)
  row += `\x1b[38;2;${top.r};${top.g};${top.b}m\x1b[48;2;${bot.r};${bot.g};${bot.b}m▀`
}
row += '\x1b[0m'
```

Then one `<Text>` per row, `H` rows per thumbnail. Ink passes the escapes
through, and `string-width` measures the printable width correctly.

This also keeps [`click-map.ts`](../src/lib/click-map.ts) honest — its
`stripAnsi` reduces each row to `W` copies of `▀`, which is *unmatchable
text but correct geometry*. That's why the grid registers rectangle click
targets instead (see [architecture.md](architecture.md#rendering)).

### Odd rows

An image with an odd pixel height leaves the final row with no bottom pixel.
Use `▀` with the background set to the theme background, not to the last
row's color — repeating a row to fill reads as a rendering bug.

### When there's no truecolor

`$COLORTERM` is `truecolor` or `24bit` on essentially every modern terminal.
When it isn't, quantize to the 256-color cube (16 + 36r + 6g + b) and emit
`38;5;n` / `48;5;n`. Thumbnails get muddy but stay legible.

Under `NO_COLOR`, don't render a gray mush — draw a bordered placeholder
with the kind glyph and the title. Respecting `NO_COLOR` means respecting
what the person meant by it.

## Graphics protocols

Used for the detail view only. In a grid, the per-image escape overhead and
the redraw-on-scroll cost outweigh the fidelity gain.

### Kitty

```
\x1b_Ga=T,f=32,s=<px_w>,v=<px_h>,c=<cols>,r=<rows>;<base64 rgba>\x1b\\
```

Payload chunked to 4096 bytes with `m=1` on all but the last chunk.
Supported by Kitty, Ghostty and WezTerm.

### iTerm2

```
\x1b]1337;File=inline=1;width=<cols>;height=<rows>;preserveAspectRatio=1:<base64 file>\x07
```

Takes the original encoded file, not raw pixels — so it skips the decode
step entirely.

### Sixel

Deferred. Wide terminal support on paper, inconsistent palette handling in
practice, and it's the most code for the least gain given half-block already
covers the same terminals acceptably. Revisit if people ask.

### Placement

Graphics escapes are written at the cursor's current position and are not
part of Ink's diffable output. The detail view therefore:

1. renders a `<Box>` of known `width`/`height` as a reserved hole,
2. in a layout effect, saves the cursor, moves to that box's top-left,
   writes the escape, restores the cursor,
3. re-writes on every frame where the box's geometry or the image changed.

Everything about that is more fragile than half-blocks. It's confined to one
screen for exactly that reason, and `PLUCK_GRAPHICS=blocks` turns it off.

## Detection

```
PLUCK_GRAPHICS  set?          → obey it, no detection
TERM_PROGRAM = iTerm.app       → iterm
TERM_PROGRAM = ghostty|WezTerm → kitty
KITTY_WINDOW_ID set            → kitty
TERM contains kitty            → kitty
inside tmux or screen          → blocks, unless allow-passthrough is on
otherwise                      → blocks
```

Two practical notes that cost real debugging time otherwise:

- **Over ssh**, `TERM` survives but `TERM_PROGRAM` usually does not. Kitty
  and Ghostty still get detected via `TERM`/`KITTY_WINDOW_ID`; iTerm2 falls
  back to half-blocks. Acceptable, and `PLUCK_GRAPHICS=iterm` is the
  override.
- **Inside tmux**, graphics escapes need passthrough wrapping and are
  clipped wrong on pane resize. Default to blocks and let people opt in.

`pluck doctor` prints what was detected and why — the fastest answer to
"why do my thumbnails look chunky."

## Decoding, with no native dependency

pluck already ships `ffmpeg-static` and resolves ffmpeg in
[`ytdlp.ts`](../src/lib/ytdlp.ts). ffmpeg decodes PNG, JPEG, WebP, GIF, AVIF
and every video format yt-dlp can produce, resizes, and writes raw pixels to
stdout — which is precisely a thumbnail pipeline, already in the dependency
tree.

```sh
ffmpeg -v error -i <input> \
  -vf "scale=W:H:force_original_aspect_ratio=decrease,\
       pad=W:H:(ow-iw)/2:(oh-ih)/2:color=0x000000" \
  -frames:v 1 -f rawvideo -pix_fmt rgb24 -
```

`W = cells`, `H = cells * 2`. Output is exactly `W * H * 3` bytes, indexed
`(y * W + x) * 3`. Video gets `-ss 00:00:01` before `-i` to skip past black
opening frames.

This avoids `sharp` (native, prebuilt-binary matrix, install weight) and
`jimp` (pure JS but slow and format-limited), and it means the image path
and the video path share one binary.

**One fix required.** `findFfmpeg()` returns `undefined` when ffmpeg is on
`PATH` — deliberate, it's telling yt-dlp to resolve its own. The thumbnailer
needs something it can spawn, so it needs a sibling that always returns a
runnable command.

**When ffmpeg is missing entirely**, thumbnails degrade to the bordered
placeholder. The library still works. Nothing about browsing your own
references should hard-depend on a media toolchain.

## Palette extraction

Same pipe, smaller output: `scale=64:64`, giving 4096 pixels.

**Median cut**, not k-means. Sort the pixel set on its widest channel, split
at the median, recurse to 8 buckets, average each. Deterministic — the same
bytes always produce the same palette — which matters because `meta.json` is
supposed to be reproducible from the blob. K-means with random
initialization would make derived data non-reproducible for no visible gain.

Post-processing:

- Merge buckets within ΔE < 5 of each other, sum their weights.
- Drop buckets under 1% weight unless they're the most chromatic — a 2%
  accent color is usually the most important color in a design reference and
  the last one a naive frequency sort would keep.
- `weight` is the fraction of sampled pixels, so palettes sum across a board.
  That's the arithmetic behind [`pluck brief`](agents.md#brief).

Roles are assigned heuristically for the brief: the highest-weight color at
an extreme luminance is `background`, the highest-contrast color against it
is `text`, and the most chromatic low-weight color is `accent`. Everything
else stays unlabeled. The heuristic is honest about being one — a role is a
hint to a consumer, never a claim.

## Caching

```
cache/thumbs/<sha256>-<w>x<h>.rgb    raw rgb24, cell dimensions in the name
```

Raw rather than PNG: no decode on read, and a 44×22 thumbnail is 5.8 KB.
Warm the two or three sizes the grid actually uses at ingest time, so the
first `pluck lib` after a capture is instant.

The whole `cache/` tree is regenerable and is the only thing pluck deletes
without being asked.

## Performance budget

A 6×4 grid is 24 thumbnails. Targets:

| | |
|---|---|
| cold decode, one image | < 80 ms |
| warm grid, 24 cached thumbs | < 16 ms to compose |
| scroll frame | < 16 ms |
| detail view, protocol path | < 120 ms |

The one that bites is scroll: recomposing 24 ANSI strings per frame is
wasteful, so cache the composed row strings keyed on
`(sha256, w, h, protocol)` and invalidate only on resize. String
concatenation is not the bottleneck people assume, but doing it 500 times
per keypress will be.

## Degradation ladder

Every step down is still a usable product:

```
kitty / iterm2   exact pixels
   ↓ no protocol
half-block       24-bit, 1×2 px per cell
   ↓ no truecolor
256-color        muddy but legible
   ↓ NO_COLOR / no ffmpeg
placeholder      bordered box, kind glyph, title
   ↓ not a tty
json             paths and metadata — which is what agents wanted anyway
```
