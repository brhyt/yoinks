import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {detectCaps, doctor, formatDoctor, type DoctorReport} from './caps.js'

const FORCED = ['kitty', 'iterm', 'blocks', 'off'] as const

test('PLUCK_GRAPHICS is obeyed and stops detection dead', () => {
  for (const forced of FORCED) {
    // every other signal set, and pointing somewhere else
    const caps = detectCaps({
      PLUCK_GRAPHICS: forced,
      NO_COLOR: '1',
      TMUX: '/tmp/tmux-501/default,1,0',
      TERM_PROGRAM: 'iTerm.app',
      TERM: 'xterm-kitty',
    })
    assert.equal(caps.protocol, forced)
    assert.equal(caps.reason, `PLUCK_GRAPHICS=${forced}`)
  }
})

test('the override is case- and whitespace-tolerant', () => {
  assert.equal(detectCaps({PLUCK_GRAPHICS: ' Kitty '}).protocol, 'kitty')
})

test('sixel is accepted, drawn as blocks, and says so', () => {
  const caps = detectCaps({PLUCK_GRAPHICS: 'sixel'})
  assert.equal(caps.protocol, 'blocks')
  assert.match(caps.reason, /sixel/)
  assert.match(caps.reason, /not implemented/)
})

test('an unrecognised PLUCK_GRAPHICS value falls through to detection', () => {
  // a typo in a shell profile must not cost you thumbnails
  const caps = detectCaps({PLUCK_GRAPHICS: 'sixl', TERM_PROGRAM: 'ghostty'})
  assert.equal(caps.protocol, 'kitty')
  assert.equal(caps.reason, 'TERM_PROGRAM=ghostty')
})

test('an empty PLUCK_GRAPHICS is not an override', () => {
  assert.equal(detectCaps({PLUCK_GRAPHICS: '', TERM_PROGRAM: 'iTerm.app'}).protocol, 'iterm')
})

test('NO_COLOR beats tmux and beats every terminal signal', () => {
  const caps = detectCaps({
    NO_COLOR: '1',
    TMUX: '/tmp/tmux-501/default,1,0',
    TERM_PROGRAM: 'iTerm.app',
    COLORTERM: 'truecolor',
  })
  assert.equal(caps.protocol, 'off')
  assert.equal(caps.truecolor, false)
  assert.equal(caps.reason, 'NO_COLOR set')
})

test('an empty NO_COLOR is not NO_COLOR', () => {
  // the standard reads an empty value as unset
  assert.equal(detectCaps({NO_COLOR: '', TERM_PROGRAM: 'iTerm.app'}).protocol, 'iterm')
})

test('tmux beats TERM_PROGRAM, detected via TMUX or via TERM', () => {
  const viaTmuxVar = detectCaps({TMUX: '/tmp/tmux-501/default,1,0', TERM_PROGRAM: 'ghostty'})
  assert.equal(viaTmuxVar.protocol, 'blocks')
  assert.match(viaTmuxVar.reason, /tmux/)

  const viaScreenTerm = detectCaps({TERM: 'screen-256color', TERM_PROGRAM: 'iTerm.app'})
  assert.equal(viaScreenTerm.protocol, 'blocks')
  assert.match(viaScreenTerm.reason, /screen-256color/)

  const viaTmuxTerm = detectCaps({TERM: 'tmux-256color', KITTY_WINDOW_ID: '3'})
  assert.equal(viaTmuxTerm.protocol, 'blocks')
  assert.match(viaTmuxTerm.reason, /tmux/)
})

test('each terminal is detected from the variable it actually exports', () => {
  assert.equal(detectCaps({TERM_PROGRAM: 'iTerm.app'}).protocol, 'iterm')
  assert.equal(detectCaps({TERM_PROGRAM: 'ghostty'}).protocol, 'kitty')
  assert.equal(detectCaps({TERM_PROGRAM: 'WezTerm'}).protocol, 'kitty')
  assert.equal(detectCaps({KITTY_WINDOW_ID: '1'}).protocol, 'kitty')
  assert.equal(detectCaps({TERM: 'xterm-kitty'}).protocol, 'kitty')
  assert.equal(detectCaps({TERM: 'xterm-256color'}).protocol, 'blocks')
  assert.equal(detectCaps({}).protocol, 'blocks')
})

