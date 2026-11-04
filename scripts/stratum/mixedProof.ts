import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mixedHarness, mixedTrack, type MixedConfig, type MixedRoute } from './mixedHarness.ts'
import { mixedEngineHarness } from './mixedEngineHarness.ts'
import type { StratumProofConfig } from '../../src/main/services/stratumProofConfig.ts'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 15000
  while (!check()) { assert.ok(Date.now() < deadline, message); await delay(5) }
}
function equalPcm(actual: Buffer, expected: Buffer, label: string) {
  assert.equal(actual.length, expected.length, `${label}: PCM length`)
  if (actual.equals(expected)) return
  // Never ask node:assert to format a multi-megabyte Buffer diff.
  for (let offset = 0; offset < actual.length; offset += 4) {
    if (actual.readFloatLE(offset) !== expected.readFloatLE(offset)) {
      throw new Error(`${label}: first differing sample at frame ${Math.floor(offset / 8)}, channel ${(offset / 4) % 2}: ${actual.readFloatLE(offset)} != ${expected.readFloatLE(offset)}`)
    }
  }
}

export async function mixedProof(config: MixedConfig, connection: StratumProofConfig, ffmpeg: string) {
  const results: unknown[] = []
  const pairs: [MixedRoute, MixedRoute][] = ['local', 'progressive-local', 'subsonic', 'jellyfin', 'plex']
    .flatMap(route => [['stratum', route], [route, 'stratum']] as [MixedRoute, MixedRoute][])
  for (const [firstRoute, nextRoute] of pairs) {
    let renderer: ReturnType<typeof mixedEngineHarness> | undefined
    const h = mixedHarness(connection, ffmpeg, config, { deliver: (channel, value) => renderer?.deliver(channel, value) })
    renderer = mixedEngineHarness(h)
    const { engine, internal } = renderer
    const first = mixedTrack(config.directory, firstRoute, 'first', config.duration)
    const next = mixedTrack(config.directory, nextRoute, 'second', config.duration)
    let transitions = 0, ended = 0, buffering = 0
    const promotions: unknown[] = []
    let phase = 'setup'
    const step = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
      phase = label
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([work(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Mixed fixture timed out at ${label}`)), 12000)
        })])
      } finally { clearTimeout(timer) }
    }
    engine.on('gaplessTransition', () => {
      transitions++
      promotions.push({ path: internal.remoteStreamState?.path, transport: internal.remoteStreamState?.transport,
        sourceType: internal.remoteStreamState?.sourceType, localBuffer: !!engine.getAudioBuffer(),
        quality: engine.getRemotePlaybackQuality()?.requested })
    })
    engine.on('ended', () => { ended++ })
    engine.on('stateChange', value => { if (value === 'loading' && internal.remoteStreamState?.playRequested) buffering++ })
    try {
      const originalFirst = await step('reference first', () => h.decodeLocal(join(config.directory, 'first.flac'), 44100))
      const originalNext = await step('reference second', () => h.decodeLocal(join(config.directory, 'second.flac'), 44100))
      // Loading transfers ownership and clears the supplied object's PCM field.
      // Keep independent reference views before handing those objects to AudioEngine.
      const referenceFirst = Buffer.from(originalFirst.interleavedPcm)
      const referenceNext = Buffer.from(originalNext.interleavedPcm)
      if (firstRoute === 'local') await step('load local', () => engine.loadPcmData(originalFirst, { trackPath: first.path }))
      else {
        await step('load progressive', () => engine.loadProgressiveStream(first, { streamingQuality: 'original' }))
        await until(() => internal.remoteStreamState?.sourceEnded, 'Current decode did not finish.')
      }
      await step('play', () => engine.play())
      const output: Buffer[] = []
      const render = async (frames: number) => {
        while (frames > 0) {
          const count = Math.min(257, frames)
          const channels = await renderer!.render(count)
          const interleaved = Buffer.alloc(count * 8)
          for (let i = 0; i < count; i++) for (let c = 0; c < 2; c++) interleaved.writeFloatLE(channels[c][i], i * 8 + c * 4)
          output.push(interleaved)
          frames -= count
        }
      }
      // Prepare while the ordinary local BufferSource is already playing; its
      // scheduled bridge must neither repeat nor omit the joining sample.
      const prefix = 44100 * 2 + 137
      await step('render prefix', () => render(prefix))
      assert.equal(engine.canPreBufferRemoteTrack(next), true)
      if (nextRoute === 'local') {
        await step('prepare local', () => engine.preBufferNextPcm(originalNext, { trackPath: next.path }))
        assert.equal(engine.stageNextLocalBuffer(next), true)
      } else await step('prepare progressive', () => engine.preBufferNextRemoteTrack(next, null, { currentTrack: first }))
      await until(() => internal.nextRemoteStream?.state.sourceEnded, 'Prepared decode did not finish.')
      const afterBoundary = 22050
      await step('render handoff', () => render(originalFirst.frames + afterBoundary - prefix))
      assert.equal(transitions, 1)
      assert.equal(ended, 0)
      assert.equal(buffering, 0)
      assert.deepEqual(renderer.errors, [])
      const expected = Buffer.concat([referenceFirst, referenceNext])
      equalPcm(Buffer.concat(output), expected.subarray(0, (originalFirst.frames + afterBoundary) * 8), `${firstRoute} -> ${nextRoute}: handoff`)
      const current = internal.remoteStreamState
      assert.equal(current.path, next.path)
      assert.equal(current.sourceType, next.sourceType)
      assert.equal(current.transport, nextRoute === 'stratum' ? 'stratum-proof' : undefined)
      assert.equal(!!engine.getAudioBuffer(), nextRoute === 'local')
      if (nextRoute === 'local' || nextRoute === 'progressive-local') assert.equal(engine.getRemotePlaybackQuality(), undefined)
      for (const start of h.starts) {
        assert.equal(start.transport, start.path.startsWith('subsonic://7/') ? 'stratum-proof' : undefined)
      }
      assert.ok(h.acquisitions.every(path => !path.startsWith('subsonic://7/')))
      // Seek after promotion: complete local must reuse its existing buffer;
      // remote/progressive-local must keep their actual source and route.
      const before = h.starts.length
      engine.pause()
      await step('seek promoted track', () => engine.seek(1.25))
      assert.equal(h.starts.length, before + (nextRoute === 'local' ? 0 : 1))
      assert.equal(internal.remoteStreamState.path, next.path)
      assert.equal(internal.remoteStreamState.transport, nextRoute === 'stratum' ? 'stratum-proof' : undefined)
      assert.ok(Math.abs(engine.currentTime - 1.25) < 1 / 44100)
      assert.equal(engine.playbackState, 'paused')
      await until(() => internal.remoteStreamState?.sourceEnded, 'Sought decode did not finish.')
      output.length = 0
      await step('resume seek', () => engine.play())
      await step('render after seek', () => render(originalNext.frames - 1.25 * 44100))
      // Conventional progressive FFmpeg restarts have their existing resampler
      // edge response. Compare them to an independent decode at that seek, not
      // the uninterrupted file. Stratum preroll and complete local retain the
      // uninterrupted reference. Handoff comparisons above are exact throughout.
      const soughtReference = nextRoute === 'local' || nextRoute === 'stratum'
        ? referenceNext.subarray(1.25 * 44100 * 8)
        : Buffer.from((await h.decodeLocal(next.path.startsWith('/') ? next.path : join(config.directory, 'second.flac'), 44100, 1.25)).interleavedPcm)
      equalPcm(Buffer.concat(output), soughtReference, `${firstRoute} -> ${nextRoute}: seek`)
      assert.equal(ended, 1)
      assert.equal(buffering, 0)
      assert.deepEqual(renderer.errors, [])
      results.push({ first: firstRoute, next: nextRoute, handoffFrames: originalFirst.frames + afterBoundary, transitions, ended, buffering, promotions, seekPassed: true })
      console.log(`MIXED_PASSED ${firstRoute} -> ${nextRoute}: exact PCM, route identity, promotion and seek`)
    } catch (error) {
      writeFileSync(join(config.directory, 'mixed-failure.json'), JSON.stringify({ firstRoute, nextRoute, phase,
        error: String(error), starts: h.starts, events: h.events, buffered: internal.remoteStreamState?.bufferedFrames,
        sourceEnded: internal.remoteStreamState?.sourceEnded, errors: renderer.errors.map(String) }, null, 2))
      throw error
    } finally { await renderer.close(); await h.close() }
  }
  writeFileSync(join(config.directory, 'mixed-report.json'), JSON.stringify(results, null, 2))
}
