import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {PassThrough} from 'node:stream'
import test from 'node:test'
import {ingest, type IngestInput, type IngestResult} from '../store/ingest.js'
import type {Envelope} from './json.js'
import {handleRequest, serveMcp, TOOLS, type JsonRpcRequest} from './mcp.js'

/**
 * The protocol is exercised through handleRequest, which is the whole server
 * minus the pipe — no process is ever spawned. The one test that does use a
 * stream uses two in-memory ones, because "a bad line must not kill the server"
 * is a claim about the framing and cannot be made anywhere else.
 */

/** Every test that reads the library runs against a throwaway $YOINKS_HOME. */
async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = process.env.YOINKS_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-mcp-'))
  process.env.YOINKS_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.YOINKS_HOME
    else process.env.YOINKS_HOME = previous
    await fs.rm(home, {recursive: true, force: true})
  }
}

let seq = 0

/** A capture that already happened, so the read tools have something to read. */
async function seed(home: string, over: Partial<IngestInput> = {}): Promise<IngestResult> {
  const name = `shot-${seq++}.png`
  const dir = path.join(home, 'incoming')
  await fs.mkdir(dir, {recursive: true})
  const file = path.join(dir, name)
  await fs.writeFile(file, `pixels ${name}`)

  return ingest({
    path: file,
    kind: 'image',
    mime: 'image/png',
    source: {url: 'https://example.com/shot.png', site: 'example.com', title: 'a dark hero'},
    ...over,
  })
}

type Response = {jsonrpc: string; id: string | number | null; result?: unknown; error?: {code: number; message: string}}
type ToolResult = {content: Array<{type: string; text: string}>; isError?: boolean}

async function ask(method: string, params?: unknown, id: string | number = 1): Promise<Response> {
  const response = await handleRequest({jsonrpc: '2.0', id, method, params} satisfies JsonRpcRequest)
  assert.ok(response, `expected a response to ${method}`)
  return response as Response
}

function resultOf<T>(response: Response): T {
  assert.equal(response.error, undefined, `expected a result, got ${JSON.stringify(response.error)}`)
  return response.result as T
}

/** A tool call, unwrapped down to the envelope the text content carries. */
async function call(
  name: string,
  args?: unknown,
): Promise<{envelope: Envelope<unknown>; isError: boolean; text: string}> {
  const result = resultOf<ToolResult>(await ask('tools/call', {name, arguments: args}))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, 'text')
  const text = result.content[0]!.text
  return {envelope: JSON.parse(text) as Envelope<unknown>, isError: result.isError === true, text}
}

function dataOf<T>(envelope: Envelope<unknown>): T {
  if (!envelope.ok) assert.fail(`expected data, got ${envelope.error.code}: ${envelope.error.message}`)
  return envelope.data as T
}

// --- protocol ---------------------------------------------------------------

test('initialize answers the handshake with a protocol version and who we are', async () => {
  const result = resultOf<{
    protocolVersion: string
    capabilities: {tools: object}
    serverInfo: {name: string; version: string}
  }>(await ask('initialize', {protocolVersion: '2024-11-05'}))

  assert.equal(result.protocolVersion, '2024-11-05')
  assert.deepEqual(result.capabilities, {tools: {}})
  assert.equal(result.serverInfo.name, 'yoinks')
  assert.match(result.serverInfo.version, /^\d+\.\d+\.\d+/)
})

