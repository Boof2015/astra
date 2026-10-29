// Imported only by fullApp.config.ts. Real stores/engine/UI; no playback mocks.
import { usePlayerStore as player } from '../../src/renderer/stores/playerStore'
import { useLibraryStore as library } from '../../src/renderer/stores/libraryStore'
import { useUIStore as ui } from '../../src/renderer/stores/uiStore'
import { useAudioSettingsStore as audio } from '../../src/renderer/stores/audioSettingsStore'
import { audioEngine } from '../../src/renderer/audio/AudioEngine'

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label) }
async function until(test: () => unknown, label: string, timeout = 15000) {
  const deadline = performance.now() + timeout
  while (!test()) { if (performance.now() > deadline) throw new Error(`Timed out: ${label}`); await wait(20) }
}
const handoffs: Array<{ path: string | null; queueId: string | null; local: boolean }> = []
const states: Array<{ path: string | null; state: string }> = []
let phase = 'startup'
let buffering = 0
audioEngine.on('gaplessTransition', () => {
  // playerStore installs its listener during app mount; inspect after all listeners.
  queueMicrotask(() => handoffs.push({ path: player.getState().currentTrack?.path ?? null,
    queueId: player.getState().currentQueueItemId, local: !!audioEngine.getAudioBuffer() }))
})
player.subscribe((state, previous) => {
  if (state.currentTrack?.path !== previous.currentTrack?.path || state.playbackState !== previous.playbackState) {
    states.push({ path: state.currentTrack?.path ?? null, state: state.playbackState })
  }
  if (phase === 'mixed' && previous.playbackState === 'playing' && state.playbackState === 'loading') buffering++
})
function snapshot() {
  const s = player.getState()
  return { phase, current: s.currentTrack?.path, state: s.playbackState, time: s.currentTime, duration: s.duration,
    queueId: s.currentQueueItemId, queue: s.queueItems.map(item => ({ id: item.queueId, path: item.entry.path })),
    next: audioEngine.nextBufferedTrackPath, progress: s.remoteLoadProgress, local: !!audioEngine.getAudioBuffer(),
    indicator: document.querySelector('.transport-stream-quality')?.textContent ?? null, handoffs, buffering, states,
    text: document.body.innerText.slice(-3500) }
}
function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  check(button && !button.disabled, `Missing enabled ${label} control`)
  button.click()
}
async function verifyIdentity(path: string) {
  await until(() => player.getState().currentTrack?.path === path && player.getState().playbackState === 'playing', `playing ${path}`)
  await frames()
  const local = !path.startsWith('subsonic://')
  const s = player.getState()
  check(s.queueItems.find(item => item.queueId === s.currentQueueItemId)?.entry.path === path, 'Queue identity must match playback')
  check(!!audioEngine.getAudioBuffer() === local, 'Local buffer ownership must match source')
  if (local) {
    check(s.remoteLoadProgress === null && s.remoteStreamSessionId === null, 'Local handoff must clear remote state')
    check(!document.querySelector('.transport-stream-quality'), 'Local track must clear streaming indicator')
    check(!!s.waveformData, 'Local waveform must remain available')
  } else {
    check(s.currentTrack?.sourceType === 'subsonic', 'Provider identity must survive Stratum transport')
    check(s.remoteLoadProgress?.path === path, 'Progress must belong to playing track')
    check(s.remoteLoadProgress?.quality?.mode === 'automatic', 'Automatic mode must reach the store')
    check(document.querySelector('.transport-stream-quality')?.textContent?.includes('Original'), 'Rendered automatic readout must show playing Original')
  }
}
const driver = {
  snapshot,
  stop: () => player.getState().stop(),
  async run({ directory }: { directory: string }) {
    await until(() => library.getState().totalTrackCount === 6 && !library.getState().isLoading, 'real library startup')
    await wait(500)
    check(audio.getState().playbackOutputMode === 'standard', 'Fresh profile must use Standard output')
    audio.getState().setNormalizationEnabled(false)
    player.getState().setVolume(0)
    ui.setState({ activeView: 'library' })
    library.getState().setViewMode('tracks')
    const s1 = 'subsonic://1/track/first', s2 = 'subsonic://1/track/second'
    const c2 = 'subsonic://2/track/second', local = `${directory}/music/second.flac`
    phase = 'row-click'
    await until(() => document.querySelector(`[data-controller-key=${JSON.stringify(`track:${s1}`)}]`), 'real track row')
    document.querySelector<HTMLElement>(`[data-controller-key=${JSON.stringify(`track:${s1}`)}]`)!.click()
    await until(() => player.getState().currentTrack?.path === s1 && player.getState().playbackState === 'playing', 'row click starts catalog track')
    player.getState().stop()
    phase = 'mixed'
    handoffs.length = 0; buffering = 0
    const sequence = [s1, local, s1, c2, s1]
    await player.getState().startPlaybackContextByPaths(sequence, 0, { contextLabel: 'Stratum mixed-source check' })
    await verifyIdentity(s1)
    const mixedQueueIds = player.getState().queueItems.map(item => item.queueId)
    check(mixedQueueIds.length === 5 && new Set(mixedQueueIds).size === 5, 'Repeated track paths must have distinct queue identities')
    for (let i = 1; i < sequence.length; i++) {
      await until(() => handoffs.length >= i, `natural handoff ${i}`)
      await verifyIdentity(sequence[i])
      check(player.getState().currentQueueItemId === mixedQueueIds[i], 'Natural handoff must advance exactly one queue entry')
    }
    check(handoffs.length === 4 && buffering === 0, 'Mixed queue must have four handoffs without buffering')
    const mixed = { handoffs: [...handoffs], buffering, queueIds: mixedQueueIds }
    phase = 'paused-seek'
    click('Pause')
    await until(() => player.getState().playbackState === 'paused', 'pause control')
    await player.getState().seek(2.25)
    check(player.getState().playbackState === 'paused', 'Seeking paused Stratum must stay paused')
    check(Math.abs(player.getState().currentTime - 2.25) < .1, 'Paused seek must update position')
    click('Play')
    await verifyIdentity(s1)
    check(player.getState().currentTime >= 2.2, 'Resume must retain seek position')
    phase = 'quality-prefetch'
    player.getState().stop()
    await player.getState().startPlaybackContextByPaths([s1, s2], 0)
    await verifyIdentity(s1)
    await until(() => audioEngine.hasNextBuffered, 'initial next-track preparation')
    const beforeQuality = handoffs.length
    await window.electronAPI.setStreamingQuality(64, { provider: 'subsonic', sourceId: 1 })
    check(player.getState().remoteLoadProgress?.quality?.requested === 'original', 'Setting change must leave current audio unchanged')
    await until(() => handoffs.length > beforeQuality && player.getState().currentTrack?.path === s2, 'quality setting applies at next track')
    await frames()
    check(player.getState().remoteLoadProgress?.quality?.requested === 64, 'Next prepared track must use 64 kbps')
    check(player.getState().remoteLoadProgress?.quality?.delivered?.codec === 'opus', 'Delivered quality must identify Opus')
    check(!document.querySelector('.transport-stream-quality'), 'Manual quality must not claim Automatic')
    click('Toggle audio pipeline shelf')
    await frames()
    check(document.querySelector('.pipeline-shelf')?.textContent?.includes('64'), 'Pipeline shelf must expose the reduced target')
    const quality = player.getState().remoteLoadProgress?.quality
    phase = 'rapid-skip'
    await window.electronAPI.setStreamingQuality(null, { provider: 'subsonic', sourceId: 1 })
    await player.getState().startPlaybackContextByPaths([s1, local, c2, s2], 0)
    const next1 = player.getState().playNext()
    const next2 = player.getState().playNext()
    await Promise.all([next1, next2])
    await verifyIdentity(c2)
    await wait(300)
    check(player.getState().currentTrack?.path === c2, 'Late Stratum/local work must not replace latest skip')
    phase = 'complete'
    const result = { mixed, quality, final: snapshot() }
    player.getState().pause()
    return result
  }
}
Object.assign(window, { stratumFullApp: driver })
