# The agent surface

> Status: the CLI, skill and MCP server are built. Individual gaps are
> marked ⬜ inline.

## Why this exists

Ask a coding agent for "a dark analytics dashboard" and you get the average
of every dark analytics dashboard on the internet. Not wrong. Not yours.

The gap isn't the model's taste — it's that the model has never seen what
*you* liked. pluck closes it by handing over the thing you already
collected, in a form an agent can act on:

- a **weighted palette**, so colors come from your references and not from a
  default Tailwind scale
- **type families** observed on pages you saved (⬜ see step 4 below)
- **absolute file paths**, so the agent opens the images and looks at them

That last one is the whole design. Everything else is a summary an agent
could hallucinate a plausible version of. A file path is not summarizable —
either the agent reads seven screenshots you saved or it doesn't.

## Three layers, one core

```
             ┌──────────────┐   ┌───────────────┐
             │  SKILL.md    │   │  MCP server   │
             │  when to use │   │  pluck mcp   │
             └──────┬───────┘   └───────┬───────┘
                    └────────┬──────────┘
                             ▼
                    headless CLI (--json)
                             ▼
                   lib/store · lib/agent
```

The CLI is the substrate. The skill and the MCP server are thin shells that
add *when* and *where*, never new behavior. Anything reachable through MCP
is reachable with a shell command, which keeps the surfaces honest and makes
every one of them debuggable by hand.

