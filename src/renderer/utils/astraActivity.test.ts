import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveAstraActivityEvent,
  resolveAstraActivityState,
  type AstraActivityEventFlags,
} from './astraActivity.ts'

const emptyEvents: AstraActivityEventFlags = {
  metadataSaving: false,
  externalConnected: false,
  attention: false,
}

test('activity resolver gives scan states priority over playback', () => {
  assert.equal(resolveAstraActivityState({
    playbackState: 'playing',
    isLibraryScanning: true,
    isRemoteSyncing: true,
  }), 'library-scan')

  assert.equal(resolveAstraActivityState({
    playbackState: 'playing',
    isIntegrityScanning: true,
    isLibraryScanning: true,
  }), 'integrity-scan')
})

test('activity resolver orders remote sync, loading, streaming, lookup, and playback', () => {
  assert.equal(resolveAstraActivityState({
    playbackState: 'loading',
    isRemoteSyncing: true,
    isRemoteStreaming: true,
  }), 'remote-sync')

  assert.equal(resolveAstraActivityState({
    playbackState: 'loading',
    isRemoteStreaming: true,
  }), 'loading-track')

  assert.equal(resolveAstraActivityState({
    playbackState: 'playing',
    isRemoteStreaming: true,
    isLyricsLookup: true,
  }), 'remote-streaming')

  assert.equal(resolveAstraActivityState({
    playbackState: 'playing',
    isLyricsLookup: true,
  }), 'lyrics-lookup')

  assert.equal(resolveAstraActivityState({
    playbackState: 'playing',
    isInternetLookup: true,
  }), 'lyrics-lookup')
})

test('activity resolver falls back to playback and idle states', () => {
  assert.equal(resolveAstraActivityState({ playbackState: 'playing' }), 'playing')
  assert.equal(resolveAstraActivityState({ playbackState: 'paused' }), 'paused')
  assert.equal(resolveAstraActivityState({ playbackState: 'stopped' }), 'idle')
})

test('activity event resolver emits only rising edge events by priority', () => {
  assert.equal(resolveAstraActivityEvent({
    metadataSaving: true,
    externalConnected: true,
    attention: true,
  }, emptyEvents), 'attention')

  assert.equal(resolveAstraActivityEvent({
    metadataSaving: true,
    externalConnected: true,
    attention: false,
  }, emptyEvents), 'metadata-saving')

  assert.equal(resolveAstraActivityEvent({
    metadataSaving: false,
    externalConnected: true,
    attention: false,
  }, emptyEvents), 'external-connected')
})

test('activity event resolver suppresses persistent event flags', () => {
  assert.equal(resolveAstraActivityEvent({
    metadataSaving: true,
    externalConnected: false,
    attention: false,
  }, {
    metadataSaving: true,
    externalConnected: false,
    attention: false,
  }), null)
})
