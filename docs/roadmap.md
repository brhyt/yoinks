# Roadmap

Status keys: ✅ shipped · 🚧 building · ⬜ planned

Published today: **0.3.1** — video capture only. Everything from M1 onward
is unbuilt.

## Shipped — 0.1 → 0.3.1 ✅

- Video and audio capture via yt-dlp, 1,800+ sites
- Resolution picker with estimated file sizes, audio-only mp3
- Standalone yt-dlp bootstrap to `~/.yoinks/bin` — no Python
- ffmpeg resolution: `PATH`, then bundled `ffmpeg-static`
- Full-screen Ink UI on the alternate screen, scrollback restored on exit
- Terminal-aware `auto` / `light` / `dark` themes, `^t` to cycle
- Mouse: clickable button, picker rows, footer hints, logo
- Clipboard offer on launch, url history in the input
- Cancel with `esc` at any phase, partial files cleaned up
- Published to npm

## M1 — Extractor registry 🚧

The refactor that makes everything else possible. **No visible change.**

- [ ] Regression lock: yt-dlp `-J` fixture → picker rows byte-identical to 0.3.1
- [ ] `Candidate` / `Extractor` contracts
- [ ] `classify.ts` — HEAD → content-type → fan-out plan
- [ ] Existing yt-dlp logic rehomed behind the contract
- [ ] `direct` extractor
- [ ] `page` extractor — `og:image`, `twitter:image`, `srcset`, `@font-face`, css color vars
- [ ] Fan-out with tiering, streaming merge, stable ordering
- [ ] Picker cursor tracks candidate key, not index

**Done when:** `yoinks <youtube-url>` is indistinguishable from 0.3.1, and
`yoinks <dribbble-url>` lists images in the picker.

Risks: `page` needs `node-html-parser` (~40 KB, pure JS) plus a response
size cap and redirect limit. Streaming into the picker is where the ordering
bugs live — the test for "late candidate doesn't move the cursor" is worth
writing before the feature.

## M2 — The library ⬜

Capture stops being a download.

- [ ] `$YOINKS_HOME` resolution, legacy-path fallback
- [ ] Content-addressed blob store
- [ ] `items.jsonl` append + replay + tombstones
- [ ] Ingest: hash → dedupe → blob + item
- [ ] Boards and tags
- [ ] `derive.ts` — dims, palette (median cut), font names
- [ ] Always-resolvable ffmpeg sibling to `findFfmpeg()`
- [ ] `compact`

**Done when:** capturing twice writes one blob and two items, and the whole
library survives `rm -rf cache/`.

## M3 — Seeing it ⬜

The milestone that makes it a moodboard. Highest risk, so prove thumbnail
quality early — if a 44×22 half-block thumbnail isn't recognizable, the
browse half of the product needs rethinking, and that's worth finding out
before M4 exists.

- [ ] ffmpeg → raw rgb24 decode pipe
- [ ] Half-block renderer, truecolor + 256-color fallback
- [ ] Capability detection, `yoinks doctor`
- [ ] Thumbnail cache, warmed at ingest
- [ ] Rect click targets in `click-map.ts`
- [ ] `library` phase — grid, `/` search, multi-select
- [ ] `detail` phase — large preview, palette swatches, copy hex
- [ ] `boards` phase
- [ ] Kitty + iTerm2 protocols in detail view

## M4 — Headless ⬜

- [ ] `--json` envelope, exit codes, closed error-code set
- [ ] Non-TTY auto-detection
- [ ] `capture`, `find`, `show`, `boards`, `tag`, `mv`, `note`, `rm`
- [ ] `find --color` nearest-palette ranking
- [ ] Store and query tests against a temp `YOINKS_HOME`

## M5 — Agents ⬜

The reason for all of it.

- [ ] `brief` — palette fusion, roles, type ranking, notes, paths
- [ ] `brief --md`, `--no-paths`, `--no-notes`
- [ ] `SKILL.md` + `yoinks skill install` / `print`
- [ ] `yoinks mcp` — search, brief, get, list_boards, capture
- [ ] Docs pass against the real implementation

## M6 — Portable ⬜

- [ ] `export` / `import` bundles
- [ ] `import --dry-run`
- [ ] Naming decision, and the home-directory migration if it changes

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
| **Name** | `yoinks` may not survive the scope change. Docs use it as one token; a rename is find/replace plus the home-directory fallback in [asset-model.md](asset-model.md#home-directory). |
| **Tagline** | Unwritten. The old line is too narrow. |
| **`~/Downloads`** | v1.0 keeps writing video there *and* to the library, since that's what current users installed the tool for. Revisit once the library is real. |
| **Sixel** | Deferred, possibly permanently. |

## Principles

Worth restating whenever a decision gets hard:

1. **Don't break the shipped product.** People installed a video downloader.
   It keeps working, exactly, forever.
2. **The library is plain files.** Greppable, backup-able, rebuildable. No
   database, no lock-in, no format only yoinks can read.
3. **Derivation never blocks capture.** Missing ffmpeg costs you a
   thumbnail, not the asset.
4. **Local by default.** No account, no telemetry. The only egress is what
   you explicitly ask for.
5. **Agents read, capture, and nothing else.** No deleting, no
   reorganizing.
6. **Degrade, don't fail.** Every rendering path has a next step down, and
   the bottom of the ladder is still useful.
