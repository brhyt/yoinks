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
  pluck — pluck anything. paste. pluck. done.

  Usage
    $ pluck [url]
    $ pluck <command>

  Examples
    $ pluck https://youtu.be/dQw4w9WgXcQ
    $ pluck https://dribbble.com/shots/…
    $ pluck                 (prompts for a url)

  Commands
    lib [query]         browse your library
    capture <url>       save without the picker (--best / --all)
    find <query>        search the library
    show <id>           one asset in full
    brief <query>       design brief + reference paths, for agents
    boards | tag | mv | note | rm | compact
    export | import     move a board between machines
    skill install       teach an agent to use your library
    mcp                 run the stdio MCP server
    doctor              report what's available on this machine

  Every command emits JSON with --json, and implies it when piped.

  Options
    --theme <mode>  use auto, light, or dark for this run
    -h, --help      show this help
    -v, --version   show version

  Captures land in your library (~/.pluck). Video and audio are also
  saved to ~/Downloads.
  Images, video, fonts and palettes from any page.
  Video powered by yt-dlp — YouTube, X, Instagram, TikTok & 1800+ sites.
`

const args = parseArgs(process.argv.slice(2))

if (args.error) {
  console.error(`pluck: ${args.error}\nTry “pluck --help” for usage.`)
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

// The mcp server owns stdio for its whole lifetime — it must never print
// anything that isn't a JSON-RPC frame, and it doesn't exit on its own.
if (args.command === 'mcp') {
  const {serveMcp} = await import('./lib/agent/mcp.js')
  serveMcp()
  // hold the module here: the server lives until the client disconnects, and
  // falling through would render the TUI into a JSON-RPC pipe
  await new Promise<void>(resolve => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
  })
  process.exit(0)
}

if (args.command && args.command !== 'lib') {
  const {commandFor, renderHuman} = await import('./lib/agent/commands.js')
  const {envelopeFor, exitCodeFor, render, wantsJson} = await import('./lib/agent/json.js')
  type Envelope<T> = import('./lib/agent/json.js').Envelope<T>

  // verbs that live outside commands.ts, kept lazy so a `pluck <url>` run
  // never pays to load the agent surface or the bundle codec
  const extra: Record<string, () => Promise<(a: string[]) => Promise<Envelope<unknown>>>> = {
    brief: async () => (await import('./lib/agent/brief.js')).cmdBrief,
    skill: async () => (await import('./lib/agent/skill.js')).cmdSkill,
    export: async () => (await import('./lib/store/bundle.js')).cmdExport,
    import: async () => (await import('./lib/store/bundle.js')).cmdImport,
  }

  const run = commandFor(args.command) ?? (extra[args.command] ? await extra[args.command]!() : undefined)
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
    // `pluck export > file.pluck` streams the bundle itself to stdout, so the
    // envelope has to go to stderr or it lands inside the tar and corrupts it
    const ownsStdout = args.command === 'export' && !args.commandArgs.includes('--out')
    if (envelope.ok && !ownsStdout) console.log(out)
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
  console.log(`✓ plucked → ${outcome.filepath}`)
}
