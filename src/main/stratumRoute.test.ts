import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { parseSubsonicTrackPath } from './services/subsonic.ts'
import { stratumQualitySelection } from './services/stratumProofConfig.ts'
import { resolveStreamingQuality } from '../types/streamingQuality.ts'

const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installedStratumRoute')!
const javascript = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('installed routing respects format, source, per-server quality, compatibility and cancellation', async () => {
  const calls: number[] = []
  let track: any = { format: 'flac', sample_rate: 48000, bit_depth: 24, channels: 2, duration: 180 }
  let failure = false
  const connection = { endpoint: 'https://sidecar.test', qualityKey: 'non-secret-connection-id', getBearer() {} }
  const context = { parseSubsonicTrackPath, stratumQualitySelection, resolveStreamingQuality,
    library: { getTrackByPath: () => track },
    streamingQualityPreferences: { read: () => ({ global: 'original', overrides: { 'subsonic:7': 64 } }) },
    getStratumAudioCache: () => ({}),
    stratumConnections: { cachedConnection: (id: number) => { calls.push(id); if (failure) throw new Error('offline'); return { connection, scope: 'scope' } } } }
  const route = new Function(...Object.keys(context), javascript + '\nreturn installedStratumRoute;')(...Object.values(context))
  const signal = AbortSignal.timeout(5000)
  const selected = await route('subsonic://7/track/song', undefined, signal)
  assert.equal(selected.connection, connection); assert.equal(selected.quality, 'opus-64')
  assert.deepEqual(calls, [7])
  assert.equal((await route('subsonic://7/track/song', 'automatic-original', signal)).mode, 'automatic-original')
  assert.equal((await route('subsonic://7/track/song', { mode: 'automatic', target: 128 }, signal)).pinInitial, true)
  assert.equal((await route('subsonic://7/track/song', 128, signal)).quality, 'opus-128')
  const before = calls.length
  for (const quality of [192, 256, 320, { target: 'original', compatibility: 'flac' }]) {
    assert.equal(await route('subsonic://7/track/song', quality, signal), null)
  }
  for (const path of ['/music/local.flac', 'jellyfin://7/track', 'plex://7/track']) assert.equal(await route(path, 'original', signal), null)
  for (const patch of [{ format: 'mp3' }, { sample_rate: 192000 }, { bit_depth: 32 }, { channels: 6 }, { duration: 1801 }]) {
    const original = track; track = { ...track, ...patch }
    assert.equal(await route('subsonic://7/track/song', 'original', signal), null)
    track = original
  }
  assert.equal(calls.length, before)
  failure = true
  assert.equal(await route('subsonic://7/track/song', 'original', signal), null)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(route('subsonic://7/track/song', 'original', aborted.signal))
})