test('tools/list is the five tools, each one described and schema’d', async () => {
  const {tools} = resultOf<{tools: typeof TOOLS}>(await ask('tools/list'))

  assert.equal(tools.length, 5)
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['search_inspiration', 'get_brief', 'get_asset', 'list_boards', 'capture_url'],
  )
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`)
    assert.equal(typeof tool.inputSchema, 'object')
    assert.equal((tool.inputSchema as {type?: string}).type, 'object')
  }
})

test('nothing here can delete, retag, or rename — read and append only', async () => {
  const {tools} = resultOf<{tools: typeof TOOLS}>(await ask('tools/list'))
  const forbidden = /delete|remove|rename|update|edit|move/i
  for (const tool of tools) assert.doesNotMatch(tool.name, forbidden)
})

test('a notification is never answered', async () => {
  assert.equal(await handleRequest({jsonrpc: '2.0', method: 'notifications/initialized'}), undefined)
  assert.equal(await handleRequest({jsonrpc: '2.0', method: 'tools/list'}), undefined)
})

test('an unknown method is a method-not-found error, not a crash', async () => {
  const response = await ask('resources/list')
  assert.equal(response.error?.code, -32601)
  assert.match(response.error?.message ?? '', /resources\/list/)
  assert.equal(response.id, 1)
})

test('the id comes back exactly as it went out', async () => {
  assert.equal((await ask('tools/list', undefined, 'abc')).id, 'abc')
  assert.equal((await ask('tools/list', undefined, 17)).id, 17)
})

// --- tool dispatch ----------------------------------------------------------

test('an unknown tool is an error result, not a throw', async () => {
  const {envelope, isError} = await call('drop_everything')
  assert.equal(isError, true)
  assert.equal(envelope.ok, false)
  if (envelope.ok) return
  assert.equal(envelope.error.code, 'usage')
  assert.match(envelope.error.message, /unknown tool/)
  // the message names what does exist, so a mistaken agent can correct itself
  assert.match(envelope.error.message, /search_inspiration/)
})

test('tools/call with no name at all is still an answer', async () => {
  for (const params of [undefined, {}, {name: 42}, 'nonsense']) {
    const result = resultOf<ToolResult>(await ask('tools/call', params))
    assert.equal(result.isError, true)
  }
})

test('a handler that throws surfaces as an error result and stops there', async () => {
  // count() refuses this before cmdFind ever sees it, so the throw happens
  // inside the handler rather than inside the command's own guard
  const bad = await call('search_inspiration', {limit: 'plenty'})
  assert.equal(bad.isError, true)
  assert.match(bad.text, /whole number/)

  const worse = await call('search_inspiration', {tags: 'dark'})
  assert.equal(worse.isError, true)
  assert.match(worse.text, /list of strings/)

  const missing = await call('get_asset', {})
  assert.equal(missing.isError, true)
  assert.match(missing.text, /id is required/)

  // and the server is unbothered by any of it
  assert.equal(resultOf<{tools: unknown[]}>(await ask('tools/list')).tools.length, 5)
})

// --- against a library ------------------------------------------------------

test('search_inspiration returns the library with a path on every hit', async () => {
  await withHome(async home => {
    const dark = await seed(home, {
      source: {url: 'https://a.example/1.png', title: 'dark editorial hero'},
      tags: ['dark'],
      note: 'the rule under the eyebrow',
    })
    await seed(home, {source: {url: 'https://b.example/2.png', title: 'bright landing page'}})

    type Hits = {hits: Array<{id: string; path?: string; note?: string; tags: string[]}>}

    const all = dataOf<Hits>((await call('search_inspiration', {})).envelope)
    assert.equal(all.hits.length, 2)
    for (const hit of all.hits) {
      assert.ok(hit.path, 'every hit carries the absolute path — that is the point of the surface')
      assert.ok(path.isAbsolute(hit.path))
    }

    const narrowed = dataOf<Hits>((await call('search_inspiration', {query: 'dark editorial'})).envelope)
    assert.deepEqual(
      narrowed.hits.map(hit => hit.id),
      [dark.item.id],
    )
    assert.equal(narrowed.hits[0]!.note, 'the rule under the eyebrow')

    const byTag = dataOf<Hits>((await call('search_inspiration', {tags: ['dark'], limit: 5})).envelope)
    assert.deepEqual(
      byTag.hits.map(hit => hit.id),
      [dark.item.id],
    )

    const empty = dataOf<Hits>((await call('search_inspiration', {query: 'brutalist'})).envelope)
    assert.deepEqual(empty.hits, [])
  })
})

test('get_asset hands back one item with its file path', async () => {
  await withHome(async home => {
    const saved = await seed(home)
    const shown = dataOf<{item: {id: string}; path?: string}>((await call('get_asset', {id: saved.item.id})).envelope)
    assert.equal(shown.item.id, saved.item.id)
    assert.equal(shown.path, saved.blobPath)

    const gone = await call('get_asset', {id: 'ZZZZZZZZ'})
    assert.equal(gone.isError, true)
    assert.match(gone.text, /not_found/)
  })
})

test('list_boards counts what is on each board', async () => {
  await withHome(async home => {
    await seed(home, {boards: ['Hero Refs']})
    await seed(home, {boards: ['Hero Refs']})
    await seed(home, {boards: ['dark ui']})

    type Boards = {boards: Array<{key: string; name: string; count: number}>}
    const {boards} = dataOf<Boards>((await call('list_boards')).envelope)

    assert.deepEqual(
      boards.map(board => [board.key, board.count]),
      [
        ['dark-ui', 1],
        ['hero-refs', 2],
      ],
    )
  })
})

test('an empty library answers cleanly rather than failing', async () => {
  await withHome(async () => {
    assert.deepEqual(dataOf<{hits: unknown[]}>((await call('search_inspiration', {})).envelope).hits, [])
    assert.deepEqual(dataOf<{boards: unknown[]}>((await call('list_boards')).envelope).boards, [])
  })
})

test('capture_url refuses a bad select before it touches the network', async () => {
  const {isError, text} = await call('capture_url', {url: 'https://example.com/x.png', select: 'some'})
  assert.equal(isError, true)
  assert.match(text, /best/)

  const nothing = await call('capture_url', {})
  assert.equal(nothing.isError, true)
  assert.match(nothing.text, /url is required/)
})

// --- the pipe ---------------------------------------------------------------

test('a malformed line is answered and the server keeps serving', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []

  let rest = ''
  output.on('data', (chunk: Buffer) => {
    rest += chunk.toString('utf8')
    for (let newline = rest.indexOf('\n'); newline !== -1; newline = rest.indexOf('\n')) {
      lines.push(rest.slice(0, newline))
      rest = rest.slice(newline + 1)
    }
  })

  serveMcp(input, output)

  input.write('{not json at all\n')
  input.write('[1, 2, 3]\n')
  input.write('\n')
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  // split across two writes, because a pipe breaks wherever it likes
  input.write('{"jsonrpc":"2.0","id":9,"method":"too')
  input.write('ls/list"}\n')

  await waitFor(() => lines.length >= 3)

  const answers = lines.map(line => JSON.parse(line) as Response)
  assert.equal(answers[0]!.error?.code, -32700)
  assert.equal(answers[0]!.id, null)
  assert.equal(answers[1]!.error?.code, -32600)
  // the notification got no line of its own, so the third answer is the list
  assert.equal(answers.length, 3)
  assert.equal(answers[2]!.id, 9)
  assert.equal((answers[2]!.result as {tools: unknown[]}).tools.length, 5)
})

async function waitFor(done: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) assert.fail('the server never answered')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
