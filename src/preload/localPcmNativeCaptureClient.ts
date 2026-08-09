/// <reference types="electron-vite/node" />

import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createBundledLocalPcmNativeCaptureClient,
  type LocalPcmNativeCaptureCapabilities,
  type LocalPcmNativeCaptureClient,
  type LocalPcmNativeCaptureRequest,
  type LocalPcmNativeCaptureResult
} from '../main/localPcmNativeCaptureClient'
import { LOCAL_PCM_STREAM_MAX_BYTES } from '../shared/localPcmStream'

const PRELOAD_NATIVE_CAPTURE_SLOT = 'local-pcm-preload-foreground'
const MAX_LOCAL_PCM_PATH_LENGTH = 32_768
const MIN_LOCAL_PCM_SAMPLE_RATE = 8_000
const MAX_LOCAL_PCM_SAMPLE_RATE = 384_000

export interface PreloadLocalPcmNativeCaptureInput {
  requestId: number
  filePath: string
  outputSampleRate: number
  priority: 'interactive'
}

export interface PreloadLocalPcmNativeCaptureBackend {
  getCapabilities: () => LocalPcmNativeCaptureCapabilities
  capture: (request: LocalPcmNativeCaptureRequest) => Promise<LocalPcmNativeCaptureResult>
  cancel: (jobId: string) => boolean
  cancelAll: () => number
  getActiveProcessIds: () => number[]
}

export type PreloadLocalPcmFfmpegResolver = () => Promise<string | null>

export interface PreloadLocalPcmNativeCaptureClientOptions {
  nativeClient: PreloadLocalPcmNativeCaptureBackend
  resolveFfmpegPath: PreloadLocalPcmFfmpegResolver
  createJobId?: () => string
}

interface ActivePreloadNativeCapture {
  requestId: number
  jobId: string
  cancelled: boolean
  dispatched: boolean
}

interface ReadyPreloadNativeCapture {
  capabilities: LocalPcmNativeCaptureCapabilities
  ffmpegPath: string
}

export class PreloadLocalPcmNativeCaptureCancelledError extends Error {
  constructor() {
    super('Preload native PCM capture was cancelled before dispatch.')
    this.name = 'PreloadLocalPcmNativeCaptureCancelledError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key))
}

export function validatePreloadLocalPcmNativeCaptureInput(
  value: unknown
): value is PreloadLocalPcmNativeCaptureInput {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['requestId', 'filePath', 'outputSampleRate', 'priority'])
    || !Number.isSafeInteger(value.requestId)
    || Number(value.requestId) < 0
    || typeof value.filePath !== 'string'
    || value.filePath.trim().length === 0
    || value.filePath.length > MAX_LOCAL_PCM_PATH_LENGTH
    || value.filePath.includes('\0')
    || !Number.isInteger(value.outputSampleRate)
    || Number(value.outputSampleRate) < MIN_LOCAL_PCM_SAMPLE_RATE
    || Number(value.outputSampleRate) > MAX_LOCAL_PCM_SAMPLE_RATE
    || value.priority !== 'interactive'
  ) {
    return false
  }
  return true
}

function buildFixedNativeCaptureRequest(
  input: PreloadLocalPcmNativeCaptureInput,
  ffmpegPath: string,
  jobId: string
): LocalPcmNativeCaptureRequest {
  return {
    jobId,
    slotId: PRELOAD_NATIVE_CAPTURE_SLOT,
    ffmpegPath,
    deliveryMode: 'complete_buffer',
    args: [
      '-v', 'error',
      '-nostdin',
      '-i', input.filePath,
      '-map', '0:a:0',
      '-vn',
      '-acodec', 'pcm_f32le',
      '-f', 'f32le',
      '-ar', String(input.outputSampleRate),
      'pipe:1'
    ]
  }
}

export class PreloadLocalPcmNativeCaptureClient {
  private readonly nativeClient: PreloadLocalPcmNativeCaptureBackend
  private readonly resolveFfmpegPath: PreloadLocalPcmFfmpegResolver
  private readonly createJobId: () => string
  private readonly activeCapturesByRequestId = new Map<number, ActivePreloadNativeCapture>()
  private activeForegroundCapture: ActivePreloadNativeCapture | null = null
  private ffmpegPathPromise: Promise<string | null> | null = null
  private readyPromise: Promise<ReadyPreloadNativeCapture> | null = null

  constructor(options: PreloadLocalPcmNativeCaptureClientOptions) {
    this.nativeClient = options.nativeClient
    this.resolveFfmpegPath = options.resolveFfmpegPath
    this.createJobId = options.createJobId ?? randomUUID
  }

  getCapabilities(): LocalPcmNativeCaptureCapabilities {
    return this.nativeClient.getCapabilities()
  }

  private async prepare(): Promise<ReadyPreloadNativeCapture> {
    const capabilities = this.nativeClient.getCapabilities()
    if (!capabilities.supported) {
      throw new Error(capabilities.reason ?? 'Preload native PCM capture is unavailable.')
    }
    if (capabilities.maxPcmBytes !== LOCAL_PCM_STREAM_MAX_BYTES) {
      throw new Error('Preload native PCM capture limit does not match Standard playback.')
    }

    this.ffmpegPathPromise ??= this.resolveFfmpegPath()
    const ffmpegPath = await this.ffmpegPathPromise
    if (typeof ffmpegPath !== 'string' || ffmpegPath.trim().length === 0) {
      throw new Error('FFmpeg could not be resolved for preload native PCM capture.')
    }
    return { capabilities, ffmpegPath }
  }

