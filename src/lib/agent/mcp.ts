import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {KIND_ORDER} from '../extract/types.js'
import {cmdBoards, cmdCapture, cmdFind, cmdShow} from './commands.js'
import {CommandError, envelopeFor, fail, render, type Envelope} from './json.js'

/**
 * Layer 3 — the MCP server.
 *
 * JSON-RPC 2.0 over stdin and stdout, one message per line, hand-rolled. The
 * subset MCP actually needs is four methods and a result envelope; a dependency
 * that brought its own transport, schema validator and process supervisor to
 * supply them would be more code to audit than this file.
 *
 * Every tool is a thin wrapper over the headless verbs in commands.ts, so
 * anything an agent can reach here is something you can reproduce in a shell —
 * which is what keeps this surface honest and debuggable by hand.
 *
 * See docs/agents.md#layer-3--mcp.
 */

export type JsonRpcRequest = {jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {code: number; message: string}
}

const PROTOCOL_VERSION = '2024-11-05'

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

/**
 * The tools.
 *
 * Deliberately absent: no delete, no bulk edit, no rename. Read and append
 * only. An agent that can quietly drop things from a collection someone spent
 * years building is not worth the convenience, and nothing an agent does with
 * inspiration requires it.
 *
 * `path` is on every result that has one. That is the entire point of the
 * surface — the palette and the type list are summaries an agent could
 * hallucinate a plausible version of, and a file path is not summarizable.
 */
export const TOOLS: Array<{name: string; description: string; inputSchema: object}> = [
  {
    name: 'search_inspiration',
    description:
      'Search the design references this user saved themselves. The discovery call: free text over ' +
      'title, note, tags, board and site, narrowed by board, tag, kind or color. Every result carries ' +
      'an absolute `path` — open the file and look at it rather than reasoning from the summary.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'free text over title, note, tags, board and site'},
        board: {type: 'string', description: 'board name or key'},
        tags: {type: 'array', items: {type: 'string'}},
        kind: {type: 'string', enum: [...KIND_ORDER]},
        color: {type: 'string', description: 'hex like #ff6b35 — ranks results by palette distance'},
        limit: {type: 'number', description: 'default 20'},
      },
    },
  },
  {
    name: 'get_brief',
    description:
      'Synthesized direction for one visual task: a weighted palette fused across the matching ' +
      'references, the type families actually observed on them, the user’s own notes verbatim, and ' +
      'absolute paths to the originals. Read three or four of those files before you build — the ' +
      'palette is the summary, the images are the evidence — then say which reference drove which ' +
      'decision.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'what you are about to build, in plain words'},
        board: {type: 'string', description: 'brief a whole board instead of a query'},
        limit: {type: 'number', description: 'references to include, default 8'},
      },
    },
  },
  {
    name: 'get_asset',
    description:
      'One saved reference in full, by id or sha256 (an unambiguous prefix works): source, note, ' +
      'tags, boards, palette with weights, and the absolute path to the original file.',
    inputSchema: {
      type: 'object',
      properties: {id: {type: 'string', description: 'item id, sha256, or an unambiguous prefix'}},
      required: ['id'],
    },
  },
  {
    name: 'list_boards',
    description:
      'The boards in this library with their item counts. The cheap orientation call — an agent that ' +
      'lists boards before searching asks far better questions.',
    inputSchema: {type: 'object', properties: {}},
  },
  {
    name: 'capture_url',
    description:
      'Save a url into the library. Only when the user asked for it, or clearly meant to. Write a ' +
      'real note saying why this one — that note is what makes the reference useful in six months. ' +
      'Idempotent: the same url twice adds an item and reuses the stored bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {type: 'string'},
        board: {type: 'string', description: 'created if it does not exist yet'},
        tags: {type: 'array', items: {type: 'string'}},
        note: {type: 'string', description: 'why this one — the highest-signal field in the library'},
        select: {type: 'string', enum: ['best', 'all'], description: 'default best'},
      },
      required: ['url'],
    },
  },
]

const TOOL_NAMES = TOOLS.map(tool => tool.name)

