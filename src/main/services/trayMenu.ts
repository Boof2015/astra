import type { TrayRendererState } from '../../types/desktopIntegration'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer'
import type { PhoneRemoteStatus } from '../../types/phoneRemote'

const MAX_NOW_PLAYING_LABEL_LENGTH = 72

export interface TrayMenuState {
  mainWindowVisible: boolean
  miniPlayerOpen: boolean
  rendererReady: boolean
  snapshot: MiniPlayerSnapshot | null
  phoneRemoteStatus: PhoneRemoteStatus
  rendererState: TrayRendererState
  nowMs: number
}

export interface TrayMenuModel {
  rendererReady: boolean
  tooltip: string
  nowPlayingLabel: string
  hasCurrentTrack: boolean
  mainWindowActionLabel: 'Open Astra' | 'Hide Astra'
  playbackEnabled: boolean
  playbackToggleLabel: 'Play' | 'Pause'
  favoriteChecked: boolean
  shuffleChecked: boolean
  repeatLabel: string
  sleepTimerLabel: string
  sleepTimerActive: boolean
  sleepTimerCanStart: boolean
  miniPlayerOpen: boolean
  miniPlayerEnabled: boolean
  phoneRemoteLabel: string
  phoneRemoteStatusLabel: string
  phoneRemoteEnabled: boolean
  phoneRemoteSyncEnabled: boolean
  phoneRemoteCanSyncNow: boolean
  phoneRemoteConflictCount: number
  hotkeysPaused: boolean
  hotkeysCanPause: boolean
}

function truncateLabel(value: string, maxLength = MAX_NOW_PLAYING_LABEL_LENGTH): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function formatNowPlaying(snapshot: MiniPlayerSnapshot | null): {
  label: string
  tooltip: string
  hasTrack: boolean
} {
  const track = snapshot?.currentTrack
  if (!track) {
    return {
      label: 'Astra — Nothing Playing',
      tooltip: 'Astra',
      hasTrack: false,
    }
  }

  const title = track.title.trim() || 'Unknown Track'
  const artist = track.artist.trim()
  const description = artist ? `${title} · ${artist}` : title
  return {
    label: truncateLabel(`Astra — ${description}`),
    tooltip: `Astra — ${description}`,
    hasTrack: true,
  }
}

function formatSleepTimer(expiresAtMs: number | null, nowMs: number): {
  label: string
  active: boolean
} {
  if (expiresAtMs === null || expiresAtMs <= nowMs) {
    return { label: 'Sleep Timer: Off', active: false }
  }
  const minutes = Math.max(1, Math.ceil((expiresAtMs - nowMs) / 60_000))
  return { label: `Sleep Timer: ${minutes} min`, active: true }
}

function formatPhoneRemoteLabel(status: PhoneRemoteStatus): string {
  if (status.lastError) return 'Phone Remote · Error'
  if (!status.enabled) return 'Phone Remote · Off'
  if (status.connectedClients > 0) {
    return `Phone Remote · ${status.connectedClients} connected`
  }
  return 'Phone Remote · On'
}

function formatPhoneRemoteStatus(status: PhoneRemoteStatus): string {
  if (status.lastError) return truncateLabel(`Error: ${status.lastError}`)
  if (!status.enabled) return 'Remote hosting is off'
  const paired = `${status.pairedDeviceCount} paired`
  const connected = `${status.connectedClients} connected`
  return `${connected} · ${paired}`
}

export function buildTrayMenuModel(state: TrayMenuState): TrayMenuModel {
  const nowPlaying = formatNowPlaying(state.snapshot)
  const sleepTimer = formatSleepTimer(state.rendererState.sleepTimerExpiresAtMs, state.nowMs)
  const playbackEnabled = state.rendererReady && nowPlaying.hasTrack
  const playbackState = state.snapshot?.playbackState

  return {
    rendererReady: state.rendererReady,
    tooltip: nowPlaying.tooltip,
    nowPlayingLabel: nowPlaying.label,
    hasCurrentTrack: nowPlaying.hasTrack,
    mainWindowActionLabel: state.mainWindowVisible ? 'Hide Astra' : 'Open Astra',
    playbackEnabled,
    playbackToggleLabel: playbackState === 'playing' || playbackState === 'loading' ? 'Pause' : 'Play',
    favoriteChecked: state.snapshot?.currentTrack?.isFavorite === true,
    shuffleChecked: state.snapshot?.shuffle === true,
    repeatLabel: `Repeat: ${state.snapshot?.repeat === 'one' ? 'One' : state.snapshot?.repeat === 'all' ? 'All' : 'Off'}`,
    sleepTimerLabel: sleepTimer.label,
    sleepTimerActive: sleepTimer.active,
    sleepTimerCanStart: playbackEnabled && (playbackState === 'playing' || playbackState === 'paused'),
    miniPlayerOpen: state.miniPlayerOpen,
    miniPlayerEnabled: state.rendererReady,
    phoneRemoteLabel: formatPhoneRemoteLabel(state.phoneRemoteStatus),
    phoneRemoteStatusLabel: formatPhoneRemoteStatus(state.phoneRemoteStatus),
    phoneRemoteEnabled: state.phoneRemoteStatus.enabled,
    phoneRemoteSyncEnabled: state.phoneRemoteStatus.sync.enabled,
    phoneRemoteCanSyncNow: state.phoneRemoteStatus.active
      && state.phoneRemoteStatus.sync.enabled
      && state.phoneRemoteStatus.pairedDeviceCount > 0,
    phoneRemoteConflictCount: state.phoneRemoteStatus.sync.conflicts.length,
    hotkeysPaused: state.rendererState.globalHotkeysSuspended,
    hotkeysCanPause: state.rendererReady && state.rendererState.configuredGlobalHotkeyCount > 0,
  }
}

export function createTrayMenuStateKey(model: TrayMenuModel): string {
  return JSON.stringify(model)
}
