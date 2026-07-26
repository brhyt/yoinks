# Architecture

> Target state for v1.0. Status keys: ✅ shipped in 0.3.1 · 🚧 building · ⬜ planned.
> Sequencing in [roadmap.md](roadmap.md).

## The loop

Everything is one pipeline. The shipped video downloader is this pipeline
with exactly one extractor and no store.

```
  url
   │
   ├─ classify ──── HEAD request → content-type            ⬜
   │
   ├─ probe ─────── fan out across matching extractors     ⬜
   │                 candidates stream back as they land
   │
   ├─ pick ──────── one picker screen, grouped by kind     ✅ (video only)
   │
   ├─ fetch ─────── bytes to a temp file, progress events  ✅
   │
   ├─ ingest ────── hash → dedupe → blob + item record     ⬜
   │
   └─ derive ────── palette, dims, thumbnail, font names   ⬜
                     cached in the blob's meta.json
```

Two properties worth protecting as this grows:

**Ingest is idempotent.** Capture is content-addressed, so plucking the same
image twice costs one hash and writes nothing new. This matters more than it
sounds — it's what makes an agent safe to point at a list of urls.

**Derive is resumable.** Nothing in `derive` is required for a capture to be
considered complete. If ffmpeg is missing or the palette pass crashes, the
asset is still in your library; the derivation runs next time. Never let a
nice-to-have block the thing the user asked for. (The shipped code already
takes this line — see the comment in [`history.ts`](../src/lib/history.ts).)

## Extractors

### Contract

```ts
export type Kind = 'image' | 'video' | 'audio' | 'font' | 'page' | 'palette' | 'snippet'

export type Candidate = {
  /** stable within one probe, so the picker cursor survives late arrivals */
  key: string
  kind: Kind
  label: string                 // what the picker row reads
  extractor: ExtractorKey       // 'direct' | 'page' | 'ytdlp' | 'shot'
  /** how to actually get the bytes, once chosen */
  fetch: (ctx: FetchContext, signal?: AbortSignal) => Promise<Fetched>
  /** best-effort, for the label and for meta before the bytes land */
  hint?: {bytes?: number; width?: number; height?: number; duration?: number; mime?: string}
  /** ordering within a kind — higher first */
  score?: number
}

export type Extractor = {
  key: ExtractorKey
  tier: 'always' | 'signal' | 'demand'
  matches: (url: URL, probe: Classification) => boolean
  probe: (url: string, signal?: AbortSignal) => AsyncIterable<Candidate>
}
```

`probe` is an async iterable rather than returning an array so a slow
extractor can yield its first candidate immediately. The page extractor
yields the `og:image` before it finishes parsing stylesheets for fonts.

### Tiers

Cost, not capability, decides when an extractor runs.

| Tier | When | Extractors | Budget |
|---|---|---|---|
| `always` | every paste | `direct`, `page` | < 1s |
| `signal` | url host matches, or classification found a hint (`og:video`) | `ytdlp` | 1–3s |
| `demand` | only when the user selects its picker row | `shot` | 2–5s |

`demand` extractors still contribute a row to the picker — they just do the
work on selection. This is why `Candidate.fetch` is a closure and not a url:
a screenshot candidate has nothing to point at until someone asks for it.

### Classification

One HEAD request decides the shape of the fan-out.

| `content-type` | Fan-out |
|---|---|
| `image/*`, `font/*`, `audio/*` | `direct` only — done in ~200ms |
| `video/*` | `direct` + `ytdlp` |
| `text/html` | `page` always; `ytdlp` if the host is known-video or the page exposes `og:video`; `shot` offered on demand |
| anything else / HEAD refused | fall through to a GET with a byte cap and sniff |

Sniffing from the file extension is a trap — plenty of image CDNs serve
`.php` and plenty of `.jpg` urls are html landing pages. One HEAD is cheaper
than the class of bug that follows from guessing.

### Merge and ordering

Candidates from all extractors land in one list. Rules:

1. **Dedupe on resolved url** before the bytes are fetched. The page
   extractor's `og:image` and its largest `srcset` entry are often the same
   file.
2. **Fixed kind order** — `image, video, audio, font, palette, page,
   snippet`. Within a kind, sort by `score` descending, then `key`. Rows
   must never reshuffle as late candidates arrive.
3. **Cursor tracks `key`, not index.** The picker holds a selected key and
   resolves it to a row each render. Today [`app.tsx`](../src/app.tsx) keeps
   `highlightRef` as a numeric index — fine when the list is built once,
   wrong the moment it streams.
4. **Empty is a real outcome.** A page with nothing pluckable gets an empty
   picker with an explanation, not an error screen.

## Phases

The state machine in [`app.tsx`](../src/app.tsx) extends rather than changes
shape.

```
                ┌──────────────────────────────────────┐
                ▼                                      │
  input ──▶ probing ──▶ picking ──▶ capturing ──▶ done ─┘
    ▲          │           │            │          │
    │          └───────────┴────────────┴──────────┘
    │                    esc / error
    │
    └──▶ library ──▶ detail
             │  ▲       │
             └──┴───────┘
                boards
```

New phases: `library`, `detail`, `boards`. Renamed: `downloading` →
`capturing`, since it now covers multi-asset captures.

