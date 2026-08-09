/// <reference types="electron-vite/node" />

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalAudioPcmTransportTimings } from '../types/diagnostics'
import { LOCAL_PCM_STREAM_MAX_BYTES } from '../shared/localPcmStream'
import {
  PreloadLocalPcmNativeCaptureCancelledError,
  createBundledPreloadLocalPcmNativeCaptureClient,
  type PreloadLocalPcmNativeCaptureClient
} from './localPcmNativeCaptureClient'
import {
  isLocalPcmNativeCaptureSetupFailure,
  type LocalPcmNativeCaptureResult
} from '../main/localPcmNativeCaptureClient'

const PRELOAD_NATIVE_DECODE_TIMEOUT_MS = 180_000
const PRELOAD_NATIVE_PROBE_TIMEOUT_MS = 10_000
const PRELOAD_NATIVE_PROBE_MAX_BUFFER_BYTES = 256 * 1024
const MAX_LOCAL_PCM_PATH_LENGTH = 32_768

export interface PreloadLocalPcmNativeDecodeInput {
  requestId: number
  filePath: string
  outputSampleRate: number
  expectedChannels: number | null
  priority: 'interactive'
}

export interface PreloadLocalPcmNativeDecodeResult {
  requestId: number
  sampleRate: number
  channels: number
  frames: number
  pcmByteLength: number
  interleavedPcm: ArrayBuffer
  probeMs: number
  decodeMs: number
  backgroundPriorityApplied: false
  transportTimings: LocalAudioPcmTransportTimings
}

export interface PreloadLocalPcmProbeResult {
  channels: number
  durationSeconds: number | null
}

export type PreloadLocalPcmNativeDecodeAuthorizer = (
  input: PreloadLocalPcmNativeDecodeInput
) => Promise<boolean>

export type PreloadLocalPcmFfprobeResolver = () => Promise<string | null>

export type PreloadLocalPcmFfprobeRunner = (
  ffprobePath: string,
  filePath: string,
  signal: AbortSignal,
  publishProcessId: (processId: number | null) => void
) => Promise<PreloadLocalPcmProbeResult>

export interface PreloadLocalPcmNativeDecodeCoordinatorOptions {
  nativeCaptureClient: PreloadLocalPcmNativeCaptureClient
  authorize: PreloadLocalPcmNativeDecodeAuthorizer
  resolveFfprobePath: PreloadLocalPcmFfprobeResolver
  runFfprobe?: PreloadLocalPcmFfprobeRunner
  now?: () => number
  timeoutMs?: number
}

interface ActivePreloadNativeDecode {
  generation: number
  requestId: number
  cancelled: boolean
  nativeDispatched: boolean
  probeAbortController: AbortController | null
}

interface ReadyPreloadNativeDecode {
  ffprobePath: string
}

export class PreloadLocalPcmNativeDecodeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreloadLocalPcmNativeDecodeUnavailableError'
  }
}

export class PreloadLocalPcmNativeDecodeCancelledError extends Error {
  constructor(message: string = 'Preload native PCM decode was cancelled.') {
    super(message)
    this.name = 'PreloadLocalPcmNativeDecodeCancelledError'
  }
}

export class PreloadLocalPcmNativeDecodeUnauthorizedError extends Error {
  constructor() {
    super('Preload native PCM decode was not authorized for this window or route.')
    this.name = 'PreloadLocalPcmNativeDecodeUnauthorizedError'
  }
}

