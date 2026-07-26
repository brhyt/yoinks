import React, {useEffect, useRef, useState} from 'react'
import {Box, Text, useInput} from 'ink'
import {Shortcuts} from './shortcuts.js'
import {TextInput} from './text-input.js'
import type {ClickTarget, RectTarget} from '../lib/click-map.js'
import {truncate} from '../lib/format.js'
import {placeholderRows, renderBlocks} from '../lib/render/blocks.js'
import {detectCaps} from '../lib/render/caps.js'
import {thumbRgb} from '../lib/render/thumb.js'
import {cellHeightFor, type CellSize} from '../lib/render/types.js'
import {loadItems} from '../lib/store/log.js'
import {search, type Hit} from '../lib/store/query.js'
import type {Item} from '../lib/store/types.js'
import {useTheme} from '../theme.js'

/**
 * The library — a thumbnail grid, a detail view and a board list, in one
 * component because they share one selection and one input handler.
 *
 * Everything that touches disk happens in effects behind an AbortController.
 * The first paint is always placeholders: a grid that decoded during render
 * would stall the frame, and one that keeps decoding after you've scrolled
 * past is what makes a terminal ui feel slow.
 *
 * See docs/cli.md#yoinks-lib-query.
 */

/** A thumbnail aims for this many cells wide; narrow terminals get less. */
const THUMB_TARGET = 20
/** Cells between thumbnails, horizontally and (as one blank row) vertically. */
const GAP = 2
/** paddingX={2} on both sides. */
const MARGIN = 4
/** Title row, search row, blank — the grid starts under these. */
const HEADER_ROWS = 3
/** Blank, shortcuts, and one row of slack so a cell row can never overflow. */
const FOOTER_ROWS = 3
/** Newest 60: more than fills any terminal, and the store pays i/o per hit. */
const PAGE_LIMIT = 60
/** Palette entries the detail view has room for. */
const SWATCHES = 6

const whole = (value: number) => (Number.isFinite(value) ? Math.floor(value) : 0)

export type GridLayout = {
  perRow: number
  rowsPerPage: number
  thumbCols: number
  thumbRows: number
  pages: number
}

/**
 * How many thumbnails fit, and how big. Pure, so the click rectangles and the
 * boxes they cover are computed from the same numbers.
 *
 * Every field is at least 1 at every terminal size — a zero here would divide
 * by zero downstream, and a 20×10 terminal has to show *something*.
 */
export function gridLayout(columns: number, rows: number, count: number): GridLayout {
  const width = Math.max(1, whole(columns) - MARGIN)
  const perRow = Math.max(1, Math.floor(width / (THUMB_TARGET + GAP)))
  const thumbCols = Math.max(1, Math.min(THUMB_TARGET, Math.floor((width - GAP * (perRow - 1)) / perRow)))

  const gridRows = Math.max(1, whole(rows) - HEADER_ROWS - FOOTER_ROWS)
  // half-blocks stack two pixels per cell, so a square image is a square block
  // of cells; a cell also owns a title row and a blank row of gutter
  const thumbRows = Math.max(1, Math.min(Math.round(thumbCols / 2), gridRows - 2))
  const rowsPerPage = Math.max(1, Math.floor(gridRows / (thumbRows + 2)))

  const pages = Math.max(1, Math.ceil(Math.max(0, whole(count)) / (perRow * rowsPerPage)))
  return {perRow, rowsPerPage, thumbCols, thumbRows, pages}
}

/**
 * Next selection for a movement key. Left/right wrap through the whole list so
 * the end of a row continues onto the next; up/down clamp, because jumping to
 * a far-away item when there is no row below reads as a bug.
 */
export function moveSelection(index: number, key: string, perRow: number, count: number): number {
  if (whole(count) <= 0) return 0
  const last = whole(count) - 1
  const stride = Math.max(1, whole(perRow))
  const current = Math.min(Math.max(0, whole(index)), last)

  switch (key) {
    case 'g':
      return 0
    case 'G':
      return last
    case 'h':
    case 'left':
      return current === 0 ? last : current - 1
    case 'l':
    case 'right':
      return current === last ? 0 : current + 1
    case 'k':
    case 'up':
      return current - stride >= 0 ? current - stride : current
    case 'j':
    case 'down':
      return current + stride <= last ? current + stride : current
    default:
      return current
  }
}

/**
 * One click rectangle per visible cell, covering the thumbnail and its title.
 *
 * Text matching can't work here — every cell renders as the same `▀`, so cell
 * 3 and cell 9 have identical text (see lib/click-map.ts).
 */
