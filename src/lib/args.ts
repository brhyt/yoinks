import {isThemeMode, type ThemeMode} from '../theme.js'

/** Verbs. A bare `yoinks` or `yoinks <url>` has no command — you just paste. */
export const COMMANDS = [
  'doctor',
  'lib',
  'capture',
  'find',
  'show',
  'boards',
  'tag',
  'mv',
  'note',
  'rm',
  'compact',
] as const
export type Command = (typeof COMMANDS)[number]

const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value)

export type CliArgs = {
  help: boolean
  version: boolean
  command?: Command
  /** whatever followed the command — a library query, say */
  commandArgs: string[]
  initialUrl?: string
  themeMode?: ThemeMode
  error?: string
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {help: false, version: false, commandArgs: []}
  const positional: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    // Everything after a verb belongs to that verb. Commands own flags this
    // parser has never heard of (--board, --dry-run, --color), so it must stop
    // reading rather than reject them.
    if (!arg.startsWith('-') && isCommand(arg) && positional.length === 0) {
      result.command = arg
      result.commandArgs = args.slice(index + 1)
      return result
    }

    if (arg === '-h' || arg === '--help') {
      result.help = true
    } else if (arg === '-v' || arg === '--version') {
      result.version = true
    } else if (arg === '--theme') {
      const value = args[++index]
      if (!value) return {...result, error: '--theme needs a value: auto, light, or dark'}
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg.startsWith('--theme=')) {
      const value = arg.slice('--theme='.length)
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg.startsWith('-')) {
      return {...result, error: `unknown option “${arg}”`}
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) return {...result, error: 'expected a single url'}
  result.initialUrl = positional[0]
  return result
}
