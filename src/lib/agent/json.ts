/**
 * The machine-readable surface.
 *
 * Every headless command answers in one envelope with one shape, so a caller
 * can branch on `ok` and on a closed set of error codes without parsing prose.
 * Agents are the primary consumer here and they cannot recover from a message
 * that merely reads differently this time.
 *
 * See docs/cli.md#headless and docs/agents.md.
 */

export const ERROR_CODES = [
  'usage',
  'not_found',
  'no_candidates',
  'fetch_failed',
  'extractor_failed',
  'unsupported',
  'store_error',
  'cancelled',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type Envelope<T> = {ok: true; data: T} | {ok: false; error: {code: ErrorCode; message: string}}

/** Exit codes are part of the contract: 0 fine, 1 failed, 2 you called it wrong. */
export const EXIT = {ok: 0, failed: 1, usage: 2} as const

export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export const ok = <T>(data: T): Envelope<T> => ({ok: true, data})

export const fail = (code: ErrorCode, message: string): Envelope<never> => ({ok: false, error: {code, message}})

/** Anything thrown becomes an envelope — a stack trace is not an answer. */
export function envelopeFor(error: unknown): Envelope<never> {
  if (error instanceof CommandError) return fail(error.code, error.message)
  const message = error instanceof Error ? error.message : String(error)
  return fail('store_error', message)
}

export function exitCodeFor(envelope: Envelope<unknown>): number {
  if (envelope.ok) return EXIT.ok
  return envelope.error.code === 'usage' ? EXIT.usage : EXIT.failed
}

export function render(envelope: Envelope<unknown>): string {
  return JSON.stringify(envelope, null, 2)
}

/**
 * `--json` is implied whenever stdout isn't a terminal, so `pluck find dark |
 * jq` works with no flag while the same command in a terminal stays readable.
 */
export function wantsJson(explicit: boolean | undefined, isTTY: boolean): boolean {
  return explicit ?? !isTTY
}