export class PreloadLocalPcmNativeDecodeTimeoutError extends Error {
  constructor() {
    super('Preload native PCM decode timed out.')
    this.name = 'PreloadLocalPcmNativeDecodeTimeoutError'
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

export function validatePreloadLocalPcmNativeDecodeInput(
  value: unknown
): value is PreloadLocalPcmNativeDecodeInput {
  return isRecord(value)
    && hasExactKeys(value, [
      'requestId',
      'filePath',
      'outputSampleRate',
      'expectedChannels',
      'priority'
    ])
    && Number.isSafeInteger(value.requestId)
    && Number(value.requestId) >= 0
    && typeof value.filePath === 'string'
    && value.filePath.trim().length > 0
    && value.filePath.length <= MAX_LOCAL_PCM_PATH_LENGTH
    && !value.filePath.includes('\0')
    && Number.isInteger(value.outputSampleRate)
    && Number(value.outputSampleRate) >= 8_000
    && Number(value.outputSampleRate) <= 384_000
    && (
      value.expectedChannels === null
      || (
        Number.isInteger(value.expectedChannels)
        && Number(value.expectedChannels) >= 1
        && Number(value.expectedChannels) <= 8
      )
    )
    && value.priority === 'interactive'
}

function roundDiagnosticMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseFfprobeTimeBase(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const [numeratorValue, denominatorValue] = value.split('/', 2)
  const numerator = Number(numeratorValue)
  const denominator = Number(denominatorValue)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null
  }
  const seconds = numerator / denominator
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

export function parsePreloadLocalPcmFfprobeOutput(stdout: string): PreloadLocalPcmProbeResult {
  const parsed = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  const stream = parsed.streams?.[0]
  const channels = Math.round(parseNumber(stream?.channels) ?? 0)
  if (channels < 1 || channels > 8) {
    throw new Error(
      channels > 8
        ? 'Local FFmpeg decode supports at most 8 channels.'
        : 'FFprobe could not determine the local audio stream channel count.'
    )
  }

  const durationTs = parseNumber(stream?.duration_ts)
  const timeBaseSeconds = parseFfprobeTimeBase(stream?.time_base)
  const durationFromTimeBase = durationTs !== undefined && timeBaseSeconds !== null
    ? durationTs * timeBaseSeconds
    : null
  const durationSeconds = [
    durationFromTimeBase,
    parseNumber(stream?.duration),
    parseNumber(parsed.format?.duration)
  ].find(
    (candidate): candidate is number => typeof candidate === 'number'
      && Number.isFinite(candidate)
      && candidate > 0
  ) ?? null
  return { channels, durationSeconds }
}

export function runBundledPreloadLocalPcmFfprobe(
  ffprobePath: string,
  filePath: string,
  signal: AbortSignal,
  publishProcessId: (processId: number | null) => void = () => undefined
): Promise<PreloadLocalPcmProbeResult> {
  return new Promise((resolve, reject) => {
    const notifyProcessId = (processId: number | null): void => {
      try {
        publishProcessId(processId)
      } catch {
        // PID telemetry must never alter probe settlement.
      }
    }
    try {
      const child = execFile(
        ffprobePath,
        [
          '-v', 'error',
          '-print_format', 'json',
          '-show_entries', 'stream=channels,duration,duration_ts,time_base:format=duration',
          '-select_streams', 'a:0',
          filePath
        ],
        {
          timeout: PRELOAD_NATIVE_PROBE_TIMEOUT_MS,
          maxBuffer: PRELOAD_NATIVE_PROBE_MAX_BUFFER_BYTES,
          signal,
          windowsHide: true
        },
        (error, stdout) => {
          notifyProcessId(null)
          if (error) {
            reject(new Error('FFprobe failed to inspect the local audio stream.'))
            return
          }
          try {
            resolve(parsePreloadLocalPcmFfprobeOutput(stdout))
          } catch {
            reject(new Error('FFprobe returned invalid local audio metadata.'))
          }
        }
      )
      const processId = child.pid
      if (typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0) {
        notifyProcessId(processId)
      }
    } catch {
      notifyProcessId(null)
      reject(new Error('FFprobe failed to inspect the local audio stream.'))
    }
  })
}

async function resolveStaticFfprobePath(): Promise<string | null> {
  try {
    const module = await import('ffprobe-static') as {
      path?: unknown
      default?: { path?: unknown }
    }
    const candidate = module.path ?? module.default?.path
    return typeof candidate === 'string' ? candidate : null
  } catch {
    return null
  }
}

function toAsarUnpackedPath(candidate: string): string {
  return candidate.includes('app.asar')
    ? candidate.replace('app.asar', 'app.asar.unpacked')
    : candidate
}

export async function resolveBundledPreloadLocalPcmFfprobePath(
  isPackaged: boolean,
  resourcesPath: string = process.resourcesPath
): Promise<string | null> {
  const executable = `ffprobe${process.platform === 'win32' ? '.exe' : ''}`
  const staticPath = await resolveStaticFfprobePath()
  const candidates = new Set<string>([
    ...(isPackaged
      ? [
          join(
            resourcesPath,
            'app.asar.unpacked',
            'node_modules',
            'ffprobe-static',
            'bin',
            process.platform,
            process.arch,
            executable
          )
        ]
      : []),
    ...(staticPath ? [staticPath, toAsarUnpackedPath(staticPath)] : [])
  ])
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Only Astra's bundled ffprobe-static candidates are eligible.
    }
  }
  return null
}

