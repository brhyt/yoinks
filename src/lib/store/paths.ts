import {existsSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** What the tool was called before, and where it kept things. */
const LEGACY_HOME = '.yoinks'

/**
 * Where the library lives: `$PLUCK_HOME`, then `~/.pluck`, then `~/.yoinks`.
 *
 * That last step is the rename migration. Someone who installed yoinks has a
 * library under `~/.yoinks`, and a new binary that quietly looked somewhere
 * else would present them with an empty shelf and no explanation — the worst
 * possible first impression of a new name. So the legacy path is read **in
 * place** when it exists and the new one doesn't. Nothing is moved on the
 * user's behalf; `pluck migrate` does that when they ask.
 *
 * Once `~/.pluck` exists it always wins, so a migration is a one-way door
 * rather than a thing that flip-flops depending on what's on disk.
 *
 * See docs/asset-model.md#home-directory.
 */
export function pluckHome(): string {
  const override = process.env.PLUCK_HOME?.trim()
  if (override) return path.resolve(override)

  const current = path.join(os.homedir(), '.pluck')
  if (existsSync(current)) return current

  const legacy = path.join(os.homedir(), LEGACY_HOME)
  return existsSync(legacy) ? legacy : current
}

/** True when we're reading a library that still lives under the old name. */
export function usingLegacyHome(): boolean {
  return path.basename(pluckHome()) === LEGACY_HOME && !process.env.PLUCK_HOME
}

export const legacyHome = (): string => path.join(os.homedir(), LEGACY_HOME)

export const binDir = () => path.join(pluckHome(), 'bin')
export const libraryDir = () => path.join(pluckHome(), 'library')
export const itemsLogPath = () => path.join(libraryDir(), 'items.jsonl')
export const boardsPath = () => path.join(libraryDir(), 'boards.json')
export const blobsDir = () => path.join(libraryDir(), 'blobs')

/** Regenerable in full — the only tree pluck deletes without being asked. */
export const cacheDir = () => path.join(libraryDir(), 'cache')
export const thumbsDir = () => path.join(cacheDir(), 'thumbs')

/**
 * Sharded on the first two hex characters, which keeps any one directory under
 * a few hundred entries at library sizes people actually reach.
 */
export function blobDir(sha256: string): string {
  return path.join(blobsDir(), sha256.slice(0, 2), sha256)
}

export const blobMetaPath = (sha256: string) => path.join(blobDir(sha256), 'meta.json')

export async function ensureLibrary(): Promise<void> {
  await fs.mkdir(blobsDir(), {recursive: true})
  await fs.mkdir(cacheDir(), {recursive: true})
}

/** The stored original, whatever extension it was saved under. */
export async function findOriginal(sha256: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(blobDir(sha256))
    const original = entries.find(entry => entry.startsWith('original'))
    return original ? path.join(blobDir(sha256), original) : undefined
  } catch {
    return undefined
  }
}