export function rectsFor(
  layout: GridLayout,
  count: number,
  originX: number,
  originY: number,
  onPick?: (index: number) => void,
): RectTarget[] {
  const perRow = Math.max(1, whole(layout.perRow))
  const width = Math.max(1, whole(layout.thumbCols))
  const height = Math.max(1, whole(layout.thumbRows)) + 1
  const left = Math.max(1, whole(originX))
  const top = Math.max(1, whole(originY))

  const targets: RectTarget[] = []
  for (let index = 0; index < Math.max(0, whole(count)); index++) {
    const column = index % perRow
    const row = Math.floor(index / perRow)
    targets.push({
      rect: [left + column * (width + GAP), top + row * (height + 1), width, height],
      action: () => onPick?.(index),
    })
  }
  return targets
}

export type BoardCount = {name: string; count: number}

/** Boards that actually hold something, with their counts. Newest name wins the casing. */
export function boardCounts(items: Item[]): BoardCount[] {
  const counts = new Map<string, BoardCount>()
  for (const item of items) {
    for (const board of item.boards) {
      const name = board.trim()
      if (!name) continue
      const key = name.toLowerCase()
      const existing = counts.get(key)
      if (existing) existing.count++
      else counts.set(key, {name, count: 1})
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** What to call an item when there is no title — never the empty string. */
export function titleFor(item: Item): string {
  return item.source.title?.trim() || item.note?.trim() || item.source.site?.trim() || item.source.url || 'untitled'
}

const thumbKey = (sha256: string, size: CellSize) => `${sha256}-${size.cols}x${size.rows}`

// explicit blank lines — empty <Box height={1}/> spacers can collapse, and
// ink boxes default to flexShrink=1, so spacers are the first thing yoga
// crushes when content overflows the terminal
const Gap = ({lines = 1}: {lines?: number}) => (
  <Box flexDirection="column" flexShrink={0}>
    {Array.from({length: lines}, (_, i) => (
      <Text key={i}> </Text>
    ))}
  </Box>
)

type Mode = 'grid' | 'detail' | 'boards'

const HINTS: Record<Mode, Array<[string, string]>> = {
  grid: [
    ['hjkl', 'move'],
    ['↵', 'detail'],
    ['/', 'search'],
    ['b', 'boards'],
    ['esc', 'back'],
  ],
  detail: [
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  boards: [
    ['jk', 'move'],
    ['↵', 'filter'],
    ['esc', 'back'],
  ],
}

export type LibraryProps = {
  isActive: boolean
  columns: number
  rows: number
  onExit: () => void
  onClickTargets?: (targets: ClickTarget[]) => void
}

export function LibraryScreen({isActive, columns, rows, onExit, onClickTargets}: LibraryProps) {
  const theme = useTheme()
  const [caps] = useState(detectCaps)
  const [mode, setMode] = useState<Mode>('grid')
  const [hits, setHits] = useState<Hit[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState(0)
  const [query, setQuery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [board, setBoard] = useState<string>()
  const [boards, setBoards] = useState<BoardCount[]>([])
  const [boardIndex, setBoardIndex] = useState(0)
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, string[]>>(() => new Map())

  // read inside effects that await between items, so the loop sees what earlier
  // iterations already stored rather than the map its closure captured
  const thumbsRef = useRef(thumbs)
  thumbsRef.current = thumbs
  // a parent that rebuilds this callback every render would otherwise loop:
  // effect → parent setState → new identity → effect
  const targetsRef = useRef(onClickTargets)
  targetsRef.current = onClickTargets

  const layout = gridLayout(columns, rows, hits.length)
  const perPage = layout.perRow * layout.rowsPerPage
  const pageStart = Math.floor(selected / perPage) * perPage
  const visible = hits.slice(pageStart, pageStart + perPage)
  const current = hits[selected]

  const gridSize: CellSize = {cols: layout.thumbCols, rows: layout.thumbRows}
  // the detail preview keeps the blob's own aspect; the grid can't, or the rows
  // would stop lining up
  const detailCols = Math.max(1, Math.min(40, columns - MARGIN))
  const detailRows = Math.max(
    1,
    Math.min(cellHeightFor(detailCols, current?.meta?.width ?? 0, current?.meta?.height ?? 0), rows - 12),
  )
  const detailSize: CellSize = {cols: detailCols, rows: detailRows}

  // `off` is NO_COLOR or an explicit opt-out: a grid of grey mush is not what
  // anyone means by it, so the placeholders stand in for every thumbnail
  const drawsPixels = caps.protocol !== 'off'

  useEffect(() => {
    if (!isActive) return
    const controller = new AbortController()
    void (async () => {
      const found = await search({
        text: query.trim() || undefined,
        boards: board ? [board] : undefined,
        limit: PAGE_LIMIT,
      }).catch(() => [] as Hit[])
      if (controller.signal.aborted) return
      setHits(found)
      setSelected(0)
      setLoaded(true)
    })()
    return () => controller.abort()
  }, [isActive, query, board])

  const visibleKey = visible.map(hit => hit.item.sha256 ?? '').join(',')
  useEffect(() => {
    if (!isActive || !drawsPixels || mode !== 'grid') return
    const controller = new AbortController()
    void (async () => {
      // sequential on purpose: aborting mid-page then actually stops the
      // remaining decodes instead of racing a Promise.all that's already spawned
      for (const hit of visible) {
        if (controller.signal.aborted) return
        const sha256 = hit.item.sha256
        if (!sha256) continue
        const key = thumbKey(sha256, gridSize)
        if (thumbsRef.current.has(key)) continue
        const rgb = await thumbRgb(sha256, gridSize, controller.signal).catch(() => undefined)
        if (controller.signal.aborted) return
        // an empty entry is remembered too — a blob with no pixels must not be
        // re-decoded on every keystroke
        const composed = rgb ? renderBlocks(rgb, gridSize.cols, gridSize.rows, {truecolor: caps.truecolor}) : []
        setThumbs(previous => new Map(previous).set(key, composed))
      }
    })()
    return () => controller.abort()
  }, [isActive, drawsPixels, mode, visibleKey, gridSize.cols, gridSize.rows, caps.truecolor])

  const detailSha = mode === 'detail' ? current?.item.sha256 : undefined
  useEffect(() => {
    if (!isActive || !drawsPixels || !detailSha) return
    const controller = new AbortController()
    void (async () => {
      const key = thumbKey(detailSha, detailSize)
      if (thumbsRef.current.has(key)) return
      const rgb = await thumbRgb(detailSha, detailSize, controller.signal).catch(() => undefined)
      if (controller.signal.aborted) return
      const composed = rgb ? renderBlocks(rgb, detailSize.cols, detailSize.rows, {truecolor: caps.truecolor}) : []
      setThumbs(previous => new Map(previous).set(key, composed))
    })()
    return () => controller.abort()
  }, [isActive, drawsPixels, detailSha, detailSize.cols, detailSize.rows, caps.truecolor])

  useEffect(() => {
    if (!isActive || mode !== 'boards') return
    const controller = new AbortController()
    void (async () => {
      const items = await loadItems().catch(() => [] as Item[])
      if (controller.signal.aborted) return
      setBoards(boardCounts(items))
      setBoardIndex(0)
    })()
    return () => controller.abort()
  }, [isActive, mode])

  useEffect(() => {
    const publish = targetsRef.current
    if (!publish) return
    if (!isActive || mode !== 'grid') {
      publish([])
      return
    }
    publish(
      rectsFor(layout, visible.length, MARGIN / 2 + 1, HEADER_ROWS + 1, index => {
        setSelected(pageStart + index)
      }),
    )
  }, [isActive, mode, layout.perRow, layout.thumbCols, layout.thumbRows, visible.length, pageStart])

  useInput(
    (input, key) => {
      // the filter input owns every key while it's open — ink runs both
      // handlers, so an unguarded `b` here would open boards mid-word
      if (filtering) {
        if (key.escape) {
          setFiltering(false)
          setQuery('')
        }
        return
      }

      if (mode === 'detail') {
        if (key.escape || key.return) setMode('grid')
        return
      }

      if (mode === 'boards') {
        if (key.escape) setMode('grid')
        else if (key.return) {
          const picked = boards[boardIndex]
          if (picked) setBoard(picked.name)
          setMode('grid')
        } else if (input === 'j' || key.downArrow) setBoardIndex(index => Math.min(index + 1, boards.length - 1))
        else if (input === 'k' || key.upArrow) setBoardIndex(index => Math.max(index - 1, 0))
        return
      }

      if (key.escape) {
        // one level at a time: the search, then the board filter, then out
        if (query) setQuery('')
        else if (board) setBoard(undefined)
        else onExit()
        return
      }
      if (input === '/') {
        setFiltering(true)
        return
      }
      if (input === 'b') {
        setMode('boards')
        return
      }
      if (key.return) {
        if (hits.length) setMode('detail')
        return
      }

      const movement = key.leftArrow
        ? 'left'
        : key.rightArrow
          ? 'right'
          : key.upArrow
            ? 'up'
            : key.downArrow
              ? 'down'
              : input
      setSelected(index => moveSelection(index, movement, layout.perRow, hits.length))
    },
    {isActive: isActive && Boolean(process.stdin.isTTY)},
  )

  if (!isActive) return null

  const rowsOf = (hit: Hit, size: CellSize): string[] => {
    const sha256 = hit.item.sha256
    const composed = sha256 && drawsPixels ? thumbs.get(thumbKey(sha256, size)) : undefined
    return composed?.length ? composed : placeholderRows(size.cols, size.rows, hit.meta?.kind ?? 'no preview')
  }

  const cellRows: Hit[][] = []
  for (let index = 0; index < visible.length; index += layout.perRow) {
    cellRows.push(visible.slice(index, index + layout.perRow))
  }

  const count = `${hits.length} item${hits.length === 1 ? '' : 's'}`
  const scope = board ? ` · ${board}` : ''
  const paging = layout.pages > 1 ? ` · page ${Math.floor(selected / perPage) + 1}/${layout.pages}` : ''

  return (
    <Box width={columns} height={rows - 1} flexDirection="column" paddingX={2} backgroundColor={theme.background}>
      <Text>
        <Text color={theme.primary}>library</Text>
        <Text color={theme.gray} dimColor={theme.dimSecondary}>{`  ${count}${scope}${paging}`}</Text>
      </Text>

      {/* always one row, open or not, so opening the search can't shift the grid
          out from under a click rectangle */}
      {filtering ? (
        <Text>
          <Text color={theme.primary}>{'/ '}</Text>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={() => setFiltering(false)}
            placeholder="filter as you type…"
            width={Math.max(8, columns - 8)}
          />
        </Text>
      ) : (
        <Text color={theme.gray} dimColor={theme.dimSecondary}>{query ? `/ ${query}` : ' '}</Text>
      )}
      <Gap />

      {mode === 'grid' &&
        (hits.length === 0 ? (
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {!loaded
              ? 'reading your library…'
              : query || board
                ? 'nothing matches — esc clears it'
                : 'nothing yoinked yet — paste a link'}
          </Text>
        ) : (
          cellRows.map((row, rowIndex) => (
            <Box key={rowIndex} flexDirection="column" flexShrink={0}>
              <Box flexDirection="row" flexShrink={0}>
                {row.map((hit, column) => {
                  const isSelected = pageStart + rowIndex * layout.perRow + column === selected
                  const marker = isSelected ? '❯ ' : '  '
                  return (
                    <Box
                      key={hit.item.id}
                      flexDirection="column"
                      flexShrink={0}
                      width={layout.thumbCols}
                      marginRight={column === row.length - 1 ? 0 : GAP}
                    >
                      {rowsOf(hit, gridSize).map((line, index) => (
                        <Text key={index}>{line}</Text>
                      ))}
                      {/* the marker, not the color, is what says "selected" —
                          this has to survive NO_COLOR and a mono terminal */}
                      <Text
                        bold={isSelected}
                        color={isSelected ? theme.primary : theme.gray}
                        dimColor={!isSelected && theme.dimSecondary}
                      >
                        {`${isSelected ? '❯ ' : '  '}${truncate(titleFor(hit.item), Math.max(1, layout.thumbCols - 2))}`}
                      </Text>
                    </Box>
                  )
                })}
              </Box>
              <Gap />
            </Box>
          ))
        ))}

      {mode === 'detail' && current && (
        <Box flexDirection="column" flexShrink={0}>
          {rowsOf(current, detailSize).map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
          <Gap />
          <Text bold color={theme.primary}>{truncate(titleFor(current.item), Math.max(1, columns - MARGIN))}</Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {truncate(current.item.source.url, Math.max(1, columns - MARGIN))}
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {truncate(detailMeta(current), Math.max(1, columns - MARGIN))}
          </Text>
          <Gap />
          {(current.meta?.palette ?? []).slice(0, SWATCHES).map(entry => (
            <Text key={entry.hex}>
              <Text color={entry.hex}>{'███'}</Text>
              <Text color={theme.gray} dimColor={theme.dimSecondary}>{` ${entry.hex}`}</Text>
            </Text>
          ))}
        </Box>
      )}

      {mode === 'boards' && (
        <Box flexDirection="column" flexShrink={0}>
          {boards.length === 0 ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>no boards yet — capture with --board to make one</Text>
          ) : (
            boards.map((entry, index) => (
              <Text
                key={entry.name}
                bold={index === boardIndex}
                color={index === boardIndex ? theme.primary : theme.gray}
                dimColor={index !== boardIndex && theme.dimSecondary}
              >
                {`${index === boardIndex ? '❯ ' : '  '}${truncate(entry.name, 28).padEnd(30)}${entry.count}`}
              </Text>
            ))
          )}
        </Box>
      )}

      <Gap />
      <Shortcuts items={HINTS[mode]} />
    </Box>
  )
}

function detailMeta(hit: Hit): string {
  const parts: string[] = []
  if (hit.meta?.kind) parts.push(hit.meta.kind)
  if (hit.meta?.width && hit.meta?.height) parts.push(`${hit.meta.width}×${hit.meta.height}`)
  if (hit.item.boards.length) parts.push(hit.item.boards.join(', '))
  if (hit.item.tags.length) parts.push(hit.item.tags.map(tag => `#${tag}`).join(' '))
  return parts.join(' · ')
}