function toExactArrayBuffer(pcm: Buffer): ArrayBuffer {
  const backing = pcm.buffer
  if (
    backing instanceof ArrayBuffer
    && pcm.byteOffset === 0
    && backing.byteLength === pcm.byteLength
  ) {
    return backing
  }
  const exact = new Uint8Array(pcm.byteLength)
  exact.set(pcm)
  return exact.buffer
}

function nativeCaptureFailureMessage(result: LocalPcmNativeCaptureResult): string {
  const detail = result.errorCode ?? (
    result.exitCode === null ? 'unknown_error' : `exit_${result.exitCode}`
  )
  return `Preload native PCM capture failed (${detail}).`
}

export class PreloadLocalPcmNativeDecodeCoordinator {
  private readonly nativeCaptureClient: PreloadLocalPcmNativeCaptureClient
  private readonly authorize: PreloadLocalPcmNativeDecodeAuthorizer
  private readonly resolveFfprobePath: PreloadLocalPcmFfprobeResolver
  private readonly runFfprobe: PreloadLocalPcmFfprobeRunner
  private readonly now: () => number
  private readonly timeoutMs: number
  private readyPromise: Promise<ReadyPreloadNativeDecode> | null = null
  private activeDecode: ActivePreloadNativeDecode | null = null
  private readonly activeProbeProcessIdsByGeneration = new Map<number, number>()
  private generation = 0

  constructor(options: PreloadLocalPcmNativeDecodeCoordinatorOptions) {
    this.nativeCaptureClient = options.nativeCaptureClient
    this.authorize = options.authorize
    this.resolveFfprobePath = options.resolveFfprobePath
    this.runFfprobe = options.runFfprobe ?? runBundledPreloadLocalPcmFfprobe
    this.now = options.now ?? (() => performance.now())
    this.timeoutMs = options.timeoutMs ?? PRELOAD_NATIVE_DECODE_TIMEOUT_MS
  }

  private async prepare(): Promise<ReadyPreloadNativeDecode> {
    try {
      const [, ffprobePath] = await Promise.all([
        this.nativeCaptureClient.ensureReady(),
        this.resolveFfprobePath()
      ])
      if (typeof ffprobePath !== 'string' || ffprobePath.trim().length === 0) {
        throw new Error('FFprobe could not be resolved for preload native PCM decode.')
      }
      return { ffprobePath }
    } catch {
      throw new PreloadLocalPcmNativeDecodeUnavailableError(
        'The bundled native PCM decoder or probe is unavailable.'
      )
    }
  }

  ensureReady(): Promise<void> {
    this.readyPromise ??= this.prepare()
    return this.readyPromise.then(() => undefined)
  }

  private isCurrent(session: ActivePreloadNativeDecode): boolean {
    return !session.cancelled && this.activeDecode === session
  }

  private cancelSession(session: ActivePreloadNativeDecode): void {
    if (session.cancelled) return
    session.cancelled = true
    session.probeAbortController?.abort()
    this.nativeCaptureClient.cancel(session.requestId)
  }

  private publishProbeProcessId(
    session: ActivePreloadNativeDecode,
    processId: number | null
  ): void {
    if (
      typeof processId === 'number'
      && Number.isSafeInteger(processId)
      && processId > 0
      && processId !== process.pid
    ) {
      this.activeProbeProcessIdsByGeneration.set(session.generation, processId)
      return
    }
    this.activeProbeProcessIdsByGeneration.delete(session.generation)
  }

