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

    const channels = input.map((channel) => channel.slice())
    const leftChannel = channels[0]

    if (!leftChannel || leftChannel.length === 0) return true

    if (this.visualizerStreamingEnabled) {
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
          this.appendChunk(payload.channelData, payload.frameCount)
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

  appendChunk(channelData, frameCount) {
    if (!Array.isArray(channelData) || frameCount <= 0) return
    this.chunks.push({
      startFrame: this.totalFrames,
      frameCount,
      channels: channelData
    })
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
      for (let channel = 0; channel < output.length; channel++) {
        const sourceChannel = chunk.channels[channel] || chunk.channels[0]
        if (!sourceChannel) continue
        output[channel].set(sourceChannel.subarray(chunkOffset, chunkOffset + framesToCopy), outputOffset)
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
