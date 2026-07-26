# CLI reference

> Target state for v1.0. Status keys: ✅ shipped in 0.3.1 · 🚧 building · ⬜ planned.

## Shape

```
yoinks [url]                    interactive — the default
yoinks <command> [args] [flags] everything else
```

A bare `yoinks` or `yoinks <url>` opens the full-screen UI. Every other
command is a verb. There is no `yoinks capture` in interactive mode — if you
have a url, you paste it.

## Interactive

### `yoinks [url]` ✅

```sh
yoinks                                  # prompt for a url
yoinks https://youtu.be/dQw4w9WgXcQ     # straight to the picker
yoinks --theme light                    # force a palette for this launch
```

Takes over the terminal on the alternate screen and restores your scrollback
on exit. If your clipboard holds a url when you launch bare, `⇥` pastes it.

| key | |
|---|---|
| `↵` | yoink |
| `↑` `↓` / `j` `k` / number | move in the picker |
| `space` | multi-select in the picker ⬜ |
| `↑` | url history, from the input ✅ |
| `l` | open the library ⬜ |
| `esc` | back, or cancel an in-flight probe or capture |
| `^t` | cycle theme |
| `^c` | quit |

The yoink button, picker rows, footer hints and the logo are all clickable.
The logo takes you home.

### `yoinks lib [query]` ⬜

```sh
yoinks lib
yoinks lib dark editorial
yoinks lib --board hero-refs
```

The thumbnail grid.

| key | |
|---|---|
| `h` `j` `k` `l` / arrows | move |
| `/` | search — filters as you type |
| `↵` | detail view |
| `b` | boards |
| `t` | tag the selection |
| `space` | multi-select |
| `c` | copy — file path in the grid, hex on a swatch in detail |
| `o` | open in your default app |
| `x` | delete (tombstone; `yoinks compact` reclaims the bytes) |
| `esc` | back |

## Headless

Every command below emits JSON on `--json` and exits without touching the
alternate screen.

**Auto-detection:** if `stdout` is not a TTY, `--json` is implied. So
`yoinks find dark | jq` works with no flag, and `yoinks find dark` in a
terminal prints a human table. [`cli.tsx`](../src/cli.tsx) already branches
on `isTTY` for clipboard handling — this extends the same check.

### Envelope

```json
{"ok": true, "data": {}}
```

```json
{"ok": false, "error": {"code": "no_candidates", "message": "Nothing yoinkable on that page."}}
```

| Exit | |
|---|---|
| `0` | success |
| `1` | operation failed — `error.code` says why |
| `2` | usage error — bad flags, unknown command |

Error codes are a closed set: `usage`, `not_found`, `no_candidates`,
`fetch_failed`, `extractor_failed`, `unsupported`, `store_error`,
`cancelled`.

### `yoinks capture <url>` ⬜

```sh
yoinks capture https://dribbble.com/shots/… --json
yoinks capture <url> --all --board hero-refs --tag dark --tag editorial
yoinks capture <url> --kind image --best
yoinks capture <url> --dry-run --json      # probe only, capture nothing
```

| Flag | |
|---|---|
| `--all` | every candidate, no picking |
| `--best` | highest-scoring candidate per kind |
| `--kind <k>` | restrict to a kind; repeatable |
| `--board <b>` | file it (created if new) |
| `--tag <t>` | repeatable |
| `--note <text>` | |
| `--shot` | ⬜ force the screenshot extractor — rejected until the `shot` extractor exists, rather than silently doing nothing |
| `--dry-run` | probe and report candidates without fetching |
| `--timeout <ms>` | default 30000 |

Without `--all` or `--best`, a headless capture with multiple candidates
fails with `usage` (exit 2), listing what it found and how to narrow it.
Ambiguity is the caller's to resolve — and the flags were wrong, not the
page, which is why it isn't `no_candidates`. `--all` and `--best` together
is also `usage`; preferring one silently would be a guess.

`--timeout` bounds the *probe*, not the download — a 30 s clock would kill
legitimate video captures. Download size is bounded separately, at 512 MB.

Idempotent: re-capturing an identical asset writes an item, reuses the blob,
and reports `"deduped": true`.

```json
{
  "ok": true,
  "data": {
    "captured": [
      {"id": "01K3F7…", "sha256": "9c4f8a…", "kind": "image",
       "path": "/Users/you/.yoinks/library/blobs/9c/9c4f8a…/original.png",
       "deduped": false}
    ],
    "skipped": []
  }
}
```

