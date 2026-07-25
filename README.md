# yoinks

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="yoinks" width="288">
</picture>

> **TAGLINE: TODO** — the positioning line is still open. The old one
> (“yoink any video. paste. yoink. done.”) is too narrow for what this
> becomes.

> **NAME: TODO** — `yoinks` is the working name. Docs use it as a single
> token throughout so a rename is a find/replace plus the home-directory
> migration described in [docs/asset-model.md](docs/asset-model.md#home-directory).

Capture inspiration from anywhere on the web, keep it in a library you own,
browse it without leaving your terminal — and hand it to your coding agents
so what they build actually looks like your taste.

---

> **Status.** This README describes **v1.0**. The published CLI is **0.3.1**,
> which does video downloads only. Everything below is marked:
>
> | | |
> |---|---|
> | ✅ | shipped in 0.3.1 |
> | 🚧 | building now |
> | ⬜ | planned |
>
> Full sequencing in [docs/roadmap.md](docs/roadmap.md).

---

## What it is

Three things that add up to one loop.

**Capture.** Paste any url. yoinks fans out across every extractor that
matches it and shows you everything it found — images, video, fonts, the
page itself — in one picker. Pick what you want. It lands in your library
with its source, its palette, and its dimensions already worked out.

**Browse.** Your library renders *in the terminal*. Actual thumbnails, not
filenames. Arrow keys or `hjkl`, `/` to search, enter for a full-size
preview with the palette as swatches you can copy.

**Brief.** Ask for a design brief on any slice of your library and get back
weighted palettes, type families, layout notes — and absolute file paths to
the references. That last part is what agents use.

## Install

```sh
npm install -g yoinks
```

Or without installing anything:

```sh
npx yoinks
```

Node 18+. Everything else — yt-dlp, ffmpeg — is fetched or bundled on first
use. ✅

## Capture

```sh
yoinks                                   # prompt for a url
yoinks https://dribbble.com/shots/…      # straight to the picker
yoinks https://youtu.be/dQw4w9WgXcQ      # video still works exactly as before ✅
```

<img src="assets/home.png" alt="yoinks home screen — paste a link and hit yoink" width="100%">

One paste runs every extractor that matches, in parallel:

| Extractor | Finds | Runs | Status |
|---|---|---|---|
| `direct` | the url *is* the asset — an image, a font file, an mp4 | always | ⬜ |
| `page` | `og:image`, `twitter:image`, `<img srcset>` at max width, `@font-face` sources, css custom properties that parse as colors | on html | ⬜ |
| `ytdlp` | video and audio at every resolution, via [yt-dlp](https://github.com/yt-dlp/yt-dlp) | on video hosts, or when the page exposes `og:video` | ✅ |
| `shot` | a full-page screenshot via a local headless Chrome | on request — it's the slow one, so it's a row in the picker, not a tax on every paste | ⬜ |

Results stream in as they land, so the fast extractors don't wait on the
slow ones. Pick with `↑↓`/`jk`, `space` to multi-select, `↵` to yoink. Or
click — the picker rows, the yoink button and the footer hints are all
mouse targets. ✅

Palettes and type aren't extractors. They're derived from whatever you
captured, once, and cached. Every image in your library has a palette
whether you asked for one or not. ⬜

## The library

```sh
yoinks lib                # the grid
yoinks lib dark editorial # filtered
```

⬜ Thumbnails render as real images. yoinks uses your terminal's graphics
protocol when it has one (Kitty, iTerm2, WezTerm, Ghostty) and falls back to
half-block Unicode everywhere else — which still gives you 24-bit color at
two pixels per character cell, so the grid looks right in Terminal.app and
over ssh. Details in [docs/rendering.md](docs/rendering.md).

| key | |
|---|---|
| `hjkl` / arrows | move |
| `/` | search |
| `↵` | open detail |
| `b` | boards |
| `t` | tag |
| `c` | copy — path in the grid, hex on a swatch |
| `o` | open in your default app |
| `esc` | back |

Organized by **boards** (a thing is on a board) and **tags** (a thing is
`dark`, `editorial`, `orange`). Both are free-form; neither is required.

## For your agents

This is the part no bookmarking tool does.

```sh
yoinks brief "dark analytics dashboard" --json
```

```json
{
  "ok": true,
  "data": {
    "matched": 7,
    "palette": [
      {"hex": "#0b0d10", "weight": 0.38, "role": "background"},
      {"hex": "#e8e6e3", "weight": 0.22, "role": "text"},
      {"hex": "#ff6b35", "weight": 0.04, "role": "accent"}
    ],
    "type": {"families": ["Söhne", "GT America Mono"]},
    "notes": ["dense tabular layouts", "hairline rules, no card shadows"],
    "references": [
      {
        "id": "01K3F…",
        "path": "/Users/you/.yoinks/library/blobs/9c/9c4f…/original.png",
        "source": "https://…",
        "note": "the way the rule sits under the eyebrow"
      }
    ]
  }
}
```

The `path` field is the whole trick. An agent reads those files and **sees
the references** — it isn't being told "the user likes muted earth tones,"
it's looking at seven screenshots you personally saved. Design output stops
being generic.

Three ways in, all over the same core: ⬜

- **Headless CLI** — every command takes `--json` and emits a stable
  envelope. Works from any script.
- **Agent skill** — `yoinks skill install` drops a `SKILL.md` that teaches
  an agent *when* to reach for your library, not just how.
- **MCP server** — `yoinks mcp` speaks stdio MCP, so Cursor, Zed, Claude
  Desktop and anything else with an MCP client can search, brief and capture.

Full contracts in [docs/agents.md](docs/agents.md).

## How it works

- The UI is [Ink](https://github.com/vadimdemedes/ink) — React for the
  terminal. Full-screen on the alternate buffer, and your scrollback comes
  back on exit. ✅
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) handles video. On first run
  yoinks fetches the standalone binary to `~/.yoinks/bin` — no Python. If
  you already have yt-dlp, it uses yours. ✅
- ffmpeg does more than merge streams: it's also the image decoder,
  thumbnailer and video frame-grabber, which is why yoinks has no native
  image dependency. Found on `PATH`, with `ffmpeg-static` bundled as a
  fallback. ✅ / ⬜
- The library is plain files under `~/.yoinks`. An append-only log plus
  content-addressed blobs — greppable, backup-able, and rebuildable from
  the log if the index is ever lost. [docs/asset-model.md](docs/asset-model.md) ⬜

Run `yoinks doctor` for a report on what's available on your machine —
which graphics protocol, whether Chrome was found, ffmpeg and yt-dlp
versions. ⬜

## Your library is yours

Local-first, and local-only today. There is no account, no telemetry, and no
network traffic except fetching the things you explicitly ask for. Your
taste is not training data.

The storage format is designed so that syncing *later* is additive — stable
ids, an append-only log, tombstones for deletes, and a portable export
bundle:

```sh
yoinks export --board hero-refs > hero-refs.yoink   # ⬜
yoinks import hero-refs.yoink                       # ⬜
```

Rationale in [docs/asset-model.md](docs/asset-model.md#designed-for-sync).

## Configuration

```sh
yoinks --theme light      # auto | light | dark, for one launch ✅
```

`^t` cycles the theme mid-session, or click the theme control in the footer.
The default `auto` uses your terminal's own foreground and background, so it
follows your terminal theme without guessing. ✅

| env | |
|---|---|
| `YOINKS_HOME` | library + binary location (default `~/.yoinks`) ⬜ |
| `YOINKS_GRAPHICS` | force `kitty`, `iterm`, `sixel`, `blocks`, or `off` ⬜ |
| `NO_COLOR` | respected ⬜ |

## Development

```sh
npm install
npm run build        # bundle to dist/ with tsup
npm run dev          # rebuild on change
npm test
npm run typecheck
node dist/cli.js <url>
```

`npm link` to try it as a global command without publishing.

Architecture, module layout and the extractor contract:
[docs/architecture.md](docs/architecture.md).

## Docs

| | |
|---|---|
| [architecture.md](docs/architecture.md) | pipeline, extractor contract, phase machine |
| [asset-model.md](docs/asset-model.md) | storage layout, schemas, sync design |
| [cli.md](docs/cli.md) | every command and flag |
| [rendering.md](docs/rendering.md) | terminal image rendering |
| [agents.md](docs/agents.md) | json contracts, skill, mcp |
| [roadmap.md](docs/roadmap.md) | what's built, what's next |

## A note on fair use

yoinks is a personal-archiving and reference tool. Downloading content may
violate a platform's terms of service, and saving something to your library
is not a license to republish it. Only keep what you have the right to keep,
credit the people whose work you're learning from, and be excellent to
creators.

The source url is stored with every asset for exactly this reason — so
attribution is never more than one command away.

## License

[MIT](LICENSE)
