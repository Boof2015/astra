import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NativeProgressiveInput } from '../types/nativeProgressive'

const MAX_CHUNK_BYTES = 256 * 1024
const MAX_STDERR_BYTES = 8192

export interface NativePcmDecoderOptions {
  command: string
  args: string[]
  input: NativeProgressiveInput
  signal?: AbortSignal
  startupFrames?: number
  idleTimeoutMs?: number
  /** Confirm encoded-cache completion/validation before declaring decoded EOF. */
  validateEof?: () => Promise<void>
  onFailure?: (error: Error) => void
  spawnDecoder?: (command: string, args: string[]) => ChildProcessWithoutNullStreams
}

export interface NativePcmDecoder {
  ready: Promise<void>
  done: Promise<void>
  cancel: () => void
  readonly pid: number | undefined
  /** JS pending PCM only; native ring and readable pipe have separate bounds. */
  readonly pendingBytes: number
}

function abortError(): Error {
  const error = new Error('Native decoder was cancelled.')
  error.name = 'AbortError'
  return error
}

/** Bounded source PCM transport. Decode/sample-format selection is the caller's
 * responsibility; this layer never resamples, converts samples, or starts output. */
export function startNativePcmDecoder(options: NativePcmDecoderOptions): NativePcmDecoder {
  const { input } = options
  const initial = input.status()
  const stride = initial.bytesPerFrame
  const startupFrames = options.startupFrames ?? Math.ceil(initial.sampleRate * 0.75)
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000
  if (initial.state !== 'open' || initial.publishedFrame !== initial.startFrame
    || !Number.isSafeInteger(stride) || stride < 1 || stride > 32
    || !Number.isSafeInteger(startupFrames) || startupFrames < 1 || startupFrames > initial.capacityFrames
    || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error('Invalid native decoder input or buffering limits.')
  }
  if (options.signal?.aborted) { input.cancel(); throw abortError() }
  const child = (options.spawnDecoder ?? ((command, args) => spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })))(options.command, options.args)
  child.stdin.end()
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  let readySettled = false
  let failure: Error | null = null
  let settled = false
  let pendingBytes = 0
  let stderr = Buffer.alloc(0)
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let rejectTermination!: (error: Error) => void
  const termination = new Promise<never>((_, reject) => { rejectTermination = reject })
  void termination.catch(() => {})
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const stop = (error: Error, cancelInput = false): void => {
    if (cancelInput) input.cancel()
    if (settled || failure) return
    failure = error
    rejectTermination(error)
    if (!readySettled) { readySettled = true; rejectReady(error) }
    child.stdout.destroy(error)
    child.kill('SIGTERM')
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1000)
    killTimer.unref?.()
  }
  const cancel = (): void => stop(abortError(), true)
  const onAbort = (): void => cancel()
  const onChildError = (error: Error): void => stop(error)
  child.on('error', onChildError)
  child.stdout.on('error', onChildError)
  child.stderr.on('error', onChildError)
  child.stderr.on('data', (chunk: Buffer) => {
    const suffix = chunk.subarray(Math.max(0, chunk.length - MAX_STDERR_BYTES))
    stderr = Buffer.concat([stderr, suffix]).subarray(-MAX_STDERR_BYTES)
  })
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const monitor = setInterval(() => {
    if (input.status().state === 'cancelled') cancel()
  }, 20)
  monitor.unref?.()
  const checkReady = (): void => {
    if (!readySettled && input.status().publishedFrame - initial.startFrame >= startupFrames) {
      readySettled = true
      resolveReady()
    }
  }
  const assertActive = (): void => {
    if (input.status().state === 'cancelled' && !failure) cancel()
    if (failure) throw failure
  }
  const done = (async () => {
    let remainder = Buffer.alloc(0)
    try {
      const iterator = child.stdout[Symbol.asyncIterator]()
      while (true) {
        assertActive()
        // Decoding can legitimately remain backpressured for a long pause. Only
        // time waiting for decoder bytes is subject to the inactivity timeout.
        idleTimer = setTimeout(() => stop(new Error('Native decoder stopped producing audio.')), idleTimeoutMs)
        const result = await iterator.next()
        clearTimeout(idleTimer)
        idleTimer = undefined
        assertActive()
        if (result.done) break
        const chunk = result.value as Buffer
        if (chunk.length > MAX_CHUNK_BYTES) throw new Error('Native decoder exceeded its PCM chunk limit.')
        const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk
        const aligned = bytes.length - bytes.length % stride
        let offset = 0
        pendingBytes = bytes.length
        while (offset < aligned) {
          assertActive()
          const accepted = input.append(bytes.subarray(offset, aligned))
          if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted * stride > aligned - offset) {
            throw new Error('Native input returned an invalid accepted frame count.')
          }
          offset += accepted * stride
          pendingBytes = bytes.length - offset
          checkReady()
          if (offset < aligned) await new Promise<void>((resolve) => setTimeout(resolve, 10))
        }
        // Copy at most one incomplete frame, avoiding retention of a large chunk.
        remainder = Buffer.from(bytes.subarray(aligned))
        pendingBytes = remainder.length
      }
      idleTimer = setTimeout(() => stop(new Error('Native decoder did not finish.')), idleTimeoutMs)
      const exit = await closed
      clearTimeout(idleTimer)
      idleTimer = undefined
      assertActive()
      if (exit.code !== 0) throw new Error(stderr.toString().trim() || `Native decoder exited (${exit.signal ?? exit.code}).`)
      if (remainder.length) throw new Error('Native decoder ended with an incomplete PCM frame.')
      if (input.status().publishedFrame === initial.startFrame) throw new Error('Native decoder produced no audio frames.')
      await Promise.race([options.validateEof?.(), termination])
      assertActive()
      if (!input.finish()) throw abortError()
      if (!readySettled) { readySettled = true; resolveReady() } // Successful short track.
    } catch (error) {
      const reported = failure ?? (error instanceof Error ? error : new Error(String(error)))
      stop(reported)
      await closed
      if (reported.name !== 'AbortError') options.onFailure?.(reported)
      throw reported
    } finally {
      settled = true
      pendingBytes = 0
      clearInterval(monitor)
      clearTimeout(idleTimer)
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      child.removeListener('error', onChildError)
      child.stdout.removeListener('error', onChildError)
      child.stderr.removeListener('error', onChildError)
    }
  })()
  void done.catch(() => {})
  if (options.signal?.aborted) cancel()
  return { ready, done, cancel, get pid() { return child.pid }, get pendingBytes() { return pendingBytes } }
}
