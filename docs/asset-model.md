# Asset model

> Target state for v1.0. Status keys: ✅ shipped in 0.3.1 · 🚧 building · ⬜ planned.

Local-first, plain files, no database. Everything here is greppable with the
tools you already have, backup-able with `cp -r`, and rebuildable from the
log if any derived file is lost.

## Two kinds of identity

The single most important decision in this document: **a thing and a saving
of that thing are different records.**

| | **Blob** | **Item** |
|---|---|---|
| Identity | `sha256` of the bytes | `id` — a sortable, globally-unique string |
| Holds | intrinsic facts: dimensions, palette, mime, duration | your facts: where you found it, board, tags, note |
| Duplicates | impossible by construction | expected and fine |

The same screenshot saved from two different articles is **one blob, two
items** — one blob because the pixels are identical, two items because the
context, note and board differ and both are true.

This split is what makes everything else cheap:

- **Dedupe is free.** Ingest hashes first. Second capture of the same bytes
  writes an item and nothing else.
- **Derivation runs once per blob**, not once per save.
- **Sync is tractable.** Blobs merge by hash with no conflict possible.
  Items merge by id with last-write-wins. No three-way merge, ever.

## Home directory

```
$YOINKS_HOME  →  ~/.yoinks
```

Resolution order: `$YOINKS_HOME`, then `~/.yoinks`. ⬜

**On renaming the product.** If `yoinks` becomes something else, the new
build resolves `$NEWNAME_HOME` → `~/.newname` → **falls back to `~/.yoinks`
if it exists and the new path does not.** Read from the legacy path in
place; don't move anyone's library on their behalf. Offer a one-line
`newname migrate` that does the move when they ask for it. A rename that
silently strands someone's saved work is the worst possible first impression
of a new name.

## Layout

```
$YOINKS_HOME/
  bin/                              yt-dlp, fetched on first run          ✅
  library/
    items.jsonl                     append-only log — the source of truth ⬜
    boards.json                     board metadata                        ⬜
    blobs/
      9c/9c4f8a…e21/
        original.png                the bytes, never modified             ⬜
        meta.json                   intrinsic, derived                    ⬜
    cache/                          100% regenerable, safe to delete      ⬜
      thumbs/9c4f8a…e21-44x22.rgb
      index.json                    replayed log, for fast startup
```

Sharding on the first two hex characters keeps any one directory under a few
hundred entries at library sizes people actually reach.

`cache/` is the only directory yoinks will delete without being asked.
Everything else is yours.

## Records

### Item

One line of `items.jsonl`. Append-only — an edit appends a new line, it does
not rewrite an old one.

```json
{
  "op": "put",
  "id": "01K3F7Q2M8ZR4V6N0YB1TXCJHD",
  "ts": "2026-07-25T18:02:11.481Z",
  "sha256": "9c4f8a…e21",
  "source": {
    "url": "https://dribbble.com/shots/…",
    "site": "dribbble.com",
    "title": "Analytics dashboard — dark",
    "author": "…",
    "extractor": "page",
    "captured_at": "2026-07-25T18:02:11.481Z"
  },
  "boards": ["hero-refs"],
  "tags": ["dark", "editorial", "orange"],
  "note": "the way the rule sits under the eyebrow"
}
```

