import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Where the library lives.
 *
 * Resolution is `$YOINKS_HOME`, then `~/.yoinks`. If the product is ever
 * renamed, the new build should look for its own home first and fall back to
 * this one when it exists — reading the legacy path in place rather than
 * moving anyone's library on their behalf. A rename that silently strands
 * years of saved work is the worst possible first impression of a new name.
 *
 * See docs/asset-model.md#home-directory.
 */
export function yoinksHome(): string {
  const override = process.env.YOINKS_HOME?.trim()
  return override ? path.resolve(override) : path.join(os.homedir(), '.yoinks')
}

export const binDir = () => path.join(yoinksHome(), 'bin')
export const libraryDir = () => path.join(yoinksHome(), 'library')
export const itemsLogPath = () => path.join(libraryDir(), 'items.jsonl')
export const boardsPath = () => path.join(libraryDir(), 'boards.json')
export const blobsDir = () => path.join(libraryDir(), 'blobs')

/** Regenerable in full — the only tree yoinks deletes without being asked. */
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