### `yoinks find <query>` ⬜

```sh
yoinks find "dark editorial" --json
yoinks find --board hero-refs --kind image --limit 20
yoinks find --tag orange --since 2026-01-01
```

| Flag | |
|---|---|
| `--board` `--tag` `--kind` | filters; repeatable |
| `--since` `--until` | ISO dates |
| `--limit` | default 20 |
| `--color <hex>` | nearest-palette match, ranked by distance |
| `--json` | |

Free-text matches title, note, tags, board and site. `--color` is the one
people don't expect and reach for constantly — "the reference with that
orange" is how visual memory actually works.

### `yoinks show <id|sha256>` ⬜

Full record for one asset: item fields, blob meta, palette, and the absolute
path. Accepts an id prefix as long as it's unambiguous.

### `yoinks brief <query>` ⬜

The synthesis command. See [agents.md](agents.md#brief) for the full schema
and how it's computed.

```sh
yoinks brief "dark analytics dashboard" --json
yoinks brief --board hero-refs --md
yoinks brief "editorial" --limit 12 --json
```

| Flag | |
|---|---|
| `--limit <n>` | references to include, default 8 |
| `--md` | markdown instead of JSON — for pasting into a prompt by hand |
| `--no-paths` | omit file paths, for when the consumer can't read local files |

### Library management ⬜

```sh
yoinks boards                       # list, with counts
yoinks boards new <name> [--note]
yoinks tag <id> <tag>...            # --rm to remove
yoinks mv <id> --board <b>
yoinks note <id> <text>
yoinks rm <id>...                   # tombstone
yoinks compact                      # collapse the log, keeping every tombstone
```

### `yoinks export` / `yoinks import` ⬜

```sh
yoinks export --board hero-refs > hero-refs.yoink
yoinks export --tag dark --since 2026-01-01 > dark.yoink
yoinks import hero-refs.yoink
yoinks import hero-refs.yoink --dry-run --json
```

Bundle format in [asset-model.md](asset-model.md#export-bundle). Import
merges; it never overwrites. Importing twice is a no-op.

### `yoinks skill install` ⬜

```sh
yoinks skill install                      # ~/.claude/skills/inspiration/
yoinks skill install --dir ./.claude/skills
yoinks skill print                        # to stdout, for other runtimes
```

### `yoinks mcp` ⬜

Runs a stdio MCP server. Not meant to be run by hand — it's what you point
an MCP client at. Tools in [agents.md](agents.md#tools).

```json
{
  "mcpServers": {
    "yoinks": {"command": "yoinks", "args": ["mcp"]}
  }
}
```

### `yoinks doctor` ⬜

```
$ yoinks doctor
  yoinks            1.0.0
  node              22.11.0
  yt-dlp            2026.07.11   ~/.yoinks/bin/yt-dlp
  ffmpeg            7.1          /opt/homebrew/bin/ffmpeg
  chrome            141.0        /Applications/Google Chrome.app/…
  graphics          kitty        (Ghostty 1.2)
  library           1,284 items · 1,109 blobs · 3.2 GB
  home              ~/.yoinks
```

First thing to ask for in a bug report, and the fastest way to explain why
thumbnails look blocky or why the screenshot row never appears.

## Global flags

| Flag | | Status |
|---|---|---|
| `--theme <auto\|light\|dark>` | palette for this launch | ✅ |
| `--json` | machine output | ⬜ |
| `-h`, `--help` | | ✅ |
| `-v`, `--version` | | ✅ |

## Environment

| | | Status |
|---|---|---|
| `YOINKS_HOME` | library and binaries (default `~/.yoinks`) | ⬜ |
| `YOINKS_GRAPHICS` | force `kitty`, `iterm`, `sixel`, `blocks`, `off` | ⬜ |
| `NO_COLOR` | disables color; thumbnails degrade to a text placeholder | ⬜ |

## Compatibility

`yoinks <video-url>` behaves in v1.0 exactly as it does in 0.3.1 — same
picker rows, same labels, same download destination. The regression test
described in [architecture.md](architecture.md#testing) exists to keep that
true.

One deliberate change: captures land in the library, not `~/Downloads`.
Video capture keeps writing to `~/Downloads` as well, because that's the
behavior people installed the tool for, and `--to <dir>` overrides it.
