import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {legacyHome, pluckHome, usingLegacyHome} from './paths.js'

/**
 * The rename migration. Someone who installed yoinks has a library under
 * ~/.yoinks; a pluck binary that quietly looked elsewhere would show them an
 * empty shelf and no explanation.
 */

/** Point HOME at a throwaway dir so we never touch a real library. */
async function withHome(
  setup: (home: string) => Promise<void>,
  run: () => Promise<void> | void,
): Promise<void> {
  const previousHome = process.env.HOME
  const previousPluck = process.env.PLUCK_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-home-'))
  process.env.HOME = home
  delete process.env.PLUCK_HOME
  try {
    await setup(home)
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousPluck !== undefined) process.env.PLUCK_HOME = previousPluck
    await fs.rm(home, {recursive: true, force: true})
  }
}

test('a fresh machine gets ~/.pluck', async () => {
  await withHome(
    async () => {},
    () => {
      assert.equal(path.basename(pluckHome()), '.pluck')
      assert.equal(usingLegacyHome(), false)
    },
  )
})

test('an existing yoinks library is read in place, not abandoned', async () => {
  await withHome(
    async home => {
      await fs.mkdir(path.join(home, '.yoinks', 'library'), {recursive: true})
    },
    () => {
      assert.equal(path.basename(pluckHome()), '.yoinks')
      assert.equal(usingLegacyHome(), true)
      assert.equal(pluckHome(), legacyHome())
    },
  )
})

test('once ~/.pluck exists it wins — migration is a one-way door', async () => {
  await withHome(
    async home => {
      await fs.mkdir(path.join(home, '.yoinks'), {recursive: true})
      await fs.mkdir(path.join(home, '.pluck'), {recursive: true})
    },
    () => {
      assert.equal(path.basename(pluckHome()), '.pluck')
      assert.equal(usingLegacyHome(), false)
    },
  )
})

test('PLUCK_HOME beats both, and is never reported as legacy', async () => {
  await withHome(
    async home => {
      await fs.mkdir(path.join(home, '.yoinks'), {recursive: true})
    },
    async () => {
      const override = await fs.mkdtemp(path.join(os.tmpdir(), 'pluck-override-'))
      process.env.PLUCK_HOME = override
      try {
        assert.equal(pluckHome(), path.resolve(override))
        assert.equal(usingLegacyHome(), false)
      } finally {
        delete process.env.PLUCK_HOME
        await fs.rm(override, {recursive: true, force: true})
      }
    },
  )
})
