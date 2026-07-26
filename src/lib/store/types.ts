/**
 * Library records.
 *
 * The one decision everything else rests on: a *thing* and a *saving of that
 * thing* are separate records.
 *
 *   Blob  identified by sha256 of the bytes. Intrinsic facts — dimensions,
 *         palette, mime. Duplicates are impossible by construction.
 *   Item  identified by a sortable id. Your facts — where you found it, which
 *         board, your note. Duplicates are expected and fine.
 *
 * The same screenshot saved from two articles is one blob and two items. That
 * split is what makes dedupe free, derivation run once per blob rather than
 * once per save, and a future sync merge without conflict resolution.
 *
 * See docs/asset-model.md.
 */

import type {Kind} from '../extract/types.js'

export type {Kind}

export type Source = {
  url: string
  site?: string
  title?: string
  author?: string
  extractor?: string
  captured_at: string
}

export type Item = {
  id: string
  /** when this *record* was written — the merge key for last-write-wins */
  ts: string
  /** absent only for blob-less kinds that carry their content inline */
  sha256?: string
  source: Source
  boards: string[]
  tags: string[]
  note?: string
}

export type PaletteEntry = {
  hex: string
  /** fraction of sampled pixels, so palettes are comparable and summable */
  weight: number
}

export type BlobMeta = {
  sha256: string
  kind: Kind
  mime?: string
  bytes: number
  width?: number
  height?: number
  duration?: number
  palette?: PaletteEntry[]
  fonts?: string[]
  derived_at?: string
  /**
   * Bumped when the derivation algorithm changes, so a background pass can
   * re-derive everything below the current version without re-capturing.
   */
  deriver_version?: number
}

export const DERIVER_VERSION = 1

export type Board = {
  name: string
  created_at: string
  note?: string
  /** sha256 of the blob to show as the board's face */
  cover?: string
}

/** One line of items.jsonl. A delete is a tombstone, never a removal. */
export type LogRecord = ({op: 'put'} & Item) | {op: 'del'; id: string; ts: string}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ULID: 48-bit timestamp then 80 bits of randomness, Crockford base32.
 *
 * Lexicographically sortable by creation time, generated offline with no
 * coordination — which is what lets two machines mint ids that will merge
 * cleanly if sync ever arrives.
 */
export function ulid(now: number = Date.now(), random: () => number = Math.random): string {
  let time = ''
  let remaining = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[remaining % 32]! + time
    remaining = Math.floor(remaining / 32)
  }
  let entropy = ''
  for (let i = 0; i < 16; i++) {
    entropy += CROCKFORD[Math.floor(random() * 32)]!
  }
  return time + entropy
}

export function isoNow(): string {
  return new Date().toISOString()
}