| Field | |
|---|---|
| `op` | `put` \| `del` |
| `id` | [ULID](https://github.com/ulid/spec) — lexicographically sortable by creation time, generated offline, no coordination needed. Sortability means "most recent 20" is a tail of the log, not a scan. |
| `ts` | when this *record* was written. Merge key for last-write-wins. |
| `sha256` | the blob. Absent only for blob-less kinds (see below). |
| `source.extractor` | which extractor produced it — useful for debugging a bad capture months later |
| `note` | free text, and the highest-signal field in the whole model. Why *you* saved it is not recoverable from the pixels. |

A delete is a tombstone:

```json
{"op": "del", "id": "01K3F7Q2M8ZR4V6N0YB1TXCJHD", "ts": "2026-07-26T09:14:02.006Z"}
```

The blob stays until nothing references it; `yoinks compact` collects it.
Tombstones are never removed — they're what stops a deleted item from
resurrecting when a future sync replays an older log.

### Blob meta

`blobs/<aa>/<sha256>/meta.json`. Entirely derived — delete it and the next
derivation pass rebuilds it identically.

```json
{
  "sha256": "9c4f8a…e21",
  "kind": "image",
  "mime": "image/png",
  "bytes": 482113,
  "width": 2400,
  "height": 1600,
  "duration": null,
  "palette": [
    {"hex": "#0b0d10", "weight": 0.38},
    {"hex": "#e8e6e3", "weight": 0.22},
    {"hex": "#ff6b35", "weight": 0.04}
  ],
  "fonts": ["Söhne", "GT America Mono"],
  "derived_at": "2026-07-25T18:02:13.902Z",
  "deriver_version": 1
}
```

`deriver_version` earns its keep the first time the palette algorithm
improves: bump it, and a background pass re-derives everything below the
current version without anyone re-capturing anything.

`weight` is the fraction of sampled pixels in that cluster, so palettes are
comparable across images and can be summed across a board — which is
precisely what `yoinks brief` does.

### Kinds

`image` · `video` · `audio` · `font` · `page` · `palette` · `snippet`

Two are blob-less: a **palette** yoinked directly (from a palette site,
say) and a **snippet** of text or css. They still get a `sha256` — over the
canonical JSON serialization of their content — so one code path handles
dedupe, and `original.json` sits where `original.png` would.

### Board

`boards.json`, a plain map. Small enough to rewrite atomically.

```json
{
  "hero-refs": {
    "name": "hero refs",
    "created_at": "2026-07-01T…",
    "note": "for the Q3 marketing site",
    "cover": "9c4f8a…e21"
  }
}
```

Boards and tags overlap on purpose. A board is a *place you put things* and
implies intent; a tag is a *property a thing has*. People reach for both,
and enforcing one would just push the other into naming conventions.

## The log

`items.jsonl` is the source of truth. Everything else is a cache of it.

**Read** — replay the file top to bottom into a `Map<id, Item>`. Later `ts`
wins; a `del` removes. At 10k items the file is roughly 4 MB and replays in
well under 100 ms, so `cache/index.json` is a startup optimization, not a
requirement. Validate it against the log's size and mtime and fall back to a
replay whenever it looks stale.

**Write** — `O_APPEND` with a single `write()` of a line under 4 KB, which
is atomic on every filesystem yoinks targets. Two processes appending
concurrently cannot interleave a line. No lock file, no journal.

**Compact** — `yoinks compact` rewrites the log with only the winning record
per id, keeps every tombstone, and garbage-collects unreferenced blobs. Pure
housekeeping; never required.

The reason for append-only over a JSON file rewrite: a rewrite that's
interrupted at the wrong moment loses the whole library. An append that's
interrupted loses the last line. Given this holds work people can't
regenerate, that asymmetry decides it.

## Designed for sync

Sync is not in v1.0. These four properties are, because retrofitting them
would mean migrating everyone's library:

1. **ULIDs, not sequence numbers.** Ids generate offline on any machine with
   no coordination and never collide.
2. **Append-only log with per-record `ts`.** Merging two libraries is
   `cat a b | sort -u` followed by a replay. That's the entire algorithm.
3. **Tombstones, never hard deletes.** Without them, replaying an old log
   resurrects deleted items.
4. **Content-addressed blobs.** Blob sync is idempotent transfer with no
   conflict resolution — the hash is the answer.

When sync arrives it adds a transport and a `origin` field. It does not
change any record above.

### Export bundle

The manual version of sync, and useful on its own for sharing a board.

```sh
yoinks export --board hero-refs > hero-refs.yoink    # ⬜
yoinks import hero-refs.yoink                        # ⬜
```

A `.yoink` bundle is a gzipped tar:

```
manifest.json        format version, created_at, item + blob counts
items.jsonl          only the exported items
blobs/…              only the blobs those items reference
```

Import replays the log and merges by the rules above, so importing the same
bundle twice is a no-op and importing a friend's board never clobbers your
notes on a shared image — different ids, same blob.

## Backup

The library is files, so it backs up with anything. Two facts worth knowing:

- `library/items.jsonl` + `library/blobs/` is a complete backup.
- `library/cache/` is safe to exclude, and should be — it's the bulk of the
  small-file count and none of the value.

## What is not stored

No telemetry. No analytics. No usage log. No remote calls except fetching
the assets you explicitly ask for and, on first run, the yt-dlp binary.

Two consequences worth stating plainly, because they're the trade:

- **Nothing is recoverable if you lose the directory.** There is no server
  with a copy. Back it up.
- **`yoinks brief` output contains your source urls and notes.** When you
  hand it to an agent running in the cloud, that goes with it. That's the
  point of the feature, but it's worth knowing which command crosses the
  line and which don't — reads and captures are local; only what you
  explicitly pipe to an agent leaves the machine.
