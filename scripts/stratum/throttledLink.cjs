// Test-only loopback link. Pace actual response bytes; never replace policy
// observations or schedule quality choices. No system network settings change.
const { createServer } = require('node:http')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const assert = require('node:assert/strict')

exports.throttledLink = async function throttledLink(endpoint) {
  const origin = new URL(endpoint)
  assert.equal(origin.hostname, '127.0.0.1')
  assert.equal(origin.protocol, 'http:')
  const segments = []
  const pending = new Set()
  let began = null
  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    pending.add(controller)
    res.once('close', () => controller.abort())
    try {
      if (!/^\/(access|audio)\/v1\/[a-zA-Z0-9_/-]+$/.test(req.url || '') || !['GET', 'POST', 'DELETE'].includes(req.method)) {
        res.writeHead(404); res.end(); return
      }
      const chunks = []
      let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > 16384) throw new Error('Fixture request too large.')
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      const segment = req.url.endsWith('/segment')
      let entry
      if (segment) {
        const request = JSON.parse(body.toString())
        began ??= performance.now()
        entry = { number: segments.length + 1, start: request.start, frames: request.frames,
          quality: request.quality, atSeconds: (performance.now() - began) / 1000, bytes: 0, elapsedSeconds: 0 }
        segments.push(entry)
      }
      const response = await fetch(new URL(req.url, origin), { method: req.method,
        headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(body.length ? { 'content-type': 'application/json' } : {}) },
        ...(body.length ? { body } : {}), redirect: 'error', signal: controller.signal })
      const data = Buffer.from(await response.arrayBuffer())
      assert.ok(data.length <= 4 * 1024 * 1024 + 16388)
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'content-length': data.length })
      if (!segment || response.status !== 200) { res.end(data); return }
      res.flushHeaders()
      const transferStart = performance.now()
      for (let offset = 0; offset < data.length;) {
        controller.signal.throwIfAborted()
        // Build some headroom, then constrain original delivery for a sustained
        // interval, then restore capacity. Recovery is measured in real time.
        const kbps = entry.number <= 4 || performance.now() - began >= 28000 ? 16000 : 900
        const end = Math.min(offset + 4096, data.length)
        await delay((end - offset) * 8 / kbps, undefined, { signal: controller.signal })
        if (!res.write(data.subarray(offset, end))) await once(res, 'drain', { signal: controller.signal })
        offset = end
      }
      entry.bytes = data.length
      entry.elapsedSeconds = (performance.now() - transferStart) / 1000
      res.end()
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502)
      res.destroy()
    } finally { pending.delete(controller) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { endpoint: `http://127.0.0.1:${server.address().port}`, segments,
    close: async () => {
      for (const controller of pending) controller.abort()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    } }
}