test('TERM_PROGRAM outranks TERM when the two disagree', () => {
  assert.equal(detectCaps({TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-kitty'}).protocol, 'iterm')
})

test('over ssh kitty still detects while iTerm2 falls back to blocks', () => {
  // TERM survives the hop, TERM_PROGRAM usually does not
  assert.equal(detectCaps({TERM: 'xterm-kitty'}).protocol, 'kitty')
  assert.equal(detectCaps({KITTY_WINDOW_ID: '7'}).protocol, 'kitty')
  assert.equal(detectCaps({TERM: 'xterm-256color'}).protocol, 'blocks')
})

test('truecolor tracks COLORTERM and is never claimed with color off', () => {
  assert.equal(detectCaps({COLORTERM: 'truecolor'}).truecolor, true)
  assert.equal(detectCaps({COLORTERM: '24bit'}).truecolor, true)
  assert.equal(detectCaps({COLORTERM: '256color'}).truecolor, false)
  assert.equal(detectCaps({}).truecolor, false)
  assert.equal(detectCaps({COLORTERM: 'truecolor', NO_COLOR: '1'}).truecolor, false)
  assert.equal(detectCaps({COLORTERM: 'truecolor', PLUCK_GRAPHICS: 'off'}).truecolor, false)
  assert.equal(detectCaps({COLORTERM: 'truecolor', PLUCK_GRAPHICS: 'kitty'}).truecolor, true)
})

test('every branch names the signal that decided it', () => {
  const envs: NodeJS.ProcessEnv[] = [
    {PLUCK_GRAPHICS: 'kitty'},
    {PLUCK_GRAPHICS: 'iterm'},
    {PLUCK_GRAPHICS: 'blocks'},
    {PLUCK_GRAPHICS: 'off'},
    {PLUCK_GRAPHICS: 'sixel'},
    {NO_COLOR: '1'},
    {TMUX: '/tmp/tmux-501/default,1,0'},
    {TERM: 'screen'},
    {TERM: 'tmux-256color'},
    {TERM_PROGRAM: 'iTerm.app'},
    {TERM_PROGRAM: 'ghostty'},
    {TERM_PROGRAM: 'WezTerm'},
    {KITTY_WINDOW_ID: '3'},
    {TERM: 'xterm-kitty'},
    {TERM: 'xterm-256color'},
    {},
  ]
  for (const env of envs) {
    assert.ok(detectCaps(env).reason.length > 0, `no reason for ${JSON.stringify(env)}`)
  }
})

test('detection reads only the env it is handed', () => {
  const previous = process.env.PLUCK_GRAPHICS
  process.env.PLUCK_GRAPHICS = 'kitty'
  try {
    assert.equal(detectCaps({}).protocol, 'blocks')
  } finally {
    if (previous === undefined) delete process.env.PLUCK_GRAPHICS
    else process.env.PLUCK_GRAPHICS = previous
  }
})

const report = (over: Partial<DoctorReport> = {}): DoctorReport => ({
  versions: {pluck: '1.0.0', node: '22.11.0'},
  caps: {protocol: 'blocks', truecolor: true, reason: 'inside tmux — graphics escapes need passthrough'},
  home: '/home/someone/.pluck',
  library: {items: 0, blobs: 0, bytes: 0},
  ...over,
})

test('a report with no ffmpeg and no yt-dlp renders rather than throwing', () => {
  const text = formatDoctor(report())
  assert.match(text, /yt-dlp\s+not found/)
  assert.match(text, /ffmpeg\s+not found/)
  assert.match(text, /0 items · 0 blobs · 0 B/)
  assert.match(text, /graphics\s+blocks\s+inside tmux/)
})

test('the report carries no ansi — it gets piped and pasted into bug reports', () => {
  const text = formatDoctor(report({versions: {pluck: '1.0.0', node: '22.11.0', ffmpeg: 'ffmpeg version 7.1'}}))
  assert.ok(!text.includes('\u001b'), 'doctor output must stay plain text')
})

test('every value lands in the same column', () => {
  const text = formatDoctor(
    report({
      versions: {pluck: '1.0.0', node: '22.11.0', ytdlp: '2026.07.11', ffmpeg: 'ffmpeg version 7.1'},
      library: {items: 1284, blobs: 1109, bytes: 3_435_973_836},
    }),
  )
  const lines = text.split('\n')
  assert.equal(lines.length, 8)
  for (const line of lines) {
    assert.equal(line.slice(0, 2), '  ', line)
    assert.equal(line[19], ' ', line)
    assert.notEqual(line[20], ' ', line)
  }
  assert.match(text, /1,284 items · 1,109 blobs · 3\.2 GB/)
})

test('the color row reports the ladder step, not just a boolean', () => {
  assert.match(formatDoctor(report()), /color\s+24-bit/)
  assert.match(formatDoctor(report({caps: {protocol: 'blocks', truecolor: false, reason: 'x'}})), /color\s+256-color/)
  assert.match(formatDoctor(report({caps: {protocol: 'off', truecolor: false, reason: 'NO_COLOR set'}})), /color\s+off/)
})

/** Point the library at a throwaway directory. Never touch a real ~/.pluck. */
async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = process.env.PLUCK_HOME
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-caps-'))
  process.env.PLUCK_HOME = dir
  try {
    await run(dir)
  } finally {
    if (previous === undefined) delete process.env.PLUCK_HOME
    else process.env.PLUCK_HOME = previous
    await fs.rm(dir, {recursive: true, force: true})
  }
}

test('doctor reports an empty library as zeros', async () => {
  await withTempHome(async home => {
    const found = await doctor()
    assert.deepEqual(found.library, {items: 0, blobs: 0, bytes: 0})
    assert.equal(found.home, home)
    assert.match(found.versions.pluck, /^\d+\.\d+\.\d+/)
    assert.ok(found.versions.node.length > 0)
    assert.ok(found.caps.reason.length > 0)
    // a missing binary is information, not a throw
    for (const version of [found.versions.ytdlp, found.versions.ffmpeg]) {
      assert.ok(version === undefined || version.length > 0)
    }
    assert.match(formatDoctor(found), /home\s+\S/)
  })
})

test('doctor counts one blob per sha directory and sums every byte in it', async () => {
  await withTempHome(async home => {
    const blobs = path.join(home, 'library', 'blobs')
    const write = async (shard: string, sha: string, name: string, bytes: number) => {
      const dir = path.join(blobs, shard, sha)
      await fs.mkdir(dir, {recursive: true})
      await fs.writeFile(path.join(dir, name), 'x'.repeat(bytes))
    }
    // two files in one blob must still count as one blob
    await write('9c', '9c4f8a', 'original.png', 10)
    await write('9c', '9c4f8a', 'meta.json', 5)
    await write('9c', '9cbbbb', 'original.jpg', 3)
    await write('ab', 'abcdef', 'original.gif', 2)

    const found = await doctor()
    assert.deepEqual(found.library, {items: 0, blobs: 3, bytes: 20})
  })
})
