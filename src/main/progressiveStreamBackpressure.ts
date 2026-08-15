export const LOCAL_PROGRESSIVE_MAX_BUFFERED_SECONDS = 30
export const LOCAL_PROGRESSIVE_RESUME_BUFFERED_SECONDS = 15

export type LocalProgressiveBackpressureAction = 'pause' | 'resume' | 'none'

export function resolveLocalProgressiveBackpressureAction(options: {
  sampleRate: number
  decodedFrames: number
  consumedFrames: number
  rendererReady: boolean
  stdoutPaused: boolean
  startupFrames: number
}): LocalProgressiveBackpressureAction {
  const sampleRate = Math.max(1, Math.floor(options.sampleRate))
  const bufferedAheadFrames = Math.max(0, options.decodedFrames - options.consumedFrames)
  const pauseThresholdFrames = options.rendererReady
    ? Math.max(1, Math.floor(sampleRate * LOCAL_PROGRESSIVE_MAX_BUFFERED_SECONDS))
    : Math.max(1, Math.floor(options.startupFrames))
  const resumeThresholdFrames = Math.max(
    1,
    Math.floor(sampleRate * LOCAL_PROGRESSIVE_RESUME_BUFFERED_SECONDS)
  )

  if (!options.stdoutPaused && bufferedAheadFrames >= pauseThresholdFrames) {
    return 'pause'
  }
  if (options.stdoutPaused && options.rendererReady && bufferedAheadFrames <= resumeThresholdFrames) {
    return 'resume'
  }
  return 'none'
}
