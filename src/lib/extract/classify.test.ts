import assert from 'node:assert/strict'
import test from 'node:test'
import {classify} from './classify.js'

/**
 * Every test here injects `fetchImpl`. Nothing in this file may touch the
 * network — a suite that reaches out is a suite that fails on a plane.
 */

type Call = {url: string; method: string; userAgent: string; redirect?: string}

function stubFetch(handler: (call: Call) => Response): {fetchImpl: typeof fetch; calls: Call[]} {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      userAgent: new Headers(init?.headers).get('user-agent') ?? '',
      redirect: init?.redirect,
    }
    calls.push(call)
    return handler(call)
  }
  return {fetchImpl, calls}
}

function respond(options: {
  status?: number
  headers?: Record<string, string>
  body?: string | ReadableStream | null
  url?: string
}): Response {
  const init = {status: options.status ?? 200, headers: options.headers}
  const response = new Response(options.body ?? null, init)
  // constructed responses have an empty url; a redirected one does not
  if (options.url) Object.defineProperty(response, 'url', {value: options.url})
  return response
}

type CountedBody = {stream: ReadableStream; sent: () => number; cancelled: () => boolean}

/** A body that reports how much of it was actually pulled, and whether it was dropped. */
function countedBody(chunk: string, chunks: number): CountedBody {
  const encoder = new TextEncoder()
  let sent = 0
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= chunk.length * chunks) {
        controller.close()
        return
      }
      sent += chunk.length
      controller.enqueue(encoder.encode(chunk))
    },
    cancel() {
      cancelled = true
    },
  })
  return {stream, sent: () => sent, cancelled: () => cancelled}
}

test('an image url is classified from the head response alone', async () => {
  const {fetchImpl, calls} = stubFetch(() =>
    respond({headers: {'content-type': 'image/jpeg', 'content-length': '20480'}}),
  )

  const result = await classify('https://cdn.example.com/photo.jpg', {fetchImpl})

  assert.deepEqual(
    calls.map(c => c.method),
    ['HEAD'],
  )
  assert.equal(calls[0]?.redirect, 'follow')
  assert.ok(calls[0]?.userAgent.startsWith('Mozilla/5.0'), 'sends a browser user-agent')
  assert.equal(result.url, 'https://cdn.example.com/photo.jpg')
  assert.equal(result.mime, 'image/jpeg')
  assert.equal(result.bytes, 20480)
  assert.equal(result.kind, 'image')
  assert.equal(result.isHtml, false)
  assert.equal(result.html, undefined)
})

test('an html url pays for one get, and the body comes back with it', async () => {
  const html = '<html><head><meta property="og:image" content="a.jpg"></head></html>'
  const {fetchImpl, calls} = stubFetch(call =>
    call.method === 'HEAD'
      ? respond({headers: {'content-type': 'text/html; charset=utf-8'}})
      : respond({headers: {'content-type': 'text/html; charset=utf-8'}, body: html}),
  )

  const result = await classify('https://example.com/post', {fetchImpl})

  assert.deepEqual(
    calls.map(c => c.method),
    ['HEAD', 'GET'],
  )
  assert.equal(result.kind, 'page')
  assert.equal(result.isHtml, true)
  assert.equal(result.html, html)
})

test('a server that refuses head is retried with a get, whose body is dropped unread', async () => {
  const body = countedBody('binary', 100)
  const {fetchImpl, calls} = stubFetch(call =>
    call.method === 'HEAD'
      ? respond({status: 405})
      : respond({headers: {'content-type': 'video/mp4', 'content-length': '900'}, body: body.stream}),
  )

  const result = await classify('https://example.com/clip', {fetchImpl})
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(
    calls.map(c => c.method),
    ['HEAD', 'GET'],
  )
  assert.equal(result.kind, 'video')
  assert.equal(result.bytes, 900)
  assert.equal(result.isHtml, false)
  assert.equal(body.cancelled(), true)
})

test('a head that never lands falls through to a get', async () => {
  const {fetchImpl, calls} = stubFetch(call => {
    if (call.method === 'HEAD') throw new TypeError('fetch failed')
    return respond({headers: {'content-type': 'image/webp'}})
  })

  const result = await classify('https://example.com/x', {fetchImpl})

  assert.deepEqual(
    calls.map(c => c.method),
    ['HEAD', 'GET'],
  )
  assert.equal(result.kind, 'image')
})

test('a server that never says what it is classifies as nothing, not as an error', async () => {
  const {fetchImpl, calls} = stubFetch(() => respond({}))

  const result = await classify('https://example.com/mystery', {fetchImpl})

  assert.deepEqual(
    calls.map(c => c.method),
    ['HEAD', 'GET'],
  )
  assert.equal(result.mime, undefined)
  assert.equal(result.kind, undefined)
  assert.equal(result.isHtml, false)
  assert.equal(result.html, undefined)
})

test('a giant html body stops at the cap instead of buffering the whole thing', async () => {
  const body = countedBody('a'.repeat(64 * 1024), 48) // 3 MB on offer
  const {fetchImpl} = stubFetch(call =>
    call.method === 'HEAD'
      ? respond({headers: {'content-type': 'text/html'}})
      : respond({headers: {'content-type': 'text/html'}, body: body.stream}),
  )

  const result = await classify('https://example.com/huge', {fetchImpl})

  assert.equal(result.html?.length, 2 * 1024 * 1024)
  assert.equal(body.cancelled(), true)
  assert.ok(body.sent() <= 2 * 1024 * 1024 + 64 * 1024, `pulled ${body.sent()} bytes past the cap`)
})

test('a non-http url is refused before anything is fetched', async () => {
  const {fetchImpl, calls} = stubFetch(() => respond({}))

  await assert.rejects(() => classify('file:///etc/passwd', {fetchImpl}), /look like a link/)
  await assert.rejects(() => classify('data:text/html,<b>hi', {fetchImpl}), /look like a link/)
  await assert.rejects(() => classify('paste something here', {fetchImpl}), /look like a link/)
  assert.equal(calls.length, 0)
})

test('the url after redirects is the one extractors get', async () => {
  const {fetchImpl} = stubFetch(() =>
    respond({headers: {'content-type': 'image/png'}, url: 'https://cdn.example.com/real.png'}),
  )

  const result = await classify('https://example.com/go?to=1', {fetchImpl})

  assert.equal(result.url, 'https://cdn.example.com/real.png')
})

test('a host that answers nothing at all reads like a sentence', async () => {
  const {fetchImpl} = stubFetch(() => {
    throw new TypeError('fetch failed')
  })

  await assert.rejects(
    () => classify('https://nope.example.com/a', {fetchImpl}),
    /Could not reach nope\.example\.com/,
  )
})
