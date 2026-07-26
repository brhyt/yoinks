import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', () => {
  assert.deepEqual(parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    commandArgs: [],
    themeMode: 'light',
    initialUrl: 'https://example.com/video',
  })
})

test('parses an equals-style theme option after the url', () => {
  assert.deepEqual(parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    commandArgs: [],
    themeMode: 'dark',
    initialUrl: 'https://example.com/video',
  })
})

test('rejects missing, invalid, and unknown options', () => {
  assert.match(parseArgs(['--theme']).error ?? '', /needs a value/)
  assert.match(parseArgs(['--theme', 'sepia']).error ?? '', /unknown theme/)
  assert.match(parseArgs(['--wat']).error ?? '', /unknown option/)
  assert.match(parseArgs(['one', 'two']).error ?? '', /single url/)
})

test('a leading verb is a command, and the rest is its arguments', () => {
  assert.equal(parseArgs(['doctor']).command, 'doctor')
  assert.equal(parseArgs(['doctor']).initialUrl, undefined)

  const lib = parseArgs(['lib', 'dark', 'editorial'])
  assert.equal(lib.command, 'lib')
  assert.deepEqual(lib.commandArgs, ['dark', 'editorial'])
  assert.equal(lib.error, undefined)
})

test('a command still takes options', () => {
  const parsed = parseArgs(['lib', '--theme', 'dark', 'brutalist'])
  assert.equal(parsed.command, 'lib')
  assert.equal(parsed.themeMode, 'dark')
  assert.deepEqual(parsed.commandArgs, ['brutalist'])
})

test('a url is still a url, not a command', () => {
  const parsed = parseArgs(['https://example.com/video'])
  assert.equal(parsed.command, undefined)
  assert.equal(parsed.initialUrl, 'https://example.com/video')
  // two bare words that aren't a command are still the old error
  assert.match(parseArgs(['one', 'two']).error ?? '', /single url/)
})

test('recognizes only supported modes and cycles through all of them', () => {
  assert.equal(isThemeMode('auto'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('sepia'), false)
  assert.equal(nextThemeMode('auto'), 'light')
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'auto')
})

test('auto delegates to terminal colors while forced modes own the full surface', () => {
  assert.deepEqual(themeFor('auto'), {
    mode: 'auto',
    primary: undefined,
    gray: undefined,
    dark: undefined,
    background: undefined,
    dimSecondary: true,
    inverseButton: true,
  })

  assert.equal(themeFor('light').background, '#ffffff')
  assert.equal(themeFor('light').primary, '#18181b')
  assert.equal(themeFor('dark').background, '#18181b')
  assert.equal(themeFor('dark').primary, '#ffffff')
})
