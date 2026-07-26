import React from 'react'
import {createRequire} from 'node:module'
import {render} from 'ink'
import {App, type Outcome} from './app.js'
import {captureFrames} from './lib/click-map.js'
import {parseArgs} from './lib/args.js'
import {readClipboard} from './lib/clipboard.js'
import {isProbablyUrl} from './lib/platforms.js'

// read at runtime from the shipped package.json so npm version bumps
// can't drift from a hardcoded constant
const VERSION: string = createRequire(import.meta.url)('../package.json').version

const HELP = `
  yoinks — yoink any video. paste. yoink. done.

  Usage
    $ yoinks [url]
    $ yoinks <command>

  Examples
    $ yoinks https://youtu.be/dQw4w9WgXcQ
    $ yoinks https://dribbble.com/shots/…
    $ yoinks                 (prompts for a url)

  Commands
    lib [query]     browse your library
    doctor          report what's available on this machine

  Options
    --theme <mode>  use auto, light, or dark for this run
    -h, --help      show this help
    -v, --version   show version

  Captures land in your library (~/.yoinks). Video and audio are also
  saved to ~/Downloads.
  Powered by yt-dlp — YouTube, X, Instagram, Threads, TikTok & 1800+ sites.
`

const args = parseArgs(process.argv.slice(2))

if (args.error) {
  console.error(`yoinks: ${args.error}\nTry “yoinks --help” for usage.`)
  process.exit(1)
}

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

if (args.version) {
  console.log(VERSION)
  process.exit(0)
}

if (args.command === 'doctor') {
  const {doctor, formatDoctor} = await import('./lib/render/caps.js')
  console.log(formatDoctor(await doctor()))
  process.exit(0)
}

// Headless verbs never touch the alternate screen. --json is implied when
// stdout isn't a terminal, so `yoinks find dark | jq` needs no flag.
if (args.command && args.command !== 'lib') {
  const {commandFor, renderHuman} = await import('./lib/agent/commands.js')
  const {envelopeFor, exitCodeFor, render, wantsJson} = await import('./lib/agent/json.js')

  const run = commandFor(args.command)
  if (run) {
    const explicitJson = args.commandArgs.includes('--json') ? true : undefined
    const asJson = wantsJson(explicitJson, Boolean(process.stdout.isTTY))
    let envelope
    try {
      envelope = await run(args.commandArgs)
    } catch (error) {
      envelope = envelopeFor(error)
    }
    const out = asJson ? render(envelope) : renderHuman(args.command, envelope)
    if (envelope.ok) console.log(out)
    else console.error(out)
    process.exit(exitCodeFor(envelope))
  }
}

const initialUrl = args.initialUrl
const initialThemeMode = args.themeMode ?? 'auto'

const isTTY = Boolean(process.stdout.isTTY)

// no url given — offer the clipboard url (⇥ to paste) when it already holds one
let clipboardUrl: string | undefined
if (!initialUrl && isTTY) {
  const clipped = readClipboard().trim()
  // reject multi-line clipboard content — new URL() silently strips newlines
  if (clipped && !/\s/.test(clipped) && isProbablyUrl(clipped)) clipboardUrl = clipped
}
const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H')
// also switch mouse tracking off — a crash can skip React effect cleanup
const leaveAltScreen = () => process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')

if (isTTY) {
  enterAltScreen()
  process.on('exit', leaveAltScreen)
  // restore the terminal BEFORE a crash prints, or the stack trace is
  // wiped along with the alternate screen and the app looks like it
  // silently quit
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      leaveAltScreen()
      console.error(error)
      process.exit(1)
    })
  }
}

let outcome: Outcome = {}
const {waitUntilExit} = render(
  <App
    initialUrl={initialUrl}
    clipboardUrl={clipboardUrl}
    initialThemeMode={initialThemeMode}
    startInLibrary={args.command === 'lib'}
    onOutcome={result => (outcome = result)}
  />,
  // keep a copy of every frame so clicks can be hit-tested against it
  {stdout: captureFrames(process.stdout)},
)

await waitUntilExit()

if (isTTY) leaveAltScreen()
if (outcome.filepath) {
  console.log(`✓ yoinked → ${outcome.filepath}`)
}