/** Pure: handle one request, return the response (or undefined for a notification). */
export async function handleRequest(request: JsonRpcRequest): Promise<object | undefined> {
  // no id means a notification, and a notification is never answered — that
  // covers the `notifications/initialized` every client sends after the
  // handshake, and answering it would be a protocol error of our own
  if (request.id === undefined) return undefined
  const id = request.id

  switch (request.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {tools: {}},
        serverInfo: {name: 'pluck', version: version()},
      })
    case 'tools/list':
      return result(id, {tools: TOOLS})
    case 'tools/call':
      return result(id, await callTool(request.params))
    default:
      return errorResponse(id, METHOD_NOT_FOUND, `unknown method “${request.method}”`)
  }
}

/** Wire it to stdin/stdout. */
export function serveMcp(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  let pending = ''

  // the client is free to close the pipe first, and an EPIPE with no listener
  // would take the process down on the way out
  output.on('error', () => {})

  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    pending += chunk
    // a chunk boundary lands wherever the pipe felt like it, so only whole
    // lines are messages and the tail waits for the rest of itself
    for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      void dispatch(line, output)
    }
  })

  // a client that closes without a trailing newline still asked for something
  input.on('end', () => {
    const last = pending
    pending = ''
    void dispatch(last, output)
  })
}

/**
 * One line in, at most one line out. Nothing in here throws: a malformed line
 * is answered and the connection lives, because a server that dies on the first
 * bad byte takes the whole session's tool calls with it.
 */
async function dispatch(line: string, output: NodeJS.WritableStream): Promise<void> {
  const text = line.trim()
  if (!text) return

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    write(output, errorResponse(null, PARSE_ERROR, messageOf(error)))
    return
  }

  const request = asRequest(parsed)
  if (!request) {
    write(output, errorResponse(idOf(parsed), INVALID_REQUEST, 'a request needs a string “method”'))
    return
  }

  try {
    const response = await handleRequest(request)
    if (response) write(output, response)
  } catch (error) {
    // handleRequest is not supposed to throw, and if it ever does the client is
    // owed an answer rather than a silence it will wait out
    if (request.id !== undefined) write(output, errorResponse(request.id, INTERNAL_ERROR, messageOf(error)))
  }
}

function write(output: NodeJS.WritableStream, value: object): void {
  try {
    output.write(`${JSON.stringify(value)}\n`)
  } catch {
    // an unserializable response is our bug, not the client's problem to solve
  }
}

function asRequest(value: unknown): JsonRpcRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as {method?: unknown; id?: unknown; params?: unknown}
  if (typeof candidate.method !== 'string') return undefined

  const id = typeof candidate.id === 'string' || typeof candidate.id === 'number' ? candidate.id : undefined
  return {jsonrpc: '2.0', method: candidate.method, params: candidate.params, ...(id === undefined ? {} : {id})}
}

/** An id we can echo, so a rejected request is still traceable at the other end. */
function idOf(value: unknown): string | number | null {
  if (!value || typeof value !== 'object') return null
  const id = (value as {id?: unknown}).id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

const result = (id: string | number, value: unknown): JsonRpcResponse => ({jsonrpc: '2.0', id, result: value})

const errorResponse = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: {code, message},
})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// --- tools ------------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => Promise<Envelope<unknown>>

const HANDLERS = new Map<string, Handler>([
  ['search_inspiration', args => cmdFind(searchArgs(args))],
  ['get_brief', args => runBrief(briefArgs(args))],
  ['get_asset', args => cmdShow(['--', required(args, 'id')])],
  ['list_boards', () => cmdBoards([])],
  ['capture_url', args => cmdCapture(captureArgs(args))],
])

async function callTool(params: unknown): Promise<object> {
  try {
    const call = params as {name?: unknown; arguments?: unknown} | null | undefined
    const name = call?.name
    if (typeof name !== 'string' || !name) throw new CommandError('usage', 'tools/call needs a tool name')

    const run = HANDLERS.get(name)
    if (!run) {
      throw new CommandError('usage', `unknown tool “${name}” — this server offers ${TOOL_NAMES.join(', ')}`)
    }
    return toolResult(await run(objectOf(call?.arguments)))
  } catch (error) {
    // a failing tool is an answer, not a broken connection: MCP wants the
    // failure inside the result where the model can read it and try again
    return toolResult(envelopeFor(error))
  }
}