`lib/store` and `lib/agent` import no Ink and no React —
see [architecture.md](architecture.md#module-layout).

## Layer 1 — headless CLI

Full reference in [cli.md](cli.md#headless). The contract:

- `--json` on every command, implied when stdout isn't a TTY
- `{"ok": true, "data": …}` / `{"ok": false, "error": {"code", "message"}}`
- exit `0` success, `1` failed, `2` usage
- closed set of error codes, safe to branch on

## Layer 2 — the skill

```sh
pluck skill install            # → ~/.claude/skills/inspiration/SKILL.md
pluck skill install --dir ./.claude/skills
pluck skill print              # stdout, for other runtimes
```

The skill ships in the package
([`skills/inspiration/SKILL.md`](../skills/inspiration/SKILL.md)) so it
versions with the CLI it describes.

A skill that only documents commands is a man page. This one's job is
**triggering** — teaching an agent to reach for the library unprompted when
it's about to make a visual decision:

- before writing CSS, choosing a color, or picking a font
- when asked to build a UI, a landing page, a component, a chart
- when the user says "like the one I saved" or "you know the look I want"
- when the user's own taste should override a framework default

And to *not* reach for it during backend work, refactors, or anything with
no visual output. A skill that fires on everything gets uninstalled.

## Layer 3 — MCP

```sh
pluck mcp     # stdio server
```

```json
{
  "mcpServers": {
    "pluck": {"command": "pluck", "args": ["mcp"]}
  }
}
```

### Tools

#### `search_inspiration`

Find references. The discovery call.

```json
{
  "query": "string — free text over title, note, tags, board, site",
  "board": "string?",
  "tags": ["string"],
  "kind": "image|video|font|palette|page|snippet",
  "color": "string? — hex, ranks by palette distance",
  "limit": "number, default 20"
}
```

Returns id, kind, title, source url, note, palette and `path` per result.

#### `get_brief`

The one that matters. Synthesized direction plus reference paths.

```json
{"query": "string", "board": "string?", "limit": "number, default 8"}
```

Schema below.

#### `get_asset`

One asset in full, by id or sha256 — including `path`, so the agent can read
the file next.

#### `list_boards`

Boards with item counts and covers. Cheap orientation call; an agent that
lists boards first asks much better questions.

#### `capture_url`

Save something into the library. Writes, so it should be behind whatever
confirmation the host offers.

```json
{
  "url": "string",
  "board": "string?",
  "tags": ["string"],
  "note": "string?",
  "select": "best|all, default best"
}
```

Idempotent — the same url twice adds an item and reuses the blob.

### What is deliberately absent

No delete, no bulk edit, no board rename. Read and append only. An agent
that can quietly drop things from a collection you spent two years building
is not worth the convenience, and nothing in the design brief requires it.

## Brief

The synthesis pass. Everything else returns records; this returns direction.

```sh
pluck brief "dark analytics dashboard" --json
pluck brief --board hero-refs --md
```

### Computation

1. **Select** — run the same ranking as `find`, take the top `limit`.
2. **Fuse palettes** — every blob's palette carries per-cluster `weight`
   (see [rendering.md](rendering.md#palette-extraction)). Each reference is
   normalized to one vote first, so a palette whose weights happen to sum
   high can't outvote the board by scale alone. Then merge clusters across
   the selection within distance 8, sum weights, renormalize. Colors that
   recur across many references dominate; a single loud outlier doesn't.

   That 8 is on the codebase's weighted-RGB metric, which runs **0..765** —
   not CIE Lab's 0..100, which is what "ΔE" would imply. It is deliberately
   tighter than derivation's own merge distance of 25: inside one image a
   merge joins two slices of one gradient, but across references it joins two
   designers' separate choices, and averaging those invents a colour neither
   reference contains.
3. **Assign roles** — background / text / accent by the luminance and
   chroma heuristic. Hints, never claims.
4. **Collect type** — font families from `BlobMeta.fonts`, ranked by how many
   references show them.

   ⬜ **Not yet reachable.** Nothing populates `BlobMeta.fonts` today: the page
   extractor yields font *files* as capture candidates, not family names, and
   derivation never writes the field. `type.families` is therefore `[]` on
   every real library until a font-observation pass lands. The plumbing is
   here so that pass is additive.
5. **Notes** — your own `note` fields, verbatim. Never paraphrased. The
   whole value of a note is that a person wrote it about a specific thing.
6. **Attach paths** — absolute paths to the originals, in rank order.

Nothing here is a language-model call. The brief is arithmetic over your
library, so it's fast, offline, deterministic, and identical every time —
which matters when it's feeding a generator that's already stochastic.

### Schema

```json
{
  "ok": true,
  "data": {
    "query": "dark analytics dashboard",
    "matched": 7,
    "palette": [
      {"hex": "#0b0d10", "weight": 0.38, "role": "background"},
      {"hex": "#151a20", "weight": 0.19, "role": "surface"},
      {"hex": "#e8e6e3", "weight": 0.22, "role": "text"},
      {"hex": "#7d8590", "weight": 0.11, "role": "muted"},
      {"hex": "#ff6b35", "weight": 0.04, "role": "accent"}
    ],
    "type": {
      "families": [
        {"name": "Söhne", "seen_in": 4},
        {"name": "GT America Mono", "seen_in": 3}
      ]
    },
    "notes": [
      "the way the rule sits under the eyebrow",
      "no card shadows anywhere — hairlines only"
    ],
    "references": [
      {
        "id": "01K3F7Q2M8ZR4V6N0YB1TXCJHD",
        "path": "/Users/you/.pluck/library/blobs/9c/9c4f8a…/original.png",
        "kind": "image",
        "source": "https://…",
        "title": "Analytics dashboard — dark",
        "note": "the way the rule sits under the eyebrow",
        "palette": ["#0b0d10", "#e8e6e3", "#ff6b35"]
      }
    ]
  }
}
```

`--md` renders the same data as markdown for pasting into a prompt by hand.
`--no-paths` omits `path` for consumers that can't read local files — a
remote agent, say — which degrades the brief to a summary and should be
described that way when you use it.

### Using it well

The intended shape of an agent's turn:

```
1. get_brief("dark analytics dashboard")
2. read 3–4 files from data.references[].path      ← the actual seeing
3. build, using the palette hexes and observed type
4. cite which references drove which decisions
```

Step 2 is the one that gets skipped, and skipping it collapses this back
into an ordinary style prompt. The skill says so explicitly.

Step 4 matters more than it looks: when an agent says "the hairline dividers
come from ref 3," you can check whether it actually looked, and you can
correct its reading. A brief with no attribution is unfalsifiable.

## Privacy

Reads and captures are local. Nothing leaves the machine except fetching the
assets you asked for.

`get_brief` is the exception, and by design: source urls, your notes, and
palette data all go to whatever agent you called it from. If that agent runs
in the cloud, that's a network egress you chose. File *contents* still don't
move — the agent gets paths, and reading them requires local filesystem
access it either has or doesn't.

Two consequences worth being deliberate about:

- **Notes are the most personal field in the library.** "the way the rule
  sits under the eyebrow" is fine; "for the "…" pitch, don't show Dana" is
  not something to hand to a remote model. `--no-notes` omits them.
- **A private board is not a permission boundary.** Any agent with the MCP
  server configured can search every board. If something shouldn't reach an
  agent, it shouldn't be in the library the agent can reach — keep a
  separate `PLUCK_HOME` for it.

## Non-goals

- **No writes beyond capture.** Covered above.
- **No LLM inside pluck.** The brief is arithmetic. No API key, no network,
  no non-determinism, no second opinion about your taste.
- **No opinions in the data.** pluck reports what's in your references. It
  does not tell an agent that your palette is "sophisticated" or
  "energetic," because that's a summary the agent can produce itself from
  the actual pixels, and it would be pluck putting words in your mouth.
