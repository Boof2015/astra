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
