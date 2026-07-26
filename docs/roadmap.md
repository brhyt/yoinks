# Roadmap

Status keys: ✅ shipped · 🚧 building · ⬜ planned

Published today: **0.3.1** — video capture only. M1–M5 are built on the
`terminal-inspiration-capture` branch and unreleased; M6 is in progress.

## Shipped — 0.1 → 0.3.1 ✅

- Video and audio capture via yt-dlp, 1,800+ sites
- Resolution picker with estimated file sizes, audio-only mp3
- Standalone yt-dlp bootstrap to `~/.pluck/bin` — no Python
- ffmpeg resolution: `PATH`, then bundled `ffmpeg-static`
- Full-screen Ink UI on the alternate screen, scrollback restored on exit
- Terminal-aware `auto` / `light` / `dark` themes, `^t` to cycle
- Mouse: clickable button, picker rows, footer hints, logo
- Clipboard offer on launch, url history in the input
- Cancel with `esc` at any phase, partial files cleaned up
- Published to npm

## M1 — Extractor registry ✅

The refactor that makes everything else possible. **No visible change.**

- [x] Regression lock: yt-dlp `-J` fixture → picker rows byte-identical to 0.3.1
- [x] `Candidate` / `Extractor` contracts
- [x] `classify.ts` — HEAD → content-type → fan-out plan
- [x] Existing yt-dlp logic rehomed behind the contract
- [x] `direct` extractor
- [x] `page` extractor — `og:image`, `twitter:image`, `srcset`, `@font-face`, css color vars
- [x] Fan-out with tiering, streaming merge, stable ordering
- [x] Picker cursor tracks candidate key, not index

**Done when:** `pluck <youtube-url>` is indistinguishable from 0.3.1, and
`pluck <dribbble-url>` lists images in the picker.

`page` ended up with **zero** dependencies — the html parsing is hand-rolled
string scanning with quote tracking, since `<img[^>]*>` breaks on attribute
values containing `>`. Response size and redirect depth are capped in
`classify.ts` and `fetch-file.ts`.

## M2 — The library ✅

Capture stops being a download.

- [x] `$PLUCK_HOME` resolution, legacy-path fallback
- [x] Content-addressed blob store
- [x] `items.jsonl` append + replay + tombstones
- [x] Ingest: hash → dedupe → blob + item
- [x] Boards and tags
- [x] `derive.ts` — dims, duration, palette (median cut)
- [ ] font-family observation — the `BlobMeta.fonts` slot exists, nothing fills it ⬜
- [x] Always-resolvable ffmpeg sibling to `findFfmpeg()`
- [x] `compact`

**Done when:** capturing twice writes one blob and two items, and the whole
library survives `rm -rf cache/`.

## M3 — Seeing it ✅

The milestone that makes it a moodboard. Highest risk, so prove thumbnail
quality early — if a 44×22 half-block thumbnail isn't recognizable, the
browse half of the product needs rethinking, and that's worth finding out
before M4 exists.

- [x] ffmpeg → raw rgb24 decode pipe
- [x] Half-block renderer, truecolor + 256-color fallback
- [x] Capability detection, `pluck doctor`
- [x] Thumbnail cache, warmed at ingest
- [x] Rect click targets in `click-map.ts`
- [x] `library` phase — grid, `/` search, multi-select
- [x] `detail` phase — large preview, palette swatches, copy hex
- [x] `boards` phase
- [ ] Kitty + iTerm2 protocols in detail view ⬜ (half-block ships; protocols deferred)

## M4 — Headless ✅

- [x] `--json` envelope, exit codes, closed error-code set
- [x] Non-TTY auto-detection
- [x] `capture`, `find`, `show`, `boards`, `tag`, `mv`, `note`, `rm`
- [x] `find --color` nearest-palette ranking
- [x] Store and query tests against a temp `PLUCK_HOME`

## M5 — Agents ✅

The reason for all of it.

- [x] `brief` — palette fusion, roles, type ranking, notes, paths
- [x] `brief --md`, `--no-paths`, `--no-notes`
- [x] `SKILL.md` + `pluck skill install` / `print`
- [x] `pluck mcp` — search, brief, get, list_boards, capture
- [x] Docs pass against the real implementation

## M6 — Portable 🚧

- [x] `export` / `import` bundles
- [x] `import --dry-run`
- [ ] Naming decision, and the home-directory migration if it changes

## Known gaps in what's built

- `type.families` in a brief is always empty — nothing populates
  `BlobMeta.fonts` yet. See [agents.md](agents.md#computation).
- `compact` collapses the log but does not collect orphan blobs, so it
  reclaims lines, not disk.
- The library's detail view is read-only: `t`, `c`, `o`, `x` and multi-select
  from the [cli.md](cli.md) keymap need store mutations that aren't wired.
- No row cap on the picker. 146 rows from a dense portfolio is scrollable;
  an 800-product listing page would not be.
- `capture --shot` is rejected rather than accepted-and-ignored, because the
  `shot` extractor doesn't exist yet.

## Later

Not scheduled, roughly in order of how often they'll get asked for.

- Sync across machines — the model is already built for it
  ([asset-model.md](asset-model.md#designed-for-sync)); this is transport
- `shot` extractor via local headless Chrome
- Playlists and multi-video threads
- `--best` / `--mp3` fast paths, `-o <dir>` (carried from the 0.x roadmap)
- Self-update for the bundled yt-dlp
- `curl … | sh` installer
- Snippet and code-block capture
- Figma file and frame extraction
- Sixel
- Similarity search — "more like this one"

## Open decisions

| | |
|---|---|
| **Name** | `pluck` may not survive the scope change. Docs use it as one token; a rename is find/replace plus the home-directory fallback in [asset-model.md](asset-model.md#home-directory). |
| **Tagline** | Unwritten. The old line is too narrow. |
| **`~/Downloads`** | v1.0 keeps writing video there *and* to the library, since that's what current users installed the tool for. Revisit once the library is real. |
| **Sixel** | Deferred, possibly permanently. |

## Principles

Worth restating whenever a decision gets hard:

1. **Don't break the shipped product.** People installed a video downloader.
   It keeps working, exactly, forever.
2. **The library is plain files.** Greppable, backup-able, rebuildable. No
   database, no lock-in, no format only pluck can read.
3. **Derivation never blocks capture.** Missing ffmpeg costs you a
   thumbnail, not the asset.
4. **Local by default.** No account, no telemetry. The only egress is what
   you explicitly ask for.
5. **Agents read, capture, and nothing else.** No deleting, no
   reorganizing.
6. **Degrade, don't fail.** Every rendering path has a next step down, and
   the bottom of the ladder is still useful.