const toolResult = (envelope: Envelope<unknown>): object => ({
  content: [{type: 'text', text: render(envelope)}],
  ...(envelope.ok ? {} : {isError: true}),
})

function searchArgs(args: Record<string, unknown>): string[] {
  const argv: string[] = []
  const board = text(args, 'board')
  if (board) argv.push('--board', board)
  for (const tag of list(args, 'tags')) argv.push('--tag', tag)
  const kind = text(args, 'kind')
  if (kind) argv.push('--kind', kind)
  const color = text(args, 'color')
  if (color) argv.push('--color', color)
  const limit = count(args, 'limit')
  if (limit) argv.push('--limit', limit)

  // last, and behind `--`: a query is the user's words and may well start with
  // a dash, which the flag parser would otherwise read as a flag it doesn't know
  const query = text(args, 'query')
  if (query) argv.push('--', query)
  return argv
}

function captureArgs(args: Record<string, unknown>): string[] {
  const select = text(args, 'select') ?? 'best'
  if (select !== 'best' && select !== 'all') {
    throw new CommandError('usage', `select is “best” or “all”, not “${select}”`)
  }

  const argv = [`--${select}`]
  const board = text(args, 'board')
  if (board) argv.push('--board', board)
  for (const tag of list(args, 'tags')) argv.push('--tag', tag)
  const note = text(args, 'note')
  if (note) argv.push('--note', note)

  argv.push('--', required(args, 'url'))
  return argv
}

function briefArgs(args: Record<string, unknown>): string[] {
  const argv: string[] = []
  const query = text(args, 'query')
  if (query) argv.push(query)
  const board = text(args, 'board')
  if (board) argv.push('--board', board)
  const limit = count(args, 'limit')
  if (limit) argv.push('--limit', limit)
  return argv
}

/**
 * Loaded on the call rather than at the top of the file: a build without the
 * brief command should lose one tool, not refuse to start the server that
 * carries the other four.
 */
async function runBrief(argv: string[]): Promise<Envelope<unknown>> {
  let run: ((args: string[]) => Promise<Envelope<unknown>>) | undefined
  try {
    const module = await import('./brief.js')
    run = module.cmdBrief
  } catch (error) {
    return fail('unsupported', `get_brief isn’t available in this build (${messageOf(error)}).`)
  }
  if (typeof run !== 'function') {
    return fail('unsupported', 'get_brief isn’t available in this build — use search_inspiration instead.')
  }
  return run(argv)
}

// --- arguments --------------------------------------------------------------

function objectOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandError('usage', 'tool arguments must be an object')
  }
  return value as Record<string, unknown>
}

function text(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new CommandError('usage', `${name} must be a string`)
  return value.trim() || undefined
}

function required(args: Record<string, unknown>, name: string): string {
  const value = text(args, name)
  if (!value) throw new CommandError('usage', `${name} is required`)
  return value
}

function list(args: Record<string, unknown>, name: string): string[] {
  const value = args[name]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new CommandError('usage', `${name} must be a list of strings`)
  }
  return (value as string[]).map(entry => entry.trim()).filter(Boolean)
}

/** Numbers arrive as numbers from a schema-checking client and as strings from the rest. */
function count(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined

  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CommandError('usage', `${name} must be a whole number above zero, not “${String(value)}”`)
  }
  return String(parsed)
}

// --- version ----------------------------------------------------------------

let cached: string | undefined

/**
 * Read off the shipped package.json so a version bump can't drift from a
 * constant. The bundler collapses this module into dist/cli.js, which leaves
 * package.json one directory up from the running file in a build and four in
 * source — climbing finds it either way, and a handshake is never worth failing
 * over a version string.
 */
function version(): string {
  if (cached) return cached

  const require = createRequire(import.meta.url)
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifest = require(path.join(dir, 'package.json')) as {version?: string}
      if (manifest.version) {
        cached = manifest.version
        return cached
      }
    } catch {
      // not this directory
    }
    dir = path.dirname(dir)
  }

  cached = '0.0.0'
  return cached
}
