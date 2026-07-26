import {spawn} from 'node:child_process'
import type {Dirent} from 'node:fs'
import fs from 'node:fs/promises'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {resolveFfmpeg} from '../ffmpeg.js'
import {formatBytes, shortenPath} from '../format.js'
import {loadItems} from '../store/log.js'
import {binDir, blobsDir, yoinksHome} from '../store/paths.js'
import type {Caps, Protocol} from './types.js'

/**
 * What this terminal can draw, and what `yoinks doctor` reports.
 *
 * Detection is one pure function over an environment object. There is no
 * query-the-terminal handshake anywhere in here on purpose: every protocol
 * probe is a write-then-read-with-timeout against a tty that may be a pipe, a
 * tmux pane or an ssh session, and getting it wrong hangs the app before it has
 * drawn a frame. Environment variables are a weaker signal that is always
 * instant, never blocks, and is trivially testable — and when it guesses wrong,
 * `YOINKS_GRAPHICS` is one word in a shell profile.
 *
 * See docs/rendering.md#detection.
 */

function isProtocol(value: string): value is Protocol {
  return value === 'kitty' || value === 'iterm' || value === 'blocks' || value === 'off'
}

/** Pure: decide the rendering protocol from environment alone. */
export function detectCaps(env: NodeJS.ProcessEnv = process.env): Caps {
  const term = env.TERM ?? ''

  const caps = (protocol: Protocol, reason: string): Caps => ({
    protocol,
    // truecolor is a fact about the terminal, not about the protocol — but with
    // color switched off there is nothing left to be 24-bit about
    truecolor: protocol !== 'off' && (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit'),
    reason,
  })

  const forced = env.YOINKS_GRAPHICS?.trim().toLowerCase()
  // sixel is deferred (docs/rendering.md#sixel). Quietly honoring the request as
  // blocks without saying so is how somebody spends an evening wondering why
  // their sixel terminal looks like everyone else's.
  if (forced === 'sixel') return caps('blocks', 'YOINKS_GRAPHICS=sixel — sixel is not implemented, using blocks')
  if (forced && isProtocol(forced)) return caps(forced, `YOINKS_GRAPHICS=${forced}`)
  // anything else falls through to detection rather than failing: a typo in a
  // shell profile should not cost you thumbnails

  // the standard reads an empty value as unset, so `NO_COLOR=` is not NO_COLOR
  if (env.NO_COLOR) return caps('off', 'NO_COLOR set')

  // graphics escapes need passthrough wrapping inside tmux and get clipped wrong
  // on pane resize, so blocks is the honest default there
  if (env.TMUX) return caps('blocks', 'inside tmux — graphics escapes need passthrough')
  if (/^(screen|tmux)/.test(term)) {
    return caps('blocks', `TERM=${term} — inside tmux/screen, graphics escapes need passthrough`)
  }

  // Over ssh TERM survives but TERM_PROGRAM usually does not, so kitty and
  // ghostty still detect below via TERM/KITTY_WINDOW_ID while iTerm2 falls back
  // to blocks. That's acceptable, and YOINKS_GRAPHICS=iterm is the override.
  const program = env.TERM_PROGRAM ?? ''
  if (program === 'iTerm.app') return caps('iterm', 'TERM_PROGRAM=iTerm.app')
  if (program === 'ghostty' || program === 'WezTerm') return caps('kitty', `TERM_PROGRAM=${program}`)
  if (env.KITTY_WINDOW_ID) return caps('kitty', 'KITTY_WINDOW_ID set')
  if (term.includes('kitty')) return caps('kitty', `TERM=${term}`)

  return caps('blocks', term ? `no graphics protocol detected (TERM=${term})` : 'no graphics protocol detected')
}

export type DoctorReport = {
  versions: {yoinks: string; node: string; ytdlp?: string; ffmpeg?: string}
  caps: Caps
  home: string
  library: {items: number; blobs: number; bytes: number}
}

export async function doctor(): Promise<DoctorReport> {
  const [ytdlp, ffmpeg, library] = await Promise.all([ytdlpVersion(), ffmpegVersion(), scanLibrary()])
  return {
    versions: {
      yoinks: yoinksVersion(),
      node: process.version.replace(/^v/, ''),
      ytdlp,
      ffmpeg,
    },
    caps: detectCaps(),
    home: yoinksHome(),
    library,
  }
}

/**
 * Read from the shipped package.json so an npm version bump can't drift from a
 * constant. The specifier climbs because this file sits three deep in source
 * and is bundled into `dist/cli.js` one deep — either fixed depth is wrong in
 * one of the two.
 */
function yoinksVersion(): string {
  const load = createRequire(import.meta.url)
  let specifier = '../package.json'
  for (let up = 0; up < 5; up++) {
    try {
      const pkg = load(specifier) as {version?: string}
      if (pkg?.version) return pkg.version
    } catch {
      // not this level
    }
    specifier = `../${specifier}`
  }
  return 'unknown'
}

/**
 * The yt-dlp already installed — never the download `ensureYtDlp` would do. A
 * report that installs something is not a report.
 */
async function ytdlpVersion(): Promise<string | undefined> {
  const local = path.join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  for (const cmd of ['yt-dlp', local]) {
    const version = await firstLine(cmd, ['--version'])
    if (version) return version
  }
  return undefined
}

async function ffmpegVersion(): Promise<string | undefined> {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return undefined
  const line = await firstLine(ffmpeg, ['-version'])
  // "ffmpeg version 8.1 Copyright (c) …" — the copyright line is noise in a
  // report meant to be scanned at a glance
  return /^ffmpeg version (\S+)/.exec(line ?? '')?.[1] ?? line
}

/** First stdout line of `cmd args`. Never throws — a missing binary is information. */
function firstLine(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000})
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    child.stdout?.on('data', chunk => (out += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', code => {
      const line = out.split('\n')[0]?.trim()
      resolve(code === 0 && line ? line : undefined)
    })
  })
}