`library` is reachable from `input` (`l`, or `pluck lib`) and from `done` —
finishing a capture should offer to show you where it landed.

## Rendering

Covered in depth in [rendering.md](rendering.md). The architectural
consequences:

**Thumbnails are just text.** The half-block fallback emits `▀` with a
24-bit foreground and background per cell, so Ink lays a thumbnail out like
any other element and the existing centering, resizing and theming all keep
working unmodified.

**Graphics protocols bypass Ink.** Kitty and iTerm2 image escapes have to be
written at an absolute cursor position and are not part of Ink's diffable
output. The detail view reserves a `Box` of known cell dimensions, and a
post-render effect writes the escape into that rectangle. Consequence: that
rectangle is invisible to frame-text hit-testing, so it needs an explicit
click rect.

**Click targets need rectangles.** [`click-map.ts`](../src/lib/click-map.ts)
finds targets by matching text in the last rendered frame — elegant, and it
cannot work for a grid of identical `▀` cells. Add a second variant:

```ts
export type ClickTarget =
  | {match: string; action: () => void; padX?: number; padY?: number}
  | {rect: [x: number, y: number, w: number, h: number]; action: () => void}
```

The grid component knows its own cell geometry and registers rects each
render. Text matching stays the default everywhere else — it earned its
place, and the comment at the top of that file explains why.

## Processes and concurrency

pluck shells out rather than binding native code. Current and planned
children:

| Binary | Used for | Resolution |
|---|---|---|
| `yt-dlp` | video probe and fetch | `PATH`, then `$PLUCK_HOME/bin`, then fetch the standalone release ✅ |
| `ffmpeg` | stream merge, mp3 extract ✅ · image decode, resize, frame grab ⬜ | `PATH`, then bundled `ffmpeg-static` ✅ |
| `chrome` / `chromium` | full-page screenshots ⬜ | well-known install paths, then `PATH`; absent is fine, the `shot` row just doesn't appear |

One correction needed to reuse the existing resolver: `findFfmpeg()` in
[`ytdlp.ts`](../src/lib/ytdlp.ts) returns `undefined` when ffmpeg is on
`PATH`, deliberately — it's telling yt-dlp to find its own. The thumbnailer
needs a command it can actually spawn, so it wants a sibling that always
resolves to a runnable path.

Concurrency limits: at most **4** concurrent extractor probes, **2**
concurrent fetches, **1** derivation worker. The point of the caps isn't
machine load, it's that a paste which spawns eight processes makes the whole
terminal feel unwell.

Every spawn takes an `AbortSignal` and every phase that spawns is
cancellable with `esc`. The shipped download path already cleans up partial
files on cancel — hold that line for captures.

## Module layout

```
src/
  cli.tsx              entry: arg parse, tty branch, headless dispatch
  app.tsx              phase machine, screen composition
  theme.ts             ✅

  components/          ✅ fullscreen, panel, framed-input, logo,
                       shortcuts, text-input, progress-bar
    grid.tsx           ⬜ thumbnail grid
    thumb.tsx          ⬜ one image, protocol-aware
    swatch.tsx         ⬜ palette chip

  lib/
    click-map.ts       ✅ + rect targets ⬜
    format.ts          ✅
    platforms.ts       ✅
    clipboard.ts       ✅
    use-mouse-click.ts ✅

    extract/
      types.ts         Candidate, Extractor, contracts
      classify.ts      HEAD → content-type → fan-out plan
      index.ts         tiering, fan-out, merge, stream
      direct.ts
      page.ts
      ytdlp.ts         ✅ logic, rehomed behind the contract
      shot.ts

    store/
      paths.ts         $PLUCK_HOME resolution, migration
      ingest.ts        hash, dedupe, write blob + item
      log.ts           items.jsonl append + replay
      query.ts         search, filter, rank
      derive.ts        palette, dims, fonts
      export.ts        bundle in/out

    render/
      caps.ts          graphics protocol detection
      decode.ts        ffmpeg → raw rgb24
      blocks.ts        rgb → half-block rows
      kitty.ts
      iterm.ts

    agent/
      json.ts          response envelope
      brief.ts         the synthesis pass
      mcp.ts           stdio server
```

`lib/store` and `lib/agent` have no Ink or React imports, ever. That
boundary is what lets the headless commands run without a terminal and keeps
the MCP server from dragging a UI framework into a stdio process.

## Testing

The shipped suite is `tsx --test` over `src/**/*.test.ts`
([args.test.ts](../src/lib/args.test.ts),
[panel.test.ts](../src/components/panel.test.ts)). Extend along the same
lines — no new framework.

The one test that matters most is a **regression lock on video capture**: a
fixture of yt-dlp `-J` output through `classify → probe → merge`, asserting
the picker rows come out byte-identical to what 0.3.1 produces. It should
land in the first PR, before any refactoring, because "I accidentally broke
the shipped product while adding features" is the only genuinely expensive
failure mode here.

Beyond that: pure functions get unit tests (`blocks.ts`, `log.ts` replay,
`query.ts` ranking, `classify.ts` decisions), the store gets tests against a
temp `PLUCK_HOME`, and extractors get tests against saved html fixtures so
the suite never touches the network.
