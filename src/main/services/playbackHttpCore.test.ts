import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer'
import { PlaybackHttpCore } from './playbackHttpCore.ts'

const artwork = `data:image/png;base64,${Buffer.from('first artwork').toString('base64')}`
const replacementArtwork = `data:image/png;base64,${Buffer.from('replacement artwork').toString('base64')}`

function snapshot(artworkData: string | null = artwork, id = 'track-1'): MiniPlayerSnapshot {
  return {
    playbackState: 'playing', currentTime: 1, duration: 180, queueLength: 1,
    shuffle: false, repeat: 'none', outputDeviceLabel: 'Default',
    timeDisplayMode: 'remaining', visualizerLineColor: '#38bdf8',
    currentTrack: {
      id, path: `/music/${id}.flac`, title: id, artist: 'Artist', album: 'Album',
      isFavorite: false, artworkData
    }
  }
}

function createCore(resolveArtworkDataUrl?: (hash: string) => Promise<string | null>) {
  return new PlaybackHttpCore({
    getSnapshot: () => null,
    dispatchCommand: () => {},
    authorizeRequest: () => true,
    buildArtworkUrl: (id) => `/artwork?trackId=${id}`,
    getControlsEnabled: () => true,
    resolveArtworkDataUrl
  })
}

function readArtwork(core: PlaybackHttpCore<boolean>, id = 'track-1') {
  let body: unknown
  const response = {
    statusCode: 0,
    setHeader: () => {},
    end: (value: unknown) => { body = value }
  }
  core.handleArtwork(
    {} as IncomingMessage,
    response as unknown as ServerResponse<IncomingMessage>,
    new URL(`http://localhost/artwork?trackId=${id}`)
  )
  return { status: response.statusCode, body }
}

test('progress, pause and seek snapshots reuse already decoded artwork', () => {
  const core = createCore()
  core.publishSnapshot(snapshot())
  const original = readArtwork(core)
  assert.equal(original.status, 200)
  assert.ok(Buffer.isBuffer(original.body))

  for (const playbackState of ['playing', 'paused', 'playing'] as const) {
    core.publishSnapshot({ ...snapshot(), playbackState, currentTime: 90 })
    assert.strictEqual(readArtwork(core).body, original.body)
  }

  core.publishSnapshot(snapshot(replacementArtwork))
  const replacement = readArtwork(core).body
  assert.notStrictEqual(replacement, original.body)
  assert.deepEqual(replacement, Buffer.from('replacement artwork'))
  core.publishSnapshot(snapshot(replacementArtwork))
  assert.strictEqual(readArtwork(core).body, replacement)

  core.publishSnapshot(snapshot(null, 'track-2'))
  assert.equal(readArtwork(core).status, 404)
  assert.equal(readArtwork(core, 'track-2').status, 404)
  core.publishSnapshot(null)
  assert.equal(readArtwork(core, 'track-2').status, 404)
})

test('new inline artwork still supersedes an outstanding hash lookup', async () => {
  let resolveLookup!: (value: string) => void
  const lookup = new Promise<string>((resolve) => { resolveLookup = resolve })
  const core = createCore(() => lookup)
  const initial = snapshot(null)
  initial.currentTrack!.artworkHash = 'pending-hash'
  core.publishSnapshot(initial)
  core.publishSnapshot(snapshot(replacementArtwork))
  const replacement = readArtwork(core).body
  core.publishSnapshot(snapshot(replacementArtwork))
  resolveLookup(artwork)
  await lookup
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.strictEqual(readArtwork(core).body, replacement)
  assert.deepEqual(replacement, Buffer.from('replacement artwork'))
})
