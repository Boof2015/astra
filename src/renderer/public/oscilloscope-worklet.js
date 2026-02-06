// AudioWorklet processor for continuous audio capture
// This runs in a separate audio thread and captures samples in real-time
// Feeds samples to native C++ visualizers via main thread

class OscilloscopeProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const leftChannel = input[0]
    const rightChannel = input.length > 1 ? input[1] : input[0]

    if (!leftChannel || leftChannel.length === 0) return true

    this.port.postMessage({
      left: leftChannel.slice(),
      right: rightChannel.slice()
    })

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
