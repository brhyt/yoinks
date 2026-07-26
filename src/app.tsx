import React, {useCallback, useEffect, useRef, useState} from 'react'
import os from 'node:os'
import path from 'node:path'
import {Box, Text, useApp, useInput, useStdout} from 'ink'
import SelectInput, {type IndicatorProps, type ItemProps} from 'ink-select-input'
import Spinner from 'ink-spinner'
import {FramedInput} from './components/framed-input.js'
import {FullScreen} from './components/fullscreen.js'
import {Logo} from './components/logo.js'
import {Panel} from './components/panel.js'
import {ProgressBar} from './components/progress-bar.js'
import {Shortcuts} from './components/shortcuts.js'
import {TextInput} from './components/text-input.js'
import {clickTargetAt, findFrameRow, frameRowSpan, type ClickTarget} from './lib/click-map.js'
import {formatBytes, formatDuration, formatEta, formatSpeed, shortenPath, truncate, wrapText} from './lib/format.js'
import {addToHistory, loadHistory} from './lib/history.js'
import {detectPlatform, isProbablyUrl, type Platform} from './lib/platforms.js'
import {useMouseClick} from './lib/use-mouse-click.js'
import {nextThemeMode, ThemeProvider, type ThemeMode, useTheme} from './theme.js'
import {probeUrl} from './lib/extract/index.js'
import type {Candidate, FetchProgress, Kind} from './lib/extract/types.js'
import {deriveBlob} from './lib/store/derive.js'
import {ingest} from './lib/store/ingest.js'
import {LibraryScreen} from './components/library.js'
import fs from 'node:fs/promises'

const OUT_DIR = path.join(os.homedir(), 'Downloads')
const PLUCK_BUTTON = 'pluck'
const DONE_LABEL = '↵ pluck another'
const TAGLINE = 'pluck anything. paste. pluck. done.'

// video and audio keep the glyphs 0.3.1 shipped — a youtube url must look
// exactly as it always has
const GLYPH: Record<Kind, string> = {
  video: '▶ ',
  audio: '♪ ',
  image: '▧ ',
  font: 'A ',
  palette: '◈ ',
  page: '▤ ',
  snippet: '⌘ ',
}

const candidateLabel = (candidate: Candidate) => `${GLYPH[candidate.kind]}${candidate.label}`

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

/** Page <title>, for the header on captures that aren't videos. */
function titleFromHtml(html: string | undefined): string | undefined {
  if (!html) return undefined
  const found = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  return found?.replace(/\s+/g, ' ').trim() || undefined
}

function ChoiceIndicator({isSelected}: IndicatorProps) {
  const theme = useTheme()
  return (
    <Box marginRight={1}>
      <Text color={theme.primary}>{isSelected ? '❯' : ' '}</Text>
    </Box>
  )
}

function ChoiceItem({isSelected, label}: ItemProps) {
  const theme = useTheme()
  return (
    <Text color={theme.primary} bold={isSelected}>
      {label}
    </Text>
  )
}

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

// fixed-width slots — the centered line must not change width as values tick,
// otherwise the whole layout shifts on every progress update
function partLabel(progress: FetchProgress): string {
  // explains the bar resetting between files (video, then audio)
  return progress.totalParts > 1 ? `part ${progress.part + 1}/${progress.totalParts}  ` : ''
}

function downloadMeta(progress: FetchProgress): string {
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  const eta = progress.eta ? `${formatEta(progress.eta)} left` : ''
  return `${partLabel(progress)}${speed.padStart(10)}  ${eta.padEnd(12)}`
}

function indeterminateMeta(progress: FetchProgress): string {
  const bytes = formatBytes(progress.downloadedBytes)
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  return `${partLabel(progress)}${bytes.padStart(8)}  ${speed.padEnd(10)}`
}

export type Outcome = {filepath?: string}

type Phase =
  | {name: 'library'}
  | {name: 'input'; warning?: string}
  | {name: 'probing'; status: string}
  | {name: 'picking'}
  | {
      name: 'downloading'
      candidate: Candidate
      progress?: FetchProgress
      processing: boolean
      status?: string
    }
  | {name: 'done'; filepath: string}
  | {name: 'error'; message: string}

