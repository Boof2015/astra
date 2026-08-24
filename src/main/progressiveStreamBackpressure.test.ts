import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_PROGRESSIVE_MAX_BUFFERED_SECONDS,
  LOCAL_PROGRESSIVE_RESUME_BUFFERED_SECONDS,
  resolveLocalProgressiveBackpressureAction,
} from './progressiveStreamBackpressure.ts'

const sampleRate = 48_000
const startupFrames = 8192

test('local progressive producer pauses after the startup chunk until the renderer is ready', () => {
  assert.equal(resolveLocalProgressiveBackpressureAction({
    sampleRate,
    decodedFrames: startupFrames,
    consumedFrames: 0,
    rendererReady: false,
    stdoutPaused: false,
    startupFrames,
  }), 'pause')

  assert.equal(resolveLocalProgressiveBackpressureAction({
    sampleRate,
    decodedFrames: startupFrames,
    consumedFrames: 0,
    rendererReady: true,
    stdoutPaused: true,
    startupFrames,
  }), 'resume')
})

test('local progressive producer maintains a bounded ahead-of-playback window', () => {
  assert.equal(resolveLocalProgressiveBackpressureAction({
    sampleRate,
    decodedFrames: sampleRate * LOCAL_PROGRESSIVE_MAX_BUFFERED_SECONDS,
    consumedFrames: 0,
    rendererReady: true,
    stdoutPaused: false,
    startupFrames,
  }), 'pause')

  assert.equal(resolveLocalProgressiveBackpressureAction({
    sampleRate,
    decodedFrames: sampleRate * LOCAL_PROGRESSIVE_MAX_BUFFERED_SECONDS,
    consumedFrames: sampleRate * LOCAL_PROGRESSIVE_RESUME_BUFFERED_SECONDS,
    rendererReady: true,
    stdoutPaused: true,
    startupFrames,
  }), 'resume')

  assert.equal(resolveLocalProgressiveBackpressureAction({
    sampleRate,
    decodedFrames: sampleRate * LOCAL_PROGRESSIVE_MAX_BUFFERED_SECONDS,
    consumedFrames: sampleRate * 10,
    rendererReady: true,
    stdoutPaused: true,
    startupFrames,
  }), 'none')
})