  async decode(inputValue: unknown): Promise<PreloadLocalPcmNativeDecodeResult> {
    if (!validatePreloadLocalPcmNativeDecodeInput(inputValue)) {
      throw new TypeError('Preload native PCM decode request is invalid.')
    }
    const input = inputValue
    const serviceStartedAtMs = this.now()
    const existing = this.activeDecode
    if (existing) this.cancelSession(existing)
    const session: ActivePreloadNativeDecode = {
      generation: ++this.generation,
      requestId: input.requestId,
      cancelled: false,
      nativeDispatched: false,
      probeAbortController: null
    }
    this.activeDecode = session

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.cancelSession(session)
        reject(new PreloadLocalPcmNativeDecodeTimeoutError())
      }, this.timeoutMs)
    })
    try {
      let authorized: boolean
      try {
        authorized = await Promise.race([this.authorize(input), timeoutPromise])
      } catch (error) {
        if (error instanceof PreloadLocalPcmNativeDecodeTimeoutError) throw error
        if (!this.isCurrent(session)) {
          throw new PreloadLocalPcmNativeDecodeCancelledError()
        }
        throw new PreloadLocalPcmNativeDecodeUnavailableError(
          error instanceof Error
            ? error.message
            : 'The preload native PCM authorization channel is unavailable.'
        )
      }
      if (!this.isCurrent(session)) throw new PreloadLocalPcmNativeDecodeCancelledError()
      if (authorized !== true) {
        throw new PreloadLocalPcmNativeDecodeUnauthorizedError()
      }

      const binaryResolutionStartedAtMs = this.now()
      this.readyPromise ??= this.prepare()
      const { ffprobePath } = await Promise.race([this.readyPromise, timeoutPromise])
      const binaryResolutionCompletedAtMs = this.now()
      if (!this.isCurrent(session)) throw new PreloadLocalPcmNativeDecodeCancelledError()

      const probeAbortController = new AbortController()
      session.probeAbortController = probeAbortController
      const captureStartedAtMs = this.now()
      session.nativeDispatched = true
      const nativePromise = this.nativeCaptureClient.capture({
        requestId: input.requestId,
        filePath: input.filePath,
        outputSampleRate: input.outputSampleRate,
        priority: input.priority
      }).then((result) => ({ result, completedAtMs: this.now() }))
      const probeStartedAtMs = this.now()
      const probePromise = this.runFfprobe(
        ffprobePath,
        input.filePath,
        probeAbortController.signal,
        (processId) => this.publishProbeProcessId(session, processId)
      )
        .then((result) => ({ result, completedAtMs: this.now() }))
        .finally(() => this.publishProbeProcessId(session, null))

      const [{ result: nativeResult, completedAtMs: captureCompletedAtMs }, {
        result: probeResult,
        completedAtMs: probeCompletedAtMs
      }] = await Promise.race([
        Promise.all([nativePromise, probePromise]),
        timeoutPromise
      ])
      if (!this.isCurrent(session)) throw new PreloadLocalPcmNativeDecodeCancelledError()
      if (nativeResult.cancelled) throw new PreloadLocalPcmNativeDecodeCancelledError()
      if (!nativeResult.ok) {
        if (isLocalPcmNativeCaptureSetupFailure(nativeResult)) {
          throw new PreloadLocalPcmNativeDecodeUnavailableError(
            nativeResult.errorMessage ?? 'Preload native PCM capture was unavailable before spawn.'
          )
        }
        throw new Error(nativeCaptureFailureMessage(nativeResult))
      }

      const frameSizeBytes = probeResult.channels * Float32Array.BYTES_PER_ELEMENT
      if (
        nativeResult.outputBytes <= 0
        || nativeResult.outputBytes > LOCAL_PCM_STREAM_MAX_BYTES
        || nativeResult.outputBytes % frameSizeBytes !== 0
        || nativeResult.pcm.byteLength !== nativeResult.outputBytes
      ) {
        throw new Error('Preload native PCM output failed byte/frame reconciliation.')
      }
      const frames = nativeResult.outputBytes / frameSizeBytes
      if (!Number.isSafeInteger(frames) || frames <= 0) {
        throw new Error('Preload native PCM output frame count is invalid.')
      }

      const payloadFinalizationStartedAtMs = this.now()
      const interleavedPcm = toExactArrayBuffer(nativeResult.pcm)
      const payloadFinalizationCompletedAtMs = this.now()
      // Match the existing main-native route's FFmpeg wall boundary: request
      // dispatch through the validated native Promise completion. The narrower
      // child-process span remains available as nativePcmCaptureProcessMs.
      const ffmpegMs = roundDiagnosticMs(captureCompletedAtMs - captureStartedAtMs)
      const ffmpegCloseTailMs = nativeResult.firstByteMs === null
        || nativeResult.stdoutReadSpanMs === null
        ? undefined
        : roundDiagnosticMs(Math.max(
            0,
            ffmpegMs - nativeResult.firstByteMs - nativeResult.stdoutReadSpanMs
          ))
      const preloadNativeServiceMs = roundDiagnosticMs(
        payloadFinalizationCompletedAtMs - serviceStartedAtMs
      )
      const probeMs = roundDiagnosticMs(probeCompletedAtMs - probeStartedAtMs)
      const probeFfmpegOverlapMs = roundDiagnosticMs(Math.max(
        0,
        Math.min(probeCompletedAtMs, captureCompletedAtMs)
          - Math.max(probeStartedAtMs, captureStartedAtMs)
      ))
      const transportTimings: LocalAudioPcmTransportTimings = {
        decodeRequestId: input.requestId,
        validPcmBytes: nativeResult.outputBytes,
        backingBufferBytes: interleavedPcm.byteLength,
        allocationGrowthCount: 0,
        transportRoute: 'preload_native',
        preloadNativeServiceMs,
        mainHandlerMs: 0,
        binaryResolutionMs: roundDiagnosticMs(
          binaryResolutionCompletedAtMs - binaryResolutionStartedAtMs
        ),
        probeMs,
        probeCacheStatus: 'bypass',
        probeDecodeOverlapEnabled: true,
        probeFfmpegOverlapMs,
        ffmpegMs,
        ffmpegOutputSink: 'preload_native',
        nativePcmCaptureSpawnMs: roundDiagnosticMs(nativeResult.spawnMs),
        nativePcmCaptureProcessMs: roundDiagnosticMs(nativeResult.processMs),
        ...(nativeResult.firstByteMs === null
          ? {}
          : { nativePcmCaptureFirstByteMs: roundDiagnosticMs(nativeResult.firstByteMs) }),
        ...(nativeResult.stdoutReadSpanMs === null
          ? {}
          : {
              nativePcmCaptureStdoutReadSpanMs:
                roundDiagnosticMs(nativeResult.stdoutReadSpanMs)
            }),
        nativePcmCaptureStdoutReadCount: nativeResult.stdoutReadCount,
        ...(nativeResult.stdoutReadMinBytes === null
          ? {}
          : { nativePcmCaptureStdoutReadMinBytes: nativeResult.stdoutReadMinBytes }),
        ...(nativeResult.stdoutReadMaxBytes === null
          ? {}
          : { nativePcmCaptureStdoutReadMaxBytes: nativeResult.stdoutReadMaxBytes }),
        nativePcmCaptureOutputBytes: nativeResult.outputBytes,
        nativePcmCaptureRequestedPipeBufferBytes: nativeResult.requestedPipeBufferBytes,
        ...(nativeResult.effectivePipeBufferBytes === null
          ? {}
          : {
              nativePcmCaptureEffectivePipeBufferBytes:
                nativeResult.effectivePipeBufferBytes
            }),
        nativePcmCaptureBufferCopyMs: roundDiagnosticMs(nativeResult.bufferCopyMs),
        nativePcmCaptureUsedExternalBuffer: nativeResult.usedExternalBuffer,
        nativePcmCaptureDeliveryMode: nativeResult.deliveryMode,
        nativePcmCaptureBatchTargetBytes: nativeResult.batchTargetBytes,
        nativePcmCaptureBatchCount: nativeResult.batchCount,
        nativePcmCaptureBatchBytes: nativeResult.batchBytes,
        nativePcmCaptureBatchCreditWaitCount: nativeResult.batchCreditWaitCount,
        nativePcmCaptureBatchCreditWaitMs:
          roundDiagnosticMs(nativeResult.batchCreditWaitMs),
        nativePcmCaptureBatchCreditWaitMaxMs:
          roundDiagnosticMs(nativeResult.batchCreditWaitMaxMs),
        nativePcmCaptureBatchCopyMs: roundDiagnosticMs(nativeResult.batchCopyMs),
        nativePcmCaptureBatchCopyMaxMs: roundDiagnosticMs(nativeResult.batchCopyMaxMs),
        nativePcmCaptureBatchCallbackMs: roundDiagnosticMs(nativeResult.batchCallbackMs),
        nativePcmCaptureBatchCallbackMaxMs:
          roundDiagnosticMs(nativeResult.batchCallbackMaxMs),
        ...(nativeResult.firstByteMs === null
          ? {}
          : { ffmpegSpawnToFirstPcmMs: roundDiagnosticMs(nativeResult.firstByteMs) }),
        ...(nativeResult.stdoutReadSpanMs === null
          ? {}
          : { ffmpegPcmOutputSpanMs: roundDiagnosticMs(nativeResult.stdoutReadSpanMs) }),
        ...(ffmpegCloseTailMs === undefined ? {} : { ffmpegCloseTailMs }),
        allocationMs: 0,
        initialAllocationMs: 0,
        growthAllocationMs: 0,
        payloadFinalizationMs: roundDiagnosticMs(
          payloadFinalizationCompletedAtMs - payloadFinalizationStartedAtMs
        ),
        preloadInvokeMs: 0
      }
      return {
        requestId: input.requestId,
        sampleRate: input.outputSampleRate,
        channels: probeResult.channels,
        frames,
        pcmByteLength: nativeResult.outputBytes,
        interleavedPcm,
        probeMs,
        decodeMs: ffmpegMs,
        backgroundPriorityApplied: false,
        transportTimings
      }
    } catch (error) {
      if (
        error instanceof PreloadLocalPcmNativeDecodeUnavailableError
        || error instanceof PreloadLocalPcmNativeDecodeTimeoutError
        || error instanceof PreloadLocalPcmNativeDecodeCancelledError
        || error instanceof PreloadLocalPcmNativeDecodeUnauthorizedError
      ) {
        throw error
      }
      if (
        error instanceof PreloadLocalPcmNativeCaptureCancelledError
        || session.cancelled
        || !this.isCurrent(session)
      ) {
        throw new PreloadLocalPcmNativeDecodeCancelledError()
      }
      // Any probe/native/protocol failure after capture dispatch is
      // authoritative: cancel the child and never trigger a hidden second
      // full-track decode in main.
      if (session.nativeDispatched) {
        this.cancelSession(session)
      }
      throw error
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      session.probeAbortController?.abort()
      session.probeAbortController = null
      if (this.activeDecode === session) this.activeDecode = null
    }
  }

  cancel(requestId: number): boolean {
    if (!Number.isSafeInteger(requestId) || requestId < 0) return false
    const session = this.activeDecode
    if (!session || session.requestId !== requestId) return false
    this.cancelSession(session)
    if (this.activeDecode === session) this.activeDecode = null
    return true
  }

  cancelAll(): number {
    const session = this.activeDecode
    if (session) this.cancelSession(session)
    this.activeDecode = null
    return this.nativeCaptureClient.cancelAll()
  }

  getActiveProcessIds(): number[] {
    const processIds = new Set<number>()
    for (const processId of this.nativeCaptureClient.getActiveProcessIds()) {
      if (
        Number.isSafeInteger(processId)
        && processId > 0
        && processId !== process.pid
      ) {
        processIds.add(processId)
      }
    }
    for (const processId of this.activeProbeProcessIdsByGeneration.values()) {
      processIds.add(processId)
    }
    return [...processIds]
  }
}

export interface BundledPreloadLocalPcmNativeDecodeCoordinatorOptions {
  isPackaged: boolean
  authorize: PreloadLocalPcmNativeDecodeAuthorizer
  nativeCaptureClient?: PreloadLocalPcmNativeCaptureClient
  resolveFfprobePath?: PreloadLocalPcmFfprobeResolver
  runFfprobe?: PreloadLocalPcmFfprobeRunner
}

export function createBundledPreloadLocalPcmNativeDecodeCoordinator(
  options: BundledPreloadLocalPcmNativeDecodeCoordinatorOptions
): PreloadLocalPcmNativeDecodeCoordinator {
  const nativeCaptureClient = options.nativeCaptureClient
    ?? createBundledPreloadLocalPcmNativeCaptureClient(options.isPackaged)
  let ffprobePathPromise: Promise<string | null> | null = null
  return new PreloadLocalPcmNativeDecodeCoordinator({
    nativeCaptureClient,
    authorize: options.authorize,
    resolveFfprobePath: options.resolveFfprobePath ?? (() => {
      ffprobePathPromise ??= resolveBundledPreloadLocalPcmFfprobePath(options.isPackaged)
      return ffprobePathPromise
    }),
    runFfprobe: options.runFfprobe
  })
}
