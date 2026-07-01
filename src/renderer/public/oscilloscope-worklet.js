// AudioWorklet processors for real-time analysis and calibration capture.
// Both processors run in the audio render thread and stream sample blocks
// to the renderer main thread for downstream DSP.

class OscilloscopeProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.visualizerStreamingEnabled = false
    this.port.onmessage = (event) => {
      if (!event || typeof event.data !== 'object' || event.data == null) return
      if (event.data.type !== 'set-visualizer-streaming-enabled') return
      this.visualizerStreamingEnabled = Boolean(event.data.enabled)
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const leftChannel = input[0]

    if (!leftChannel || leftChannel.length === 0) return true

    if (this.visualizerStreamingEnabled) {
      const channels = input.map((channel) => channel.slice())
      this.port.postMessage({
        channels
      })
    }

    // Pass audio through unchanged
    const output = outputs[0]
    if (output && output.length > 0) {
      for (let channel = 0; channel < Math.min(input.length, output.length); channel++) {
        output[channel].set(input[channel])
      }
    }

    return true
  }
}

registerProcessor('oscilloscope-processor', OscilloscopeProcessor)

class RemoteStreamPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const outputChannels = options && options.outputChannelCount && Array.isArray(options.outputChannelCount)
      ? Number(options.outputChannelCount[0] || 2)
      : 2
    this.channelCount = Math.max(1, outputChannels)
    this.reportIntervalFrames = 2048
    this.reset()
    this.port.onmessage = (event) => {
      if (!event || typeof event.data !== 'object' || event.data == null) return
      const payload = event.data
      switch (payload.type) {
        case 'append-chunk':
          this.appendChunk(payload)
          break
        case 'set-playing':
          this.playing = Boolean(payload.playing)
          this.endedEmitted = false
          this.postPosition(true)
          break
        case 'seek':
          this.seekToFrame(payload.frame)
          break
        case 'set-source-ended':
          this.sourceEnded = Boolean(payload.ended)
          if (this.sourceEnded && this.currentFrame >= this.totalFrames && !this.endedEmitted) {
            this.emitEnded()
          }
          break
        case 'clear':
          this.reset()
          this.postPosition(true)
          break
      }
    }
  }

  reset() {
    this.chunks = []
    this.totalFrames = 0
    this.currentFrame = 0
    this.currentChunkIndex = 0
    this.playing = false
    this.sourceEnded = false
    this.endedEmitted = false
    this.framesSinceReport = 0
    this.lastReportedFrame = -1
  }

  appendChunk(payload) {
    const frameCount = Number(payload.frameCount)
    if (!Number.isFinite(frameCount) || frameCount <= 0) return

    const interleavedData = payload.interleavedData instanceof Float32Array
      ? payload.interleavedData
      : null
    const channelCount = Number.isFinite(payload.channelCount)
      ? Math.max(1, Math.floor(payload.channelCount))
      : this.channelCount
    const channelData = Array.isArray(payload.channelData) ? payload.channelData : null
    if (!interleavedData && !channelData) return

    this.chunks.push(interleavedData
      ? {
          startFrame: this.totalFrames,
          frameCount,
          interleaved: interleavedData,
          channelCount
        }
      : {
          startFrame: this.totalFrames,
          frameCount,
          channels: channelData
        }
    )
    this.totalFrames += frameCount
    if (this.currentChunkIndex >= this.chunks.length) {
      this.currentChunkIndex = Math.max(0, this.chunks.length - 1)
    }
  }

  seekToFrame(frame) {
    const clamped = Number.isFinite(frame)
      ? Math.max(0, Math.min(Math.floor(frame), this.totalFrames))
      : 0
    this.currentFrame = clamped
    this.endedEmitted = false
    this.framesSinceReport = 0
    this.locateCurrentChunk()
    this.postPosition(true)
  }

  locateCurrentChunk() {
    if (this.chunks.length === 0) {
      this.currentChunkIndex = 0
      return
    }

    let index = this.currentChunkIndex
    if (index < 0 || index >= this.chunks.length) {
      index = 0
    }

    while (index > 0 && this.currentFrame < this.chunks[index].startFrame) {
      index -= 1
    }

    while (
      index < this.chunks.length - 1
      && this.currentFrame >= (this.chunks[index].startFrame + this.chunks[index].frameCount)
    ) {
      index += 1
    }

    this.currentChunkIndex = index
  }

  postPosition(force = false) {
    if (!force && this.currentFrame === this.lastReportedFrame) return
    this.lastReportedFrame = this.currentFrame
    this.port.postMessage({
      type: 'position',
      frame: this.currentFrame,
      totalFrames: this.totalFrames
    })
  }

  emitEnded() {
    if (this.endedEmitted) return
    this.endedEmitted = true
    this.playing = false
    this.postPosition(true)
    this.port.postMessage({
      type: 'ended',
      frame: this.currentFrame,
      totalFrames: this.totalFrames
    })
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    for (let channel = 0; channel < output.length; channel++) {
      output[channel].fill(0)
    }

    if (!this.playing) {
      return true
    }

    let remainingFrames = output[0].length
    let outputOffset = 0

    while (remainingFrames > 0) {
      if (this.currentFrame >= this.totalFrames) {
        if (this.sourceEnded) {
          this.emitEnded()
        }
        break
      }

      this.locateCurrentChunk()
      const chunk = this.chunks[this.currentChunkIndex]
      if (!chunk) {
        break
      }

      const chunkOffset = this.currentFrame - chunk.startFrame
      if (chunkOffset < 0 || chunkOffset >= chunk.frameCount) {
        this.currentChunkIndex += 1
        continue
      }

      const availableFrames = chunk.frameCount - chunkOffset
      const framesToCopy = Math.min(remainingFrames, availableFrames)
      if (chunk.interleaved) {
        for (let channel = 0; channel < output.length; channel++) {
          const sourceChannelIndex = channel < chunk.channelCount ? channel : 0
          const target = output[channel]
          for (let frame = 0; frame < framesToCopy; frame++) {
            target[outputOffset + frame] = chunk.interleaved[((chunkOffset + frame) * chunk.channelCount) + sourceChannelIndex] || 0
          }
        }
      } else {
        for (let channel = 0; channel < output.length; channel++) {
          const sourceChannel = chunk.channels[channel] || chunk.channels[0]
          if (!sourceChannel) continue
          output[channel].set(sourceChannel.subarray(chunkOffset, chunkOffset + framesToCopy), outputOffset)
        }
      }

      this.currentFrame += framesToCopy
      this.framesSinceReport += framesToCopy
      outputOffset += framesToCopy
      remainingFrames -= framesToCopy

      if ((chunkOffset + framesToCopy) >= chunk.frameCount && this.currentChunkIndex < this.chunks.length - 1) {
        this.currentChunkIndex += 1
      }
    }

    if (this.framesSinceReport >= this.reportIntervalFrames) {
      this.framesSinceReport = 0
      this.postPosition()
    }

    if (this.sourceEnded && this.currentFrame >= this.totalFrames) {
      this.emitEnded()
    }

    return true
  }
}

