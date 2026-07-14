import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const EXAMPLES_DIR = fileURLToPath(new URL('../../../docs/api/examples/', import.meta.url))

async function run(
  command: string,
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: EXAMPLES_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const [exitCode] = await once(child, 'exit') as [number | null]
  assert.equal(exitCode, 0, stderr)
  return { stdout, stderr }
}

async function withMockApi(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void,
  callback: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('observation example consumes an SSE playback event', async () => {
  await withMockApi((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('event: playback\ndata: {"state":"playing"}\n\n')
  }, async (baseUrl) => {
    const result = await run(process.execPath, ['observe.mjs'], {
      ASTRA_API_URL: baseUrl,
      ASTRA_API_TOKEN: 'test-token'
    })
    assert.match(result.stdout, /playback \{ state: 'playing' \}/)
  })
})

test('search-to-play and queue examples send only high-level intents', async () => {
  const intents: Array<Record<string, unknown>> = []
  await withMockApi((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v2/search')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        results: [
          { type: 'track', ref: 'astra.track.one.sig', title: 'One', subtitle: 'Artist' },
          { type: 'track', ref: 'astra.track.two.sig', title: 'Two', subtitle: 'Artist' }
        ]
      }))
      return
    }
    if (req.method === 'POST' && req.url === '/v2/intents') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        intents.push(JSON.parse(body) as Record<string, unknown>)
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end('{"accepted":true}')
      })
      return
    }
    res.writeHead(404).end()
  }, async (baseUrl) => {
    const env = { ASTRA_API_URL: baseUrl, ASTRA_API_TOKEN: 'test-token' }
    await run(process.execPath, ['search-to-play.mjs', 'One'], env)
    await run(process.execPath, ['queue.mjs', 'Artist'], env)
  })

  assert.deepEqual(intents[0], {
    action: 'play',
    targetRef: 'astra.track.one.sig'
  })
  assert.deepEqual(intents.slice(1), [
    { action: 'enqueue', targetRef: 'astra.track.one.sig', position: 'next' },
    { action: 'enqueue', targetRef: 'astra.track.two.sig', position: 'end' }
  ])
})

test('Python playlist generator searches, creates, and fills one bounded playlist', async () => {
  const mutations: Array<{ url: string; body: Record<string, unknown> }> = []
  await withMockApi((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v2/search')) {
      const query = new URL(req.url, 'http://localhost').searchParams.get('q') ?? 'track'
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ results: [{ ref: `astra.track.${query}.sig`, title: query }] }))
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        mutations.push({ url: req.url ?? '', body: JSON.parse(body) as Record<string, unknown> })
        res.setHeader('Content-Type', 'application/json')
        res.end(req.url === '/v2/playlists'
          ? '{"ref":"astra.playlist.generated.sig","title":"Generated"}'
          : '{"added":2}')
      })
      return
    }
    res.writeHead(404).end()
  }, async (baseUrl) => {
    const result = await run('python3', [
      'playlist-generator.py',
      'Generated',
      'Alpha',
      'Beta'
    ], {
      ASTRA_API_URL: baseUrl,
      ASTRA_API_TOKEN: 'test-token'
    })
    assert.match(result.stdout, /Created Generated with 2 tracks/)
  })

  assert.deepEqual(mutations, [
    { url: '/v2/playlists', body: { name: 'Generated' } },
    {
      url: '/v2/playlists/astra.playlist.generated.sig/items',
      body: { trackRefs: ['astra.track.Alpha.sig', 'astra.track.Beta.sig'] }
    }
  ])
})
