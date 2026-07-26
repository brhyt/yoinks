import {isThemeMode, type ThemeMode} from '../theme.js'

/** Verbs. A bare `yoinks` or `yoinks <url>` has no command — you just paste. */
export const COMMANDS = ['doctor', 'lib'] as const
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

  const [first, ...rest] = positional
  if (first !== undefined && isCommand(first)) {
    result.command = first
    result.commandArgs = rest
    return result
  }

  if (positional.length > 1) return {...result, error: 'expected a single url'}
  result.initialUrl = first
  return result
}
