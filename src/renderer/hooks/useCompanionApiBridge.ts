import { useEffect } from 'react'
import type { CompanionApiRendererCommand } from '../../types/companionApi'
import { useLibraryStore } from '../stores/libraryStore'
import { usePlayerStore } from '../stores/playerStore'
import { usePlaylistStore } from '../stores/playlistStore'
import { useUIStore } from '../stores/uiStore'

async function applyPlaybackAction(
  action: Extract<CompanionApiRendererCommand, { type: 'playback-action' }>['action']
): Promise<void> {
  const player = usePlayerStore.getState()
  switch (action.action) {
    case 'play':
      await player.play()
      return
    case 'pause':
      player.pause()
      return
    case 'stop':
      player.stop()
      return
    case 'next':
      await player.playNext()
      return
    case 'previous':
      await player.playPrevious()
      return
    case 'seek':
      await player.seek(Math.max(0, Math.min(player.duration, action.positionSeconds)))
      return
    case 'set-volume':
      player.setVolume(action.volume)
      return
    case 'set-muted':
      if (player.isMuted !== action.muted) player.toggleMute()
      return
    case 'set-shuffle':
      if (player.shuffle !== action.enabled) player.toggleShuffle()
      return
    case 'set-repeat': {
      for (let attempt = 0; attempt < 3 && usePlayerStore.getState().repeat !== action.mode; attempt += 1) {
        usePlayerStore.getState().toggleRepeat()
      }
      return
    }
  }
}

async function openTarget(
  target: Extract<CompanionApiRendererCommand, { type: 'open-target' }>['target']
): Promise<void> {
  const ui = useUIStore.getState()
  const library = useLibraryStore.getState()
  if (target.type === 'track') {
    library.setViewMode('tracks')
    await library.clearSelection()
    ui.requestLibraryTrackReveal(target.trackPath)
    ui.setActiveView('library')
    return
  }
  if (target.type === 'album') {
    await library.selectAlbum(target.album, target.artist || undefined, 'library', target.identityKey)
    ui.setActiveView('library')
    return
  }
  if (target.type === 'artist') {
    await library.selectArtist(target.artist, 'library')
    ui.setActiveView('library')
    return
  }
  await usePlaylistStore.getState().selectPlaylist(target.playlistId)
  ui.setActiveView('playlist')
}

export async function executeCompanionApiRendererCommand(command: CompanionApiRendererCommand): Promise<void> {
  const player = usePlayerStore.getState()
  switch (command.type) {
    case 'playback-action':
      await applyPlaybackAction(command.action)
      return
    case 'open-target':
      await openTarget(command.target)
      return
    case 'play-paths':
      await player.startPlaybackContextByPaths(command.trackPaths, 0, {
        contextLabel: command.contextLabel
      })
      return
    case 'enqueue-paths':
      await player.enqueueTrackPaths(command.trackPaths, command.position)
      return
    case 'move-queue-item':
      player.moveUpcomingItem(command.queueItemId, command.position)
      return
    case 'remove-queue-item':
      player.removeUpcomingItem(command.queueItemId)
      return
    case 'clear-upcoming-queue':
      player.clearAllQueues()
      return
  }
}

export function useCompanionApiBridge(): void {
  useEffect(() => {
    return window.electronAPI.companionApi.onCommand((command) => {
      void executeCompanionApiRendererCommand(command).catch((error) => {
        console.error('Companion API command failed', error)
      })
    })
  }, [])
}
