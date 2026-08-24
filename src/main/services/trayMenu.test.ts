import assert from 'node:assert/strict'
import test from 'node:test'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer.ts'
import type { PhoneRemoteStatus } from '../../types/phoneRemote.ts'
import { buildTrayMenuModel } from './trayMenu.ts'

function createSnapshot(overrides: Partial<MiniPlayerSnapshot> = {}): MiniPlayerSnapshot {
  return {
    playbackState: 'playing',
    currentTime: 10,
    duration: 180,
    queueLength: 2,
    shuffle: true,
    repeat: 'all',
    outputDeviceLabel: 'Speakers',
    currentTrack: {
      id: 'track-1',
      path: '/music/track.flac',
      title: 'Blue Hour',
      artist: 'Astra',
      album: 'Orbit',
      isFavorite: true,
    },
    timeDisplayMode: 'remaining',
    visualizerLineColor: '#0097ff',
    ...overrides,
  }
}

function createPhoneStatus(overrides: Partial<PhoneRemoteStatus> = {}): PhoneRemoteStatus {
  return {
    enabled: true,
    controlsEnabled: true,
    bindHost: '0.0.0.0',
    port: 38402,
    lanUrls: ['https://192.168.1.2:38402'],
    controllerUrl: null,
    active: true,
    connectedClients: 1,
    pairedDeviceCount: 2,
    pendingPairingCount: 0,
    lastError: null,
    identity: { endpointUuid: 'test', desktopName: 'Desktop', protocolVersion: 3 },
    sync: {
      enabled: true,
      requestedAt: null,
      lastSyncedAt: null,
      conflicts: [],
      pendingResolutions: [],
    },
    ...overrides,
  }
}

test('tray menu model reflects active playback and renderer controls', () => {
  const model = buildTrayMenuModel({
    mainWindowVisible: false,
    miniPlayerOpen: true,
    rendererReady: true,
    snapshot: createSnapshot(),
    phoneRemoteStatus: createPhoneStatus(),
    rendererState: {
      sleepTimerExpiresAtMs: 130_000,
      globalHotkeysSuspended: true,
      configuredGlobalHotkeyCount: 2,
    },
    nowMs: 10_000,
  })

  assert.equal(model.nowPlayingLabel, 'Astra — Blue Hour · Astra')
  assert.equal(model.mainWindowActionLabel, 'Open Astra')
  assert.equal(model.playbackToggleLabel, 'Pause')
  assert.equal(model.favoriteChecked, true)
  assert.equal(model.shuffleChecked, true)
  assert.equal(model.repeatLabel, 'Repeat: All')
  assert.equal(model.sleepTimerLabel, 'Sleep Timer: 2 min')
  assert.equal(model.miniPlayerOpen, true)
  assert.equal(model.phoneRemoteLabel, 'Phone Remote · 1 connected')
  assert.equal(model.phoneRemoteCanSyncNow, true)
  assert.equal(model.hotkeysPaused, true)
  assert.equal(model.hotkeysCanPause, true)
})

test('tray menu model disables renderer actions when playback state is unavailable', () => {
  const model = buildTrayMenuModel({
    mainWindowVisible: true,
    miniPlayerOpen: false,
    rendererReady: false,
    snapshot: null,
    phoneRemoteStatus: createPhoneStatus({ enabled: false, active: false, connectedClients: 0 }),
    rendererState: {
      sleepTimerExpiresAtMs: null,
      globalHotkeysSuspended: false,
      configuredGlobalHotkeyCount: 0,
    },
    nowMs: 10_000,
  })

  assert.equal(model.nowPlayingLabel, 'Astra — Nothing Playing')
  assert.equal(model.mainWindowActionLabel, 'Hide Astra')
  assert.equal(model.playbackEnabled, false)
  assert.equal(model.sleepTimerCanStart, false)
  assert.equal(model.miniPlayerEnabled, false)
  assert.equal(model.phoneRemoteLabel, 'Phone Remote · Off')
  assert.equal(model.hotkeysCanPause, false)
})

test('tray menu model exposes phone conflicts and errors', () => {
  const phoneStatus = createPhoneStatus({
    lastError: 'Port unavailable',
    sync: {
      enabled: true,
      requestedAt: null,
      lastSyncedAt: null,
      conflicts: [{
        syncUid: 'conflict-1',
        kind: 'concurrent-edit',
        name: 'Road Trip',
        playlistKind: 'normal',
        phoneName: 'Road Trip Mobile',
        desktopName: 'Road Trip Desktop',
        phoneUpdatedAt: 2,
        desktopUpdatedAt: 1,
        phoneTrackCount: 4,
        desktopTrackCount: 3,
      }],
      pendingResolutions: [],
    },
  })
  const model = buildTrayMenuModel({
    mainWindowVisible: true,
    miniPlayerOpen: false,
    rendererReady: true,
    snapshot: createSnapshot({ playbackState: 'paused' }),
    phoneRemoteStatus: phoneStatus,
    rendererState: {
      sleepTimerExpiresAtMs: null,
      globalHotkeysSuspended: false,
      configuredGlobalHotkeyCount: 1,
    },
    nowMs: 10_000,
  })

  assert.equal(model.playbackToggleLabel, 'Play')
  assert.equal(model.phoneRemoteLabel, 'Phone Remote · Error')
  assert.equal(model.phoneRemoteStatusLabel, 'Error: Port unavailable')
  assert.equal(model.phoneRemoteConflictCount, 1)
})
