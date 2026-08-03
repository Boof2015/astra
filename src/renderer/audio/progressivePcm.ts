// Local progressive playback switches to 65,536-frame chunks after startup.
// Keep the smaller startup chunks interleaved to minimize time-to-first-audio,
// then pay deinterleaving once on the renderer thread so every 128-frame audio
// callback can use typed-array copies instead of sample-by-sample indexing.
export const LOCAL_PROGRESSIVE_PLANAR_MIN_FRAMES = 16_384

export function shouldUsePlanarLocalProgressiveChunk(frameCount: number): boolean {
  return Number.isFinite(frameCount)
    && Math.floor(frameCount) >= LOCAL_PROGRESSIVE_PLANAR_MIN_FRAMES
}

export function deinterleaveProgressivePcm(
  interleaved: Float32Array,
  channelCount: number,
  frameCount: number,
): Float32Array[] {
  const channels = Math.max(1, Math.floor(channelCount))
  const frames = Math.max(0, Math.floor(frameCount))
  const channelData = Array.from({ length: channels }, () => new Float32Array(frames))

  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channel = channelData[channelIndex]
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      channel[frameIndex] = interleaved[(frameIndex * channels) + channelIndex] ?? 0
    }
  }

  return channelData
}
