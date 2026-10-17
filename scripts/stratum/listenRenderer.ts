import { AudioEngine } from '../../src/renderer/audio/AudioEngine'
import type { Track } from '../../src/renderer/types/audio'

// Only used in the bounded, separate listening window. No personal app stores.
const engine = new AudioEngine()
const qualityTest = (window as unknown as { stratumListen: { scenario: string } }).stratumListen.scenario === 'quality'
engine.setVolume(.25)
engine.normalizationEnabled = false
const state = { ready: false, playing: false, done: false, error: '', transitions: 0, buffering: 0,
  outputRate: 0, track: 'Safe Room', quality: 'Original', position: 0 }
const scope = window as unknown as { testState: typeof state; testPlay: () => Promise<void>; testStop: () => Promise<void> }
scope.testState = state
const message = document.getElementById('message')!
function draw() {
  message.textContent = state.error || (state.done ? 'Finished' : state.ready
    ? `${state.track} · ${state.quality} · ${state.position.toFixed(1)} s` : 'Preparing both tracks…')
}
engine.on('error', error => { state.error = String(error); void scope.testStop(); draw() })
engine.on('stateChange', value => { if (state.playing && value === 'loading') state.buffering++ })
engine.on('timeUpdate', value => {
  state.position = Number(value)
  if (qualityTest) state.quality = state.position >= 12 && state.position < 24 ? 'Opus 64 kbps' : 'Original'
  draw()
})
engine.on('gaplessTransition', () => {
  state.transitions++; state.track = 'What Are The Odds'; state.quality = 'Opus 64 kbps'; draw()
})
engine.on('ended', () => { state.done = true; state.playing = false; draw() })
scope.testStop = async () => { engine.setMuted(true); await engine.stop(); state.done = true; state.playing = false; draw() }
scope.testPlay = async () => {
  if (!state.ready || state.playing || state.done) throw new Error('Listening fixture is not ready.')
  state.playing = true
  await engine.play()
}
document.getElementById('stop')!.addEventListener('click', () => { void scope.testStop() })
window.addEventListener('beforeunload', () => { engine.setMuted(true); void engine.stop() })

const track = (id: string, title: string): Track => ({ id, title, path: `subsonic://7/${id}`,
  sourceType: 'subsonic', sourceId: 7, artist: 'Alohaii', album: 'Patchwork', duration: qualityTest ? 32 : 16,
  format: 'FLAC', channels: 2, sampleRate: 48000 })
async function prepare() {
  const first = await engine.loadRemoteStream(track('first', 'Safe Room'), { streamingQuality: 'original' })
  if (first.transport !== 'stratum-proof') throw new Error('The test did not enter the Stratum route.')
  state.outputRate = first.sampleRate
  if (!qualityTest) await engine.preBufferNextRemoteTrack(track('second', 'What Are The Odds'), null)
  state.ready = true
  draw()
}
void prepare().catch(error => { state.error = String(error); draw() })
