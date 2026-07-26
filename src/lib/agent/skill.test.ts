import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {cmdSkill, installSkill, skillMarkdown, SKILL_RELATIVE_PATH} from './skill.js'
import type {Envelope, ErrorCode} from './json.js'

/** Every install lands in a throwaway directory — never a real ~/.claude/skills. */
async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-skill-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
}

function dataOf<T>(envelope: Envelope<unknown>): T {
  if (!envelope.ok) assert.fail(`expected data, got ${envelope.error.code}: ${envelope.error.message}`)
  return envelope.data as T
}

function errorOf(envelope: Envelope<unknown>): {code: ErrorCode; message: string} {
  if (envelope.ok) assert.fail(`expected a failure, got ${JSON.stringify(envelope.data)}`)
  return envelope.error
}

// --- the markdown -----------------------------------------------------------

test('the skill carries the frontmatter a runtime needs to trigger on', () => {
  const markdown = skillMarkdown()
  assert.ok(markdown.length > 0)
  assert.ok(markdown.startsWith('---\n'))
  assert.match(markdown, /^name: inspiration$/m)
  assert.match(markdown, /^description: .+/m)
})

test('the embedded copy matches skills/inspiration/SKILL.md', async () => {
  // the constant is the shipped one — dist/ carries no skills directory — so the
  // only thing keeping it true is this comparison
  const here = path.dirname(fileURLToPath(import.meta.url))
  const source = path.join(here, '..', '..', '..', 'skills', SKILL_RELATIVE_PATH)
  assert.equal(skillMarkdown(), await fs.readFile(source, 'utf8'))
})

// --- installSkill -----------------------------------------------------------

test('install writes the skill and says whether it replaced one', async () => {
  await withDir(async dir => {
    const first = await installSkill(dir)
    assert.equal(first.path, path.join(dir, 'inspiration', 'SKILL.md'))
    assert.equal(first.existed, false)
    assert.equal(await fs.readFile(first.path, 'utf8'), skillMarkdown())

    const second = await installSkill(dir)
    assert.equal(second.path, first.path)
    assert.equal(second.existed, true)
    assert.equal(await fs.readFile(second.path, 'utf8'), skillMarkdown())
  })
})

test('install creates the directory it was pointed at', async () => {
  await withDir(async dir => {
    const nested = path.join(dir, 'a', 'b', 'skills')
    const {path: written} = await installSkill(nested)
    assert.equal(written, path.join(nested, 'inspiration', 'SKILL.md'))
    assert.ok((await fs.stat(written)).isFile())
  })
})

// --- cmdSkill ---------------------------------------------------------------

test('print hands back the markdown instead of installing it', async () => {
  const {markdown} = dataOf<{markdown: string}>(await cmdSkill(['print']))
  assert.equal(markdown, skillMarkdown())
})

test('install through the command reports the path and the replacement', async () => {
  await withDir(async dir => {
    const first = dataOf<{path: string; existed: boolean}>(await cmdSkill(['install', '--dir', dir]))
    assert.equal(first.existed, false)
    assert.ok(first.path.endsWith(path.join('inspiration', 'SKILL.md')))

    const again = dataOf<{existed: boolean}>(await cmdSkill(['install', `--dir=${dir}`]))
    assert.equal(again.existed, true)
  })
})

test('a failure is an envelope, never a throw', async () => {
  assert.equal(errorOf(await cmdSkill(['reinstall'])).code, 'usage')
  assert.match(errorOf(await cmdSkill(['reinstall'])).message, /skill install/)
  assert.equal(errorOf(await cmdSkill([])).code, 'usage')
  assert.equal(errorOf(await cmdSkill(['install', '--dir'])).code, 'usage')
  assert.equal(errorOf(await cmdSkill(['install', '--wat'])).code, 'usage')
  assert.equal(errorOf(await cmdSkill(['install', 'print'])).code, 'usage')
  // --dir means nothing to a command that writes to stdout
  assert.equal(errorOf(await cmdSkill(['print', '--dir', '/tmp'])).code, 'usage')
})

test('the --json flag every command sees in its tail is not a subcommand', async () => {
  await withDir(async dir => {
    const installed = dataOf<{path: string}>(await cmdSkill(['install', '--dir', dir, '--json']))
    assert.ok(installed.path.startsWith(dir))
  })
})