  ensureReady(): Promise<LocalPcmNativeCaptureCapabilities> {
    this.readyPromise ??= this.prepare()
    return this.readyPromise.then(({ capabilities }) => capabilities)
  }

  private isCurrentCapture(capture: ActivePreloadNativeCapture): boolean {
    return !capture.cancelled
      && this.activeForegroundCapture === capture
      && this.activeCapturesByRequestId.get(capture.requestId) === capture
  }

  async capture(input: unknown): Promise<LocalPcmNativeCaptureResult> {
    if (!validatePreloadLocalPcmNativeCaptureInput(input)) {
      throw new TypeError('Preload native PCM capture request is invalid.')
    }

    const generatedJobId = this.createJobId()
    const jobId = `preload:${input.requestId}:${generatedJobId}`
    if (
      typeof generatedJobId !== 'string'
      || generatedJobId.trim().length === 0
      || jobId.length > 256
      || jobId.includes('\0')
    ) {
      throw new Error('Preload native PCM capture could not create a job ID.')
    }
    const capture: ActivePreloadNativeCapture = {
      requestId: input.requestId,
      jobId,
      cancelled: false,
      dispatched: false
    }

    const superseded = this.activeForegroundCapture
    if (superseded) {
      superseded.cancelled = true
      if (superseded.dispatched) {
        this.nativeClient.cancel(superseded.jobId)
      }
    }
    this.activeForegroundCapture = capture
    this.activeCapturesByRequestId.set(input.requestId, capture)

    try {
      this.readyPromise ??= this.prepare()
      const { ffmpegPath } = await this.readyPromise
      if (!this.isCurrentCapture(capture)) {
        throw new PreloadLocalPcmNativeCaptureCancelledError()
      }

      capture.dispatched = true
      const result = await this.nativeClient.capture(
        buildFixedNativeCaptureRequest(input, ffmpegPath, capture.jobId)
      )
      if (
        result.jobId !== capture.jobId
        || result.deliveryMode !== 'complete_buffer'
        || result.outputBytes > LOCAL_PCM_STREAM_MAX_BYTES
        || (result.ok && (
          result.outputBytes === 0
          || result.pcm.byteLength !== result.outputBytes
        ))
        || (!result.ok && result.pcm.byteLength !== 0)
      ) {
        throw new TypeError('Preload native PCM capture result did not reconcile.')
      }
      return result
    } finally {
      if (this.activeForegroundCapture === capture) {
        this.activeForegroundCapture = null
      }
      if (this.activeCapturesByRequestId.get(input.requestId) === capture) {
        this.activeCapturesByRequestId.delete(input.requestId)
      }
    }
  }

  cancel(requestId: number): boolean {
    if (!Number.isSafeInteger(requestId) || requestId < 0) return false
    const capture = this.activeCapturesByRequestId.get(requestId)
    if (!capture) return false
    capture.cancelled = true
    if (this.activeForegroundCapture === capture) {
      this.activeForegroundCapture = null
    }
    return capture.dispatched ? this.nativeClient.cancel(capture.jobId) : true
  }

  cancelAll(): number {
    for (const capture of this.activeCapturesByRequestId.values()) {
      capture.cancelled = true
    }
    this.activeForegroundCapture = null
    this.activeCapturesByRequestId.clear()
    return this.nativeClient.cancelAll()
  }

  getActiveProcessIds(): number[] {
    return this.nativeClient.getActiveProcessIds()
  }
}

async function resolveStaticFfmpegPath(): Promise<string | null> {
  try {
    const module = await import('ffmpeg-static')
    return typeof module.default === 'string' ? module.default : null
  } catch {
    return null
  }
}

function toAsarUnpackedPath(candidate: string): string {
  return candidate.includes('app.asar')
    ? candidate.replace('app.asar', 'app.asar.unpacked')
    : candidate
}

export async function resolveBundledPreloadLocalPcmFfmpegPath(
  isPackaged: boolean,
  resourcesPath: string = process.resourcesPath
): Promise<string | null> {
  const executable = `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`
  const staticPath = await resolveStaticFfmpegPath()
  const candidates = new Set<string>([
    ...(isPackaged
      ? [join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', executable)]
      : []),
    ...(staticPath ? [staticPath, toAsarUnpackedPath(staticPath)] : [])
  ])

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Only Astra's bundled/static FFmpeg candidates are eligible.
    }
  }
  return null
}

export function createBundledPreloadLocalPcmNativeCaptureClient(
  isPackaged: boolean,
  resolveFfmpegPath?: PreloadLocalPcmFfmpegResolver
): PreloadLocalPcmNativeCaptureClient {
  const nativeClient: LocalPcmNativeCaptureClient =
    createBundledLocalPcmNativeCaptureClient(isPackaged)
  let ffmpegPathPromise: Promise<string | null> | null = null
  return new PreloadLocalPcmNativeCaptureClient({
    nativeClient,
    resolveFfmpegPath: resolveFfmpegPath ?? (() => {
      ffmpegPathPromise ??= resolveBundledPreloadLocalPcmFfmpegPath(isPackaged)
      return ffmpegPathPromise
    })
  })
}