registerProcessor('remote-stream-player', RemoteStreamPlayerProcessor)

class ParallaxSinkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const outputChannels = options && options.outputChannelCount && Array.isArray(options.outputChannelCount)
      ? Number(options.outputChannelCount[0] || 2)
      : 2
    const sourceSampleRate = Number(options && options.processorOptions && options.processorOptions.sourceSampleRate)
    this.channelCount = Math.max(1, outputChannels)
    this.sourceSampleRate = Number.isFinite(sourceSampleRate) && sourceSampleRate > 0 ? sourceSampleRate : sampleRate
    this.basePlaybackRate = this.sourceSampleRate / sampleRate
    this.reportIntervalFrames = 2048
    this.maxRetainedChunks = 512
    // Self-pause into "rebuffering" after this many consecutive starved output frames (~250 ms),
    // so a drained buffer can refill instead of free-running the cursor into empty data.
    // Keep ~in sync with PARALLAX_STARVE_TRIGGER_MS in src/types/parallax.ts.
    this.starveTriggerFrames = Math.max(1, Math.floor(0.25 * sampleRate))
    this.reset()
    this.port.onmessage = (event) => {
      if (!event || typeof event.data !== 'object' || event.data == null) return
      const payload = event.data
      switch (payload.type) {
        case 'append-chunk':
          this.appendChunk(payload.channelData, payload.startFrame, payload.frameCount)
          break
        case 'clear-buffer':
          this.clearBufferedChunks()
          break
        case 'set-timeline':
          this.setTimeline(payload)
          break
        case 'set-rate':
          this.playbackRate = this.rateFromPpm(payload.playbackRatePpm)
          break
        case 'clear':
          this.reset()
          this.postPosition(true)
          break
      }
    }
  }

  reset() {
    this.chunks = []
    this.currentFrame = 0
    this.currentFrameFloat = 0
    this.playing = false
    this.playbackRate = this.basePlaybackRate || 1
    this.startAtSample = 0
    this.framesSinceReport = 0
    this.lastReportedFrame = -1
    this.underruns = 0
    this.lastUnderrunReportFrame = -1
    this.starvedFrames = 0
    this.rebuffering = false
  }

  rateFromPpm(value) {
    // Keep in sync with PARALLAX_MAX_SLEW_PPM in src/types/parallax.ts.
    const ppm = Number.isFinite(value) ? Math.max(-1000, Math.min(1000, Number(value))) : 0
    return (this.basePlaybackRate || 1) * (1 + (ppm / 1000000))
  }

  appendChunk(channelData, startFrame, frameCount) {
    if (!Array.isArray(channelData) || frameCount <= 0 || !Number.isFinite(startFrame)) return
    this.chunks.push({
      startFrame: Math.max(0, Math.floor(startFrame)),
      frameCount: Math.max(0, Math.floor(frameCount)),
      channels: channelData
    })
    this.chunks.sort((left, right) => left.startFrame - right.startFrame)
    if (this.chunks.length > this.maxRetainedChunks) {
      this.chunks.splice(0, this.chunks.length - this.maxRetainedChunks)
    }
  }

  clearBufferedChunks() {
    this.chunks = []
    this.starvedFrames = 0
    this.rebuffering = false
  }

  setTimeline(payload) {
    const startFrame = Number.isFinite(payload.startFrame)
      ? Math.max(0, Math.floor(payload.startFrame))
      : Math.max(0, Math.floor(this.currentFrameFloat))
    const startAtContextTime = Number.isFinite(payload.startAtContextTime)
      ? Math.max(0, Number(payload.startAtContextTime))
      : currentTime
    this.currentFrame = startFrame
    this.currentFrameFloat = startFrame
    this.startAtSample = Math.max(currentFrame, Math.floor(startAtContextTime * sampleRate))
    this.playbackRate = this.rateFromPpm(payload.playbackRatePpm)
    this.playing = Boolean(payload.playing)
    this.framesSinceReport = 0
    // A fresh timeline is a clean (re-)anchor — leave any rebuffering state behind.
    this.starvedFrames = 0
    this.rebuffering = false
    this.postPosition(true)
  }

  findChunk(frame) {
    for (let index = 0; index < this.chunks.length; index++) {
      const chunk = this.chunks[index]
      if (frame < chunk.startFrame) return null
      if (frame < chunk.startFrame + chunk.frameCount) return chunk
    }
    return null
  }

  findNextChunk(frame) {
    for (let index = 0; index < this.chunks.length; index++) {
      const chunk = this.chunks[index]
      if (chunk.startFrame + chunk.frameCount <= frame) continue
      if (chunk.startFrame >= frame) return chunk
    }
    return null
  }

  sampleAt(channel, frame) {
    const chunk = this.findChunk(frame)
    if (!chunk) return null
    const offset = frame - chunk.startFrame
    const sourceChannel = chunk.channels[channel] || chunk.channels[0]
    if (!sourceChannel || offset < 0 || offset >= sourceChannel.length) return null
    return sourceChannel[offset] || 0
  }

  readInterpolated(channel, frameFloat) {
    const frame = Math.floor(frameFloat)
    const frac = frameFloat - frame
    const current = this.sampleAt(channel, frame)
    if (current === null) return null
    if (frac <= 0.000001) return current
    const next = this.sampleAt(channel, frame + 1)
    if (next === null) return current
    return current + ((next - current) * frac)
  }

  pruneOldChunks() {
    const retainAfterFrame = Math.max(0, Math.floor(this.currentFrameFloat) - this.sourceSampleRate)
    while (this.chunks.length > 0) {
      const chunk = this.chunks[0]
      if (chunk.startFrame + chunk.frameCount >= retainAfterFrame) break
      this.chunks.shift()
    }
  }

  postPosition(force = false, contextTimeOverride = null) {
    const frame = Math.max(0, Math.floor(this.currentFrameFloat))
    if (!force && frame === this.lastReportedFrame) return
    this.lastReportedFrame = frame
    const bufferedEndFrame = this.chunks.reduce((maxFrame, chunk) => {
      return Math.max(maxFrame, chunk.startFrame + chunk.frameCount)
    }, 0)
    // Processing-context time corresponding to the reported `frame`. The renderer maps this
    // through its own AudioContext.currentTime to derive the wall time the cursor was at `frame`,
    // so drift is computed at the report's actual instant — kills the 1 Hz / 46 ms aliasing.
    //
    // The reported `frame` is the cursor AFTER process() advanced through the quantum, so callers
    // inside process() pass end-of-block time (`currentTime + frameCount / sampleRate`). For force
    // calls from the port-message handler (setTimeline / clear) there's no in-progress block, so
    // the global `currentTime` (start of the next quantum) is the closest correct anchor.
    const reportContextTime = Number.isFinite(contextTimeOverride) ? contextTimeOverride : currentTime
    this.port.postMessage({
      type: 'position',
      frame,
      contextTime: reportContextTime,
      bufferedFrames: Math.max(0, bufferedEndFrame - frame),
      bufferedEndFrame,
      underruns: this.underruns,
      starvedFrames: this.starvedFrames,
      rebuffering: this.rebuffering,
      playbackRatePpm: Math.round(((this.playbackRate / (this.basePlaybackRate || 1)) - 1) * 1000000)
    })
  }

  reportUnderrun(frame) {
    this.underruns += 1
    if (this.lastUnderrunReportFrame >= 0 && frame - this.lastUnderrunReportFrame < this.sourceSampleRate / 4) return
    this.lastUnderrunReportFrame = frame
    this.port.postMessage({
      type: 'underrun',
      frame,
      underruns: this.underruns
    })
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    for (let channel = 0; channel < output.length; channel++) {
      output[channel].fill(0)
    }

    if (!this.playing) {
      // While rebuffering we are intentionally paused, but keep reporting so the renderer can see
      // the buffer refill (bufferedEndFrame) and decide when to re-anchor to the live host frame.
      if (this.rebuffering) {
        this.framesSinceReport += output[0].length
        if (this.framesSinceReport >= this.reportIntervalFrames) {
          this.framesSinceReport = 0
          // Cursor is frozen, but contextTime advances anyway — use end-of-this-block so the renderer
          // sees a fresh wall-time stamp on each idle report.
          this.postPosition(true, currentTime + output[0].length / sampleRate)
        }
      }
      return true
    }

    const frameCount = output[0].length
    // contextTime corresponding to the cursor's position at the END of this render quantum — the
    // moment the reported `frame` actually represents (cursor advances through the block before we
    // read currentFrameFloat in postPosition).
    const endOfBlockTime = currentTime + frameCount / sampleRate
    for (let outputFrame = 0; outputFrame < frameCount; outputFrame++) {
      if (currentFrame + outputFrame < this.startAtSample) {
        continue
      }

      const sourceFrame = Math.max(0, Math.floor(this.currentFrameFloat))
      let anyMissing = false
      let anyReadable = false
      for (let channel = 0; channel < output.length; channel++) {
        const sample = this.readInterpolated(channel, this.currentFrameFloat)
        if (sample === null) {
          anyMissing = true
          output[channel][outputFrame] = 0
        } else {
          anyReadable = true
          output[channel][outputFrame] = sample
        }
      }

      if (anyMissing) {
        this.reportUnderrun(sourceFrame)
      }

      if (!anyReadable) {
        const nextChunk = this.findNextChunk(sourceFrame)
        if (nextChunk && nextChunk.startFrame > sourceFrame) {
          // Data exists ahead (a gap, not a drained buffer): skip to it, not a starvation.
          this.currentFrameFloat = nextChunk.startFrame
          this.currentFrame = nextChunk.startFrame
          this.starvedFrames = 0
        } else {
          // Nothing buffered ahead: the cursor is frozen and we are truly starved.
          this.starvedFrames += 1
        }
        this.framesSinceReport += 1
        continue
      }

      this.starvedFrames = 0
      this.currentFrameFloat += this.playbackRate
      this.currentFrame = Math.floor(this.currentFrameFloat)
      this.framesSinceReport += 1
    }

    // Sustained starvation while connected: self-pause into rebuffering instead of free-running the
    // cursor into empty data. The renderer re-anchors to the live host frame once the buffer refills.
    if (this.playing && !this.rebuffering && this.starvedFrames >= this.starveTriggerFrames) {
      this.rebuffering = true
      this.playing = false
      this.framesSinceReport = 0
      this.postPosition(true, endOfBlockTime)
      return true
    }

    if (this.framesSinceReport >= this.reportIntervalFrames) {
      this.framesSinceReport = 0
      this.postPosition(false, endOfBlockTime)
      this.pruneOldChunks()
    }

    return true
  }
}

registerProcessor('parallax-sink-player', ParallaxSinkProcessor)

class CalibrationCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]

    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      this.port.postMessage({
        samples: input[0].slice()
      })
    }

    // Emit silence so the node can stay connected without monitoring the mic.
    if (output && output.length > 0) {
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].fill(0)
      }
    }

    return true
  }
}

registerProcessor('calibration-capture-processor', CalibrationCaptureProcessor)