const HINTS: Record<Phase['name'], Array<[string, string]>> = {
  library: [
    ['hjkl', 'move'],
    ['/', 'search'],
    ['↵', 'open'],
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  input: [
    ['↵', 'pluck'],
    ['l', 'library'],
    ['^c', 'quit'],
  ],
  probing: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  picking: [
    ['↑↓', 'choose'],
    ['↵', 'pluck'],
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  downloading: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  done: [['^c', 'quit']],
  error: [
    ['↵', 'try again'],
    ['^c', 'quit'],
  ],
}

type AppProps = {
  initialUrl?: string
  clipboardUrl?: string
  initialThemeMode?: ThemeMode
  /** start in the library rather than at the paste box (`pluck lib`) */
  startInLibrary?: boolean
  onOutcome: (outcome: Outcome) => void
}

export function App({initialThemeMode = 'auto', ...props}: AppProps) {
  const [themeMode, setThemeMode] = useState(initialThemeMode)
  const cycleTheme = useCallback(() => {
    setThemeMode(nextThemeMode)
  }, [])

  return (
    <ThemeProvider mode={themeMode}>
      <AppContent {...props} cycleTheme={cycleTheme} />
    </ThemeProvider>
  )
}

function AppContent({
  initialUrl,
  clipboardUrl,
  startInLibrary,
  onOutcome,
  cycleTheme,
}: {
  initialUrl?: string
  clipboardUrl?: string
  startInLibrary?: boolean
  onOutcome: (outcome: Outcome) => void
  cycleTheme: () => void
}) {
  const theme = useTheme()
  const {exit} = useApp()
  const {stdout} = useStdout()
  const [url, setUrl] = useState(initialUrl ?? '')
  const [urlInput, setUrlInput] = useState('')
  const [history, setHistory] = useState(loadHistory)
  const [platform, setPlatform] = useState<Platform>()
  const [subject, setSubject] = useState<{title?: string; duration?: number; uploader?: string}>({})
  const [candidates, setCandidates] = useState<Candidate[]>([])
  // the cursor follows a candidate key, never an index — extractors stream in
  // and a late arrival must not move the selection under someone's finger
  const highlightKeyRef = useRef('')
  const abortRef = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(
    initialUrl ? {name: 'probing', status: 'warming up…'} : startInLibrary ? {name: 'library'} : {name: 'input'},
  )
  const [libraryTargets, setLibraryTargets] = useState<ClickTarget[]>([])

  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80
  const libraryRows = Math.max(6, (stdout?.rows && stdout.rows > 1 ? stdout.rows : 24) - 1)
  const boxWidth = Math.max(14, Math.min(64, columns - 6))
  const contentWidth = Math.max(10, Math.min(columns - 4, 78))

  const startProbe = useCallback(async (targetUrl: string) => {
    const controller = new AbortController()
    abortRef.current = controller
    setPlatform(detectPlatform(targetUrl))
    setSubject({})
    setCandidates([])
    highlightKeyRef.current = ''
    setPhase({name: 'probing', status: 'warming up…'})

    try {
      for await (const event of probeUrl(targetUrl, {signal: controller.signal})) {
        if (controller.signal.aborted) return

        if (event.type === 'status') {
          setPhase(prev => (prev.name === 'probing' ? {name: 'probing', status: event.message} : prev))
        } else if (event.type === 'classified') {
          const title = titleFromHtml(event.classification.html)
          if (title) setSubject(prev => ({...prev, title: prev.title ?? title}))
        } else if (event.type === 'candidates') {
          const best = event.candidates.find(candidate => candidate.hint?.title)
          if (best?.hint) {
            setSubject(prev => ({
              title: best.hint?.title ?? prev.title,
              duration: best.hint?.duration ?? prev.duration,
              uploader: prev.uploader,
            }))
          }
          setCandidates(event.candidates)
          if (!highlightKeyRef.current) highlightKeyRef.current = event.candidates[0]?.key ?? ''
          setPhase(prev => (prev.name === 'probing' ? {name: 'picking'} : prev))
        } else if (event.type === 'done') {
          if (event.candidates.length === 0) {
            setPhase({name: 'error', message: 'Nothing pluckable at that link.'})
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return
      setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
    }
  }, [])

  useEffect(() => {
    if (initialUrl) void startProbe(initialUrl)
  }, [initialUrl, startProbe])

  const resetToInput = useCallback(() => {
    setUrl('')
    setUrlInput('')
    setPlatform(undefined)
    setSubject({})
    setCandidates([])
    highlightKeyRef.current = ''
    setPhase({name: 'input'})
  }, [])

  const cancelRun = useCallback(() => {
    abortRef.current?.abort()
    resetToInput()
    setUrlInput(url) // keep the link around so a cancel isn't destructive
  }, [resetToInput, url])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        cycleTheme()
        return
      }
      if (input === 'l' && phase.name === 'input' && urlInput === '') {
        setPhase({name: 'library'})
        return
      }
      if (key.escape && (phase.name === 'picking' || phase.name === 'error' || phase.name === 'done')) resetToInput()
      if (key.escape && (phase.name === 'probing' || phase.name === 'downloading')) cancelRun()
      if (key.return && (phase.name === 'error' || phase.name === 'done')) resetToInput()
    },
    {isActive: Boolean(process.stdin.isTTY)},
  )

  const handleUrlSubmit = (value: string) => {
    const trimmed = value.trim()
    if (!isProbablyUrl(trimmed)) {
      setPhase({name: 'input', warning: 'that doesn’t look like a link — paste a full url'})
      return
    }
    setUrl(trimmed)
    void startProbe(trimmed)
  }

  const clipboardOffered = Boolean(clipboardUrl) && urlInput === ''
  const clipboardAccepted = Boolean(clipboardUrl) && urlInput === clipboardUrl

  const handlePick = (candidate: Candidate | undefined) => {
    if (!candidate) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase({name: 'downloading', candidate, processing: false})

    void (async () => {
      // video and audio still land in ~/Downloads — that's what people
      // installed a video downloader for. Everything else goes straight to the
      // library rather than cluttering the folder.
      const keepsFile = candidate.kind === 'video' || candidate.kind === 'audio'
      const outDir = keepsFile ? OUT_DIR : path.join(os.tmpdir(), `pluck-${process.pid}`)

      try {
        const fetched = await candidate.fetch(
          {
            outDir,
            onProgress: progress =>
              setPhase(prev => (prev.name === 'downloading' ? {...prev, progress, processing: false} : prev)),
            onStatus: status =>
              setPhase(prev =>
                prev.name === 'downloading' ? {...prev, processing: true, status, progress: undefined} : prev,
              ),
          },
          controller.signal,
        )

        setPhase(prev =>
          prev.name === 'downloading'
            ? {...prev, processing: true, status: 'adding to your library…', progress: undefined}
            : prev,
        )
        const stored = await ingest({
          path: fetched.path,
          kind: candidate.kind,
          mime: fetched.mime ?? candidate.hint?.mime,
          source: {
            url,
            site: hostOf(url),
            title: subject.title ?? candidate.hint?.title,
            extractor: candidate.extractor,
          },
        })

        // derivation is a nice-to-have and must never block or fail a capture
        // that already succeeded
        void deriveBlob(stored.sha256).catch(() => {})
        if (!keepsFile) await fs.rm(fetched.path, {force: true})

        const filepath = keepsFile ? fetched.path : stored.blobPath
        onOutcome({filepath})
        setHistory(addToHistory(url))
        setPhase({name: 'done', filepath})
      } catch (error) {
        if (controller.signal.aborted) return
        setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
      }
    })()
  }

  const highlighted = candidates.find(c => c.key === highlightKeyRef.current) ?? candidates[0]

  let hints: Array<[string, string]> = [...HINTS[phase.name], ['^t', `theme:${theme.mode}`]]
  if (phase.name === 'input' && history.length > 0) {
    hints = [hints[0]!, ['↑', 'history'], ...hints.slice(1)]
  }

  // Anything a mouse user would expect to press is clickable. Targets are
  // found by their text in the rendered frame (see lib/click-map.ts), so
  // there is no layout math to keep in sync.
  const hintAction = (key: string): (() => void) | undefined => {
    if (key === '^c') return () => exit()
    if (key === '^t') return cycleTheme
    if (key === 'esc') return phase.name === 'probing' || phase.name === 'downloading' ? cancelRun : resetToInput
    if (key === '↵') {
      if (phase.name === 'input') return () => handleUrlSubmit(urlInput)
      if (phase.name === 'picking') return () => handlePick(highlighted)
      if (phase.name === 'error' || phase.name === 'done') return resetToInput
    }
    return undefined // ↑↓ / ↑ stay keyboard-only
  }
  const clickTargets: ClickTarget[] = []
  if (phase.name === 'input') {
    // the frame button rows above/below the label are part of the button
    clickTargets.push({match: `  ${PLUCK_BUTTON}  `, padY: 1, action: () => handleUrlSubmit(urlInput)})
  }
  if (phase.name === 'picking') {
    for (const candidate of candidates) {
      clickTargets.push({match: candidateLabel(candidate), action: () => handlePick(candidate)})
    }
  }
  if (phase.name === 'done') {
    clickTargets.push({match: DONE_LABEL, padX: 4, padY: 1, action: resetToInput})
  }
  // the grid renders as a wall of identical half-blocks, so it registers its own
  // cell rectangles rather than relying on frame-text matching
  if (phase.name === 'library') clickTargets.push(...libraryTargets)
  for (const [key, label] of hints) {
    const action = hintAction(key)
    if (action) clickTargets.push({match: `${key} ${label}`, action})
  }

  useMouseClick(
    (x, y) => {
      // the logo takes you home — it's the 3 rows one gap above the tagline
      const taglineRow = findFrameRow(TAGLINE)
      if (taglineRow > 3 && y - 1 >= taglineRow - 4 && y - 1 <= taglineRow - 2) {
        const span = frameRowSpan(y - 1)
        if (span && x >= span[0] - 1 && x <= span[1] + 1) {
          if (phase.name === 'probing' || phase.name === 'downloading') cancelRun()
          else if (phase.name !== 'input') resetToInput()
          return
        }
      }
      clickTargetAt(x, y, clickTargets)?.action()
    },
    Boolean(process.stdin.isTTY),
  )

  // The library owns the whole screen. It registers click rectangles against
  // its own geometry assuming it sits at the top-left, so it must not be
  // centred inside FullScreen or wrapped in the logo/hints chrome.
  if (phase.name === 'library') {
    return (
      <Box width={columns} height={libraryRows} flexDirection="column" flexShrink={0}>
        <LibraryScreen
          isActive
          columns={columns}
          rows={libraryRows}
          onExit={resetToInput}
          onClickTargets={setLibraryTargets}
        />
      </Box>
    )
  }

  return (
    <FullScreen>
      <Logo />
      <Gap />
      <Text color={theme.primary}>{TAGLINE}</Text>
      <Text color={theme.gray} dimColor={theme.dimSecondary}>images · video · fonts · palettes · from any page</Text>
      <Gap />

      {phase.name === 'input' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title="Paste a link" width={boxWidth} button={PLUCK_BUTTON}>
            <TextInput
              value={urlInput}
              onChange={setUrlInput}
              onSubmit={handleUrlSubmit}
              placeholder="https://youtube.com/watch?v=…"
              width={boxWidth - 6}
              history={history}
              submitOnPaste={isProbablyUrl}
              onTab={() => {
                if (clipboardOffered) setUrlInput(clipboardUrl!)
              }}
            />
          </FramedInput>
          {phase.warning ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>✗ {phase.warning}</Text>
          ) : clipboardOffered ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>link in your clipboard — ⇥ to paste it</Text>
          ) : clipboardAccepted ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>from your clipboard — ↵ to pluck it</Text>
          ) : null}
        </Box>
      )}

      {phase.name === 'probing' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title={platform ? platform.label : 'Paste a link'} width={boxWidth} button={PLUCK_BUTTON} buttonDim>
            <Text color={theme.gray} dimColor={theme.dimSecondary}>{url.length > boxWidth - 8 ? `${url.slice(0, boxWidth - 9)}…` : url}</Text>
          </FramedInput>
        </Box>
      )}

      {phase.name === 'picking' && platform && (
        <Box width={contentWidth}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingTop={1} paddingRight={3}>
            {/* wrapped by hand so continuation lines stay flush left —
                ink's wrapping keeps the break's space as a 1-cell indent */}
            {wrapText(subject.title ?? '', Math.max(10, contentWidth - 41)).map((line, index) => (
              <Text key={index} bold color={theme.primary}>
                {line}
              </Text>
            ))}
            <Gap />
            <Text color={theme.gray} dimColor={theme.dimSecondary}>
              ▸ {platform.label}
              {subject.duration ? ` · ${formatDuration(subject.duration)}` : ''}
              {subject.uploader ? ` · ${subject.uploader}` : ''}
            </Text>
          </Box>
          <Panel title="Download" width={38}>
            <SelectInput
              // remount when the candidate set changes so the cursor lands back
              // on the remembered key rather than drifting with the index
              key={candidates.map(c => c.key).join('|')}
              initialIndex={Math.max(
                0,
                candidates.findIndex(c => c.key === highlightKeyRef.current),
              )}
              indicatorComponent={ChoiceIndicator}
              itemComponent={ChoiceItem}
              items={candidates.map(candidate => ({
                key: candidate.key,
                label: candidateLabel(candidate),
                value: candidate.key,
              }))}
              onSelect={item => handlePick(candidates.find(c => c.key === item.value))}
              onHighlight={item => (highlightKeyRef.current = String(item.value))}
            />
          </Panel>
        </Box>
      )}

      {phase.name === 'downloading' && (
        <Box flexDirection="column" alignItems="center">
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {subject.title ? `${truncate(subject.title, 42)} · ` : ''}
            {phase.candidate.label}
          </Text>
          <Gap />
          {/* every branch is exactly three rows — bar, gap, meta — so the layout never jumps */}
          {phase.processing ? (
            <>
              <ProgressBar percent={1} />
              <Gap />
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}> {phase.status ?? 'processing…'}</Text>
              </Text>
            </>
          ) : phase.progress?.totalBytes ? (
            <>
              <ProgressBar percent={phase.progress.downloadedBytes / phase.progress.totalBytes} />
              <Gap />
              <Text color={theme.gray} dimColor={theme.dimSecondary}>{downloadMeta(phase.progress)}</Text>
            </>
          ) : phase.progress ? (
            <>
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}> downloading…</Text>
              </Text>
              <Gap />
              <Text color={theme.gray} dimColor={theme.dimSecondary}>{indeterminateMeta(phase.progress)}</Text>
            </>
          ) : (
            <>
              <ProgressBar percent={0} />
              <Gap />
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}>
                  {phase.status ? ` ${phase.status}` : ' starting download…'}
                </Text>
              </Text>
            </>
          )}
        </Box>
      )}

      {phase.name === 'done' && (
        <Box flexDirection="column" alignItems="center">
          <Text>
            <Text bold color={theme.primary}>✓ plucked! </Text>
            <Text color={theme.primary}>find your file in:</Text>
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{shortenPath(phase.filepath, os.homedir(), 60)}</Text>
          <Gap />
          <Box
            borderStyle="round"
            borderColor={theme.gray}
            borderDimColor={theme.dimSecondary}
            borderBackgroundColor={theme.background}
            paddingX={3}
          >
            <Text bold color={theme.primary}>{DONE_LABEL}</Text>
          </Box>
        </Box>
      )}

      {phase.name === 'error' && (
        <Box flexDirection="column" alignItems="center" width={Math.max(10, Math.min(columns - 6, 72))}>
          <Text bold color={theme.primary}>✗ {phase.message}</Text>
        </Box>
      )}

      {hints.length > 0 ? (
        <>
          <Gap lines={2} />
          <Shortcuts
            items={hints}
            leading={
              phase.name === 'probing' ? (
                <Text>
                  <Text color={theme.primary}>
                    <Spinner type="dots" />
                  </Text>
                  <Text color={theme.gray} dimColor={theme.dimSecondary}> {phase.status}</Text>
                </Text>
              ) : undefined
            }
          />
        </>
      ) : null}
    </FullScreen>
  )
}
