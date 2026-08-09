export type LocalPcmChunkConsumer = (chunk: Buffer) => void

/**
 * Holds FFmpeg stdout only until FFprobe has supplied the authoritative
 * channel count. Once released, later chunks pass straight through to the
 * existing PCM assembler. Its caller supplies a small cap below the decoder's
 * total PCM limit so a slow or failed probe cannot create an unbounded side
 * queue or duplicate an entire decoded track in main-process memory.
 */
export class LocalPcmProbeChunkGate {
  private readonly maxPendingBytes: number
  private pendingChunks: Buffer[] = []
  private pendingBytes = 0
  private released = false

  constructor(maxPendingBytes: number) {
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
      throw new RangeError('Local PCM probe chunk gate requires a positive byte cap.')
    }
    this.maxPendingBytes = maxPendingBytes
  }

  get pendingByteLength(): number {
    return this.pendingBytes
  }

  get isReleased(): boolean {
    return this.released
  }

  accept(chunk: Buffer, consume: LocalPcmChunkConsumer): void {
    if (chunk.byteLength === 0) return
    if (this.released) {
      consume(chunk)
      return
    }

    const nextPendingBytes = this.pendingBytes + chunk.byteLength
    if (
      !Number.isSafeInteger(nextPendingBytes)
      || nextPendingBytes > this.maxPendingBytes
    ) {
      throw new RangeError('Decoded audio exceeded the Standard playback limit before probing completed.')
    }
    this.pendingChunks.push(chunk)
    this.pendingBytes = nextPendingBytes
  }

  release(consume: LocalPcmChunkConsumer): void {
    if (this.released) return
    this.released = true
    const chunks = this.pendingChunks
    this.pendingChunks = []
    this.pendingBytes = 0
    for (const chunk of chunks) consume(chunk)
  }

  clear(): void {
    this.pendingChunks = []
    this.pendingBytes = 0
  }
}
