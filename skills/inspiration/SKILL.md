---
name: inspiration
description: Pull the user's own saved design references — palettes, type, screenshots — from their local pluck library before making any visual decision. Use when building or restyling UI, choosing colors or fonts, designing a page, component, chart, or slide, or when the user refers to something they saved ("like the one I liked", "you know the look"). Do not use for backend work, refactors, or anything with no visual output.
---

# Inspiration

The user keeps a library of design references they collected themselves.
Before you make a visual decision, look at it. What's in there beats any
default you'd otherwise reach for, because they chose it.

Requires the `pluck` CLI. If `pluck doctor` fails, the library isn't
available — say so once and carry on with your own judgment rather than
guessing at what might be in it.

## When to use this

**Do**, without being asked:

- before writing CSS, picking colors, or choosing a typeface
- when asked to build a UI, landing page, component, dashboard, chart, deck
- when restyling or "making this look better"
- when the user references something they saved — "like the one I liked",
  "the look from that site", "you know the vibe"
- when a framework default is about to decide something the user has taste
  about

**Don't:**

- backend, data, infra, tests, refactors, anything with no visual output
- when the user gave explicit values already — their hex beats their library
- when a brand system is already in the repo; that's a constraint, this is
  inspiration. Check for one first.

## The loop

```sh
pluck brief "dark analytics dashboard" --json
```

Then — and this is the part that matters — **read the reference files**:

```
data.references[].path   →  absolute paths to the actual images
```

Open three or four with your file-reading tool and *look at them*. The
palette and type lists are a summary. The images are the evidence. A brief
used without opening the files is just a style prompt with extra steps, and
the output will show it.

Then build, and say which reference drove which decision:

> Hairline dividers and the 4px grid come from ref 2 (the Linear changelog
> screenshot); the orange is `#ff6b35`, which carries 4% weight across the
> board and reads as the accent in refs 1 and 3.

Attribution lets the user check whether you actually looked, and correct you
when you misread something.

## Commands

```sh
pluck brief "<query>" --json          # palette + type + notes + paths
pluck brief --board hero-refs --json  # a whole board
pluck brief "<query>" --limit 12 --json

pluck find "<query>" --json           # browse before committing to a brief
pluck find --color "#ff6b35" --json   # "the one with that orange"
pluck find --kind font --json
pluck boards --json                   # orient first when the ask is vague

pluck show <id> --json                # one reference in full
```

All emit `{"ok": true, "data": …}` or
`{"ok": false, "error": {"code", "message"}}`. Exit `0` / `1` / `2`.

If MCP tools named `search_inspiration`, `get_brief`, `get_asset`,
`list_boards` are available, use those instead — same data, fewer shell
round-trips.

## Reading a brief

```json
{
  "matched": 7,
  "palette": [{"hex": "#0b0d10", "weight": 0.38, "role": "background"}],
  "type": {"families": [{"name": "Söhne", "seen_in": 4}]},
  "notes": ["no card shadows anywhere — hairlines only"],
  "references": [{"path": "…", "source": "…", "note": "…"}]
}
```

- **`weight`** is the fraction of pixels across all matched references.
  Heavy colors are surfaces; light ones are accents. A 4% color is often the
  most important color in the whole board — don't discard it as noise.
- **`role`** is a heuristic hint, not a rule. If the images disagree with
  the label, trust the images.
- **`notes`** are the user's own words about a specific reference. Highest
  signal in the payload. Treat a note as a direct instruction about that
  reference.
- **`seen_in`** counts how many references showed that font. One sighting is
  a coincidence; four is a preference.
- **`matched: 0`** — say so and ask rather than inventing direction. An
  empty library is information, not a failure.

## Saving things

Only when the user asks, or clearly means to ("save this", "add this to my
refs", "keep that one"):

```sh
pluck capture <url> --best --board <board> --tag <tag> --note "<why>" --json
```

Write a real `--note` — why this one, what's good about it. That note is
what makes the reference useful in six months, and the user is trusting you
to capture the reason they stopped scrolling.

Never delete, retag, or reorganize the library. It's theirs, it took years,
and nothing you're doing requires it.

## Getting it wrong

- **Don't paraphrase the library into adjectives.** "Muted, sophisticated,
  editorial" is you summarizing pixels you were given direct access to. Open
  the files.
- **Don't average everything.** Seven references aren't one design. Pick the
  closest one or two and follow them; say which.
- **Don't override explicit instructions.** The library informs decisions
  the user left open, not ones they already made.
- **Don't over-fetch.** One brief per visual task. Re-running it with
  slightly different wording produces near-identical output and wastes the
  user's time.
