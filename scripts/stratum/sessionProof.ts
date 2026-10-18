/** Real Sidecar + Astra session/PCM lifecycle. Node only; no audio output. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Writable } from 'node:stream'
import { createRequire } from 'node:module'
import { StratumProofSession } from '../../src/main/services/stratumProofSession.ts'
import { StratumProofPcm } from '../../src/main/services/stratumProofPlayback.ts'

const binary = process.env.ASTRA_STRATUM_SIDECAR
assert.ok(binary, 'Set ASTRA_STRATUM_SIDECAR to a sidecar-access binary with session renewal.')
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('Astra renews a shared Sidecar session across current/next PCM and seek without re-staging', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-stratum-session-'))
  const password = randomBytes(24).toString('hex')
  const frames = 48000 * 9 + 317
  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28)
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40)
  const reference = Buffer.alloc(frames * 8)
  for (let i = 0; i < frames * 2; i++) {
    const sample = ((i * 197) % 8192) - 4096
    wav.writeInt16LE(sample, 44 + i * 2); reference.writeInt32LE(sample * 65536, i * 4)
  }
  let reads = 0, signIns = 0, suppliers = 0
  let deny = false
  const salts = new Set<string>()
  const upstream = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    assert.ok(!req.url?.includes('?'))
    const values = new URLSearchParams(body)
    const reply = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': value })) }
    if (values.get('u') !== 'listener' || values.get('t') !== createHash('md5').update(password + values.get('s')).digest('hex')) {
      reply({ status: 'failed', error: { code: 40 } }); return
    }
    if (req.url?.endsWith('ping.view')) {
      signIns++; salts.add(values.get('s')!); reply({ status: 'ok' }); return
    }
    if (deny) { reply({ status: 'failed', error: { code: 50 } }); return }
    if (req.url?.endsWith('getSong.view')) { reply({ status: 'ok', song: { id: values.get('id'), size: wav.length } }); return }
    assert.ok(req.url?.endsWith('stream.view'))
    if (req.headers.range) {
      res.writeHead(206, { 'content-type': 'audio/wav', 'content-range': `bytes 0-0/${wav.length}` }); res.end(wav.subarray(0, 1))
    } else { reads++; res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length }); res.end(wav) }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const path = join(directory, 'sidecar.json')
  await writeFile(path, JSON.stringify({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    session_seconds: 2, run_seconds: 30 }), { mode: 0o600 })
  const child = spawn(binary!, ['--config', path], { env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = once(child, 'close')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 28000)
  t.after(async () => {
    clearTimeout(deadline); child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    await closed; clearTimeout(force); await rm(directory, { recursive: true, force: true })
  })
  let line = ''
  child.stdout.on('data', chunk => { line += chunk })
  const end = Date.now() + 5000
  while (!line.includes('\n')) { assert.ok(Date.now() < end, 'Sidecar did not start'); await pause(10) }
  const endpoint = JSON.parse(line.split('\n')[0]).listen as string
  const owner = new StratumProofSession(endpoint, async () => { suppliers++; return { username: 'listener', password } })
  t.after(() => owner.close())
  const signal = AbortSignal.timeout(20000)
  const [current, next] = await Promise.all([
    StratumProofPcm.open(owner, 'current', 48000, 0, signal),
    StratumProofPcm.open(owner, 'next', 48000, 0, signal)
  ])
  t.after(async () => { await current.release(); await next.release() })
  assert.equal(suppliers, 1)
  const token = await owner.getBearer(signal)
  async function collect(pcm: StratumProofPcm, paced: boolean) {
    const chunks: Buffer[] = []
    const sink = new Writable({ write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk))
      if (paced) setTimeout(done, 1100)
      else done()
    } })
    await pcm.feed(sink, ffmpeg, signal, 'lossless')
    return Buffer.concat(chunks)
  }
  assert.deepEqual(await collect(current, true), reference)
  assert.ok(signIns >= 3, 'short leases should have renewed while PCM was backpressured')
  assert.equal(await owner.getBearer(signal), token)
  assert.deepEqual(await collect(next, false), reference)
  assert.equal(reads, 2, 'renewal must keep staged current and next sources')
  const sought = await StratumProofPcm.open(owner, 'current', 48000, 5, signal)
  assert.deepEqual(await collect(sought, false), reference.subarray(5 * 48000 * 8))
  assert.equal(salts.size, signIns, 'each renewal must use a newly generated tuple')
  const denied = await StratumProofPcm.open(owner, 'current', 48000, 0, signal)
  deny = true
  await assert.rejects(collect(denied, false), /no longer available/)
  await denied.release()
  await owner.close()
  await assert.rejects(owner.getBearer(signal), /ended/)
  t.diagnostic(`renewal checks passed; ${signIns} fresh sign-ins; exact PCM before/after expiry; no audio device opened`)
})