async function scanLibrary(): Promise<{items: number; blobs: number; bytes: number}> {
  const items = await loadItems().catch(() => [])

  let blobs = 0
  let bytes = 0
  // blobs/<first two hex>/<sha256>/<original + meta.json>, so one blob is one
  // directory two levels down — counting files would count meta.json as content
  const root = blobsDir()
  for (const shard of await entries(root)) {
    if (!shard.isDirectory()) continue
    const shardDir = path.join(root, shard.name)
    for (const blob of await entries(shardDir)) {
      if (!blob.isDirectory()) continue
      blobs++
      const blobPath = path.join(shardDir, blob.name)
      for (const file of await entries(blobPath)) {
        if (file.isFile()) bytes += await sizeOf(path.join(blobPath, file.name))
      }
    }
  }

  return {items: items.length, blobs, bytes}
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, {withFileTypes: true})
  } catch {
    return [] // no library yet is zeros, not an error
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

const LABEL_WIDTH = 18
const VALUE_WIDTH = 13

function row(label: string, value: string, note?: string): string {
  const body = note ? `${value.padEnd(VALUE_WIDTH)}${note}` : value
  return `  ${label.padEnd(LABEL_WIDTH)}${body}`
}

/** Plain aligned text, no ansi — doctor output gets pasted into bug reports and piped. */
export function formatDoctor(report: DoctorReport): string {
  const {versions, caps, library} = report
  const count = (n: number) => n.toLocaleString('en-US')

  return [
    row('yoinks', versions.yoinks),
    row('node', versions.node),
    versions.ytdlp ? row('yt-dlp', versions.ytdlp) : row('yt-dlp', 'not found', 'captures from video sites need it'),
    versions.ffmpeg
      ? row('ffmpeg', versions.ffmpeg)
      : row('ffmpeg', 'not found', 'thumbnails degrade to placeholders'),
    row('graphics', caps.protocol, caps.reason),
    row('color', caps.truecolor ? '24-bit' : caps.protocol === 'off' ? 'off' : '256-color'),
    row(
      'library',
      `${count(library.items)} items · ${count(library.blobs)} blobs · ${formatBytes(library.bytes) || '0 B'}`,
    ),
    row('home', shortenPath(report.home, os.homedir(), 200)),
  ].join('\n')
}
