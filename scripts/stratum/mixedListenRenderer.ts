import { AudioEngine } from '../../src/renderer/audio/AudioEngine'
import type { CompleteFloat32Pcm } from '../../src/renderer/audio/completePcm'
import type { Track } from '../../src/renderer/types/audio'

// One isolated window, four 16-second album transitions, two seconds between
// cases. Each pair is the album's actual ending -> beginning, in Original.
type Route = 'stratum' | 'local' | 'subsonic'
const cases: [Route, Route][] = [['stratum', 'local'], ['local', 'stratum'], ['stratum', 'subsonic'], ['subsonic', 'stratum']]
const label = (route: Route) => route === 'stratum' ? 'Stratum' : route === 'local' ? 'Local' : 'Conventional streaming'
const api = (window as unknown as { stratumListen: {
  localFiles: string[]; decodeLocal: (path: string, rate: number) => Promise<CompleteFloat32Pcm>
} }).stratumListen
const engine = new AudioEngine()
engine.setVolume(.25)
engine.normalizationEnabled = false
const state = { ready: false, playing: false, done: false, error: '', transitions: 0, buffering: 0,
  outputRate: 0, caseIndex: 0, route: '', track: '', quality: '', position: 0,
  results: [] as { routes: string; transitions: number; buffering: number; localAtHandoff: boolean }[] }
const scope = window as unknown as { testState: typeof state; testPlay: () => Promise<void> }
scope.testState = state
let stopped = false, transitions = 0, buffering = 0, localAtHandoff = false
const message = document.getElementById('message')!
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const track = (route: Route, index: number): Track => ({ id: `${route}-${index}`, sourceType: route === 'local' ? 'local' : 'subsonic',
  sourceId: route === 'stratum' ? 7 : 8, path: route === 'local' ? api.localFiles[index]
    : `subsonic://${route === 'stratum' ? 7 : 8}/track/${index ? 'second' : 'first'}`,
  title: index ? 'What Are The Odds' : 'Safe Room', artist: 'Alohaii', album: 'Patchwork', duration: 8,
  format: 'FLAC', sampleRate: 48000, channels: 2 })
function draw() {
  const quality = engine.getRemotePlaybackQuality()
  state.quality = quality ? quality.requested === 'original' ? 'Original' : `${quality.requested} kbps` : 'Local'
  message.textContent = state.error || (state.done ? 'Finished' : `${state.caseIndex + 1}/4 · ${state.route} · ${state.track} · ${state.position.toFixed(1)} s`)
}
async function stop() { stopped = true; engine.setMuted(true); await engine.stop(); state.done = true; state.playing = false; draw() }
function fail(error: unknown) { state.error = String(error); void stop() }
async function prepareNext() {
  const [current, next] = cases[state.caseIndex]
  const nextTrack = track(next, 1)
  if (next === 'local') {
    const pcm = await api.decodeLocal(nextTrack.path, await engine.getStandardDecodeSampleRate())
    if (stopped) return
    await engine.preBufferNextPcm(pcm, { trackPath: nextTrack.path })
    if (!engine.stageNextLocalBuffer(nextTrack)) throw new Error('Local handoff was not staged.')
  } else await engine.preBufferNextRemoteTrack(nextTrack, null, { currentTrack: track(current, 0) })
  if (!engine.hasNextBuffered && !stopped) throw new Error('Next track did not become ready.')
}
async function prepareCase() {
  const [first, next] = cases[state.caseIndex]
  state.route = `${label(first)} → ${label(next)}`
  state.track = 'Preparing…'; state.position = 0
  transitions = buffering = 0; localAtHandoff = false
  draw()
  if (first === 'local') {
    const pcm = await api.decodeLocal(api.localFiles[0], await engine.getStandardDecodeSampleRate())
    if (stopped) return
    state.outputRate = pcm.sampleRate
    await engine.loadPcmData(pcm, { trackPath: api.localFiles[0] })
  } else {
    const info = await engine.loadProgressiveStream(track(first, 0), { streamingQuality: 'original' })
    state.outputRate = info.sampleRate
    if ((info.transport === 'stratum-proof') !== (first === 'stratum')) throw new Error('Unexpected transport.')
    const deadline = Date.now() + 8000
    while (!engine.hasRemotePrebufferHeadroom() && !stopped) {
      if (Date.now() > deadline) throw new Error('Current track did not gain enough headroom.')
      await delay(20)
    }
    if (!stopped) await prepareNext()
  }
  state.track = 'Safe Room'; draw()
}
async function playCase() {
  if (stopped) return
  state.playing = true
  await engine.play()
  // Exercise the local BufferSource -> worklet bridge while it is playing.
  if (cases[state.caseIndex][0] === 'local' && !stopped) await prepareNext()
}
engine.on('error', fail)
engine.on('stateChange', value => { if (state.playing && value === 'loading') { state.buffering++; buffering++ } })
engine.on('timeUpdate', value => { state.position = Number(value); draw() })
engine.on('gaplessTransition', () => {
  state.transitions++; transitions++; state.track = 'What Are The Odds'
  localAtHandoff = !!engine.getAudioBuffer()
  if (localAtHandoff !== (cases[state.caseIndex][1] === 'local')) fail('Unexpected local-buffer ownership at handoff.')
  draw()
})
engine.on('ended', () => {
  if (stopped) return
  state.playing = false
  state.results.push({ routes: state.route, transitions, buffering, localAtHandoff })
  if (transitions !== 1) { fail('Expected one gapless handoff.'); return }
  if (state.caseIndex === cases.length - 1) { state.done = true; draw(); return }
  state.track = 'Brief pause between tests'; draw()
  void (async () => {
    await delay(2000)
    if (stopped) return
    state.caseIndex++
    await prepareCase()
    await playCase()
  })().catch(fail)
})
scope.testPlay = async () => { await playCase() }
document.getElementById('stop')!.addEventListener('click', () => { void stop() })
window.addEventListener('beforeunload', () => { engine.setMuted(true); void engine.stop() })
void prepareCase().then(() => { state.ready = !stopped; draw() }).catch(fail)
