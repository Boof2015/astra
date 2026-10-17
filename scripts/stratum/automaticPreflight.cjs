// Wall-clock paced silent consumer using the real worklet. No Electron/audio API.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

exports.automaticPreflight = async function automaticPreflight(directory, connection, ffmpeg) {
  const { mainHarness } = require(path.join(directory, 'harness.cjs'))
  let Processor, outputFrame = 0, sessionId = 0, ended = false, buffering = 0, lastReported = 0
  const markers = [], played = []
  let currentQuality
  runInNewContext(fs.readFileSync(path.join(directory, 'oscilloscope-worklet.js'), 'utf8'), {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => {} } },
    registerProcessor: (name, value) => { if (name === 'remote-stream-player') Processor = value },
    Float32Array, sampleRate: 44100, get currentFrame() { return outputFrame }
  })
  const worklet = new Processor({ outputChannelCount: [2], processorOptions: { discardConsumedChunks: true } })
  const send = data => worklet.port.onmessage({ data })
  const chunk = value => {
    markers.push(...(value.qualityChanges || []))
    send({ type: 'append-chunk', sessionId: value.sessionId, frameCount: value.frameCount,
      interleavedData: new Float32Array(value.pcmData), channelCount: 2 })
  }
  const h = mainHarness(connection, ffmpeg, { recordPcm: false, deliver: (channel, value) => {
    if (channel === 'audio:progressiveStreamChunk') chunk(value)
    if (channel === 'audio:progressiveStreamEvent' && value.type === 'complete') send({ type: 'set-source-ended', sessionId: value.sessionId, ended: true })
  } })
  worklet.port.postMessage = value => {
    if (value.type === 'ended') ended = true
    if (value.type === 'buffering' && value.buffering) buffering++
    if (value.type === 'position' && value.sessionId === sessionId) {
      if (value.frame - lastReported >= 22050 || !value.frame) { lastReported = value.frame; h.position(sessionId, value.frame) }
      while (markers.length && markers[0].frame <= value.frame) {
        const marker = markers.shift()
        if (currentQuality !== marker.quality.requested) {
          currentQuality = marker.quality.requested
          played.push({ seconds: marker.frame / 44100, quality: currentQuality })
        }
      }
    }
  }
  const report = error => fs.writeFileSync(path.join(directory, 'silent-report.json'), JSON.stringify({
    scenario: 'automatic', buffering, played, outputFrames: worklet.currentFrame,
    sessions: h.events.filter(event => event.type === 'complete' || event.type === 'failed'),
    ...(error ? { error: error.message } : {})
  }, null, 2))
  try {
    const info = await h.start('first', 44100, 'automatic')
    sessionId = info.sessionId
    send({ type: 'set-session', sessionId })
    chunk(info.initialChunk)
    h.position(sessionId, 0)
    const deadline = performance.now() + 125000
    while (worklet.totalFrames < 44100 * .75) { assert.ok(performance.now() < deadline); await delay(10) }
    send({ type: 'set-playing', playing: true })
    const began = performance.now()
    while (!ended) {
      assert.ok(performance.now() < deadline, 'Silent playback exceeded its deadline.')
      assert.ok(!h.events.some(event => event.type === 'failed'), 'Silent stream failed.')
      const due = Math.floor((performance.now() - began) * 44.1)
      while (outputFrame < due && !ended) {
        const frames = Math.min(512, due - outputFrame)
        worklet.process([], [[new Float32Array(frames), new Float32Array(frames)]])
        outputFrame += frames
      }
      await delay(10)
    }
    report()
    assert.equal(buffering, 0, 'The silent test buffered; inspect its report before listening.')
    assert.equal(played[0]?.quality, 'original')
    assert.ok(played.some(value => typeof value.quality === 'number'), 'Automatic did not lower quality.')
    assert.equal(played.at(-1)?.quality, 'original', 'Automatic did not recover before the excerpt ended.')
    assert.equal(worklet.currentFrame, 100 * 44100)
    assert.equal(h.events.filter(event => event.type === 'started').length, 1)
    console.log('SILENT_AUTOMATIC_PASSED: real paced bytes, one session, automatic downgrade/recovery, no buffering.')
  } catch (error) { report(error); throw error }
  finally { await h.close() }
}
