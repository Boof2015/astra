// AudioWorklet processor for continuous audio capture
// This runs in a separate audio thread and captures samples in real-time
// Feeds samples to native C++ visualizers via main thread

class OscilloscopeProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    // Get stereo channels (or mono if only one channel)
    const leftChannel = input[0]
    const rightChannel = input.length > 1 ? input[1] : input[0]

    if (!leftChannel || leftChannel.length === 0) return true

    // Send stereo audio samples to main thread for native C++ processing
    // Main thread will:
    // - Feed left channel to oscilloscope
    // - Feed stereo to vectorscope
    // - Feed mono sum to spectrum analyzer
    this.port.postMessage({
      left: leftChannel.slice(),  // Copy to avoid race conditions
      right: rightChannel.slice()
    })

    // Pass audio through unchanged
    const output = outputs[0]
    if (output && output.length > 0) {
      for (let channel = 0; channel < Math.min(input.length, output.length); channel++) {
        output[channel].set(input[channel])
      }
    }

    return true // Keep processor alive
  }
}

registerProcessor('oscilloscope-processor', OscilloscopeProcessor)
