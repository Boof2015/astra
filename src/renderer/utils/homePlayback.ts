import type { PlaybackSourceContext } from '../../types/playbackSource'
import { playbackSourceKey } from '../../shared/home/playbackSources'

export interface HomePlaybackContext {
  currentSource: PlaybackSourceContext | null
  currentTrackPath: string | null
}

export function isHomePlaybackTargetActive(target: PlaybackSourceContext, context: HomePlaybackContext): boolean {
  if (target.type === 'track') return target.trackPath === context.currentTrackPath
  return context.currentSource !== null && playbackSourceKey(target) === playbackSourceKey(context.currentSource)
}

/** Resolve before fetching a new collection so resuming never replaces the queue. */
export async function activateHomePlayback(
  target: PlaybackSourceContext,
  context: HomePlaybackContext,
  actions: { toggle: () => Promise<void>; start: () => Promise<void> }
): Promise<void> {
  if (isHomePlaybackTargetActive(target, context)) await actions.toggle()
  else await actions.start()
}
