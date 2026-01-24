// AudioWorklet processor for continuous audio capture
// This runs in a separate audio thread and captures samples in real-time

class OscilloscopeProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array
  private writePos: number = 0
  private readonly bufferSize: number = 32768 // Same as pulse-visualizer

  constructor() {
    super()
    this.buffer = new Float32Array(this.bufferSize)

    // Handle messages from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'getBuffer') {
        // Send current buffer state back
        this.port.postMessage({
          type: 'buffer',
          buffer: this.buffer.slice(), // Copy to avoid race conditions
          writePos: this.writePos
        })
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    // Use left channel (mono) for oscilloscope
    const samples = input[0]
    if (!samples || samples.length === 0) return true

    // Write samples to circular buffer
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i]
      this.writePos = (this.writePos + 1) % this.bufferSize
    }

    // Send update to main thread periodically (every 128 samples = ~2.6ms at 48kHz)
    // This is called automatically since process() is called every 128 samples
    this.port.postMessage({
      type: 'samples',
      samples: samples.slice(),
      writePos: this.writePos
    })

    return true // Keep processor alive
  }
}

registerProcessor('oscilloscope-processor', OscilloscopeProcessor)
