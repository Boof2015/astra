import { access } from 'fs/promises'
import { execFile, spawn } from 'child_process'
import { join } from 'path'
import type {
  AudioBufferMemoryStats,
  NativeAudioBackendKind,
  NativeAudioCapabilities,
  NativeAudioEvent,
  NativeAudioOutputDevice,
  NativeAudioPlaybackSnapshot,
  NativeAudioSampleFormat,
  NativeAudioTrackLoadResult,
  NativeAudioTrackMetadata,
  NativeAudioVisualizerTapDemand,
  NativeAudioVUMeterChunk,
  NativeAudioVectorscopeChunk
} from '../types/nativeAudio'

export interface NativeAudioAddonPlayback {
  getCapabilities(): NativeAudioCapabilities
  setOutputDevice(deviceId: string): NativeAudioCapabilities
  loadTrack(
    pcmData: Uint8Array,
    sampleRate: number,
    channels: number,
    sampleFormat: NativeAudioSampleFormat,
    duration: number
  ): NativeAudioPlaybackSnapshot
  preloadNextTrack(
    pcmData: Uint8Array,
    sampleRate: number,
    channels: number,
    sampleFormat: NativeAudioSampleFormat,
    duration: number
  ): void
  promoteNextTrack(): NativeAudioPlaybackSnapshot
  play(): Promise<NativeAudioPlaybackSnapshot>
  pause(): NativeAudioPlaybackSnapshot
  stop(): NativeAudioPlaybackSnapshot
  seek(seconds: number): NativeAudioPlaybackSnapshot
  clearNextTrack(): void
  getPlaybackSnapshot(): NativeAudioPlaybackSnapshot
  setVisualizerTapDemand(demand: NativeAudioVisualizerTapDemand): void
  drainEvents(): NativeAudioEvent[]
  flushOscilloscopeSamples(): Float32Array | null
  flushSpectrumSamples(): Float32Array | null
  flushVectorscopeSamples(): { left: Float32Array; right: Float32Array } | null
  flushVUMeterSamples(): NativeAudioVUMeterChunk | null
}

export interface NativeAudioAddonModule {
  playback?: NativeAudioAddonPlayback
}

interface NativeAudioControllerApi {
  initialize: () => Promise<NativeAudioCapabilities>
  getCapabilities: () => Promise<NativeAudioCapabilities>
  setOutputDevice: (deviceId: string) => Promise<NativeAudioCapabilities>
  loadTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
  preloadNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
  promoteNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
  play: () => Promise<NativeAudioPlaybackSnapshot>
  pause: () => Promise<NativeAudioPlaybackSnapshot>
  stop: () => Promise<NativeAudioPlaybackSnapshot>
  seek: (seconds: number) => Promise<NativeAudioPlaybackSnapshot>
  clearNextTrack: () => Promise<void>
  getPlaybackSnapshot: () => Promise<NativeAudioPlaybackSnapshot>
  getBufferMemoryStats: () => Promise<AudioBufferMemoryStats>
  setVisualizerTapDemand: (demand: NativeAudioVisualizerTapDemand) => Promise<void>
  flushOscilloscopeChunks: () => Float32Array[]
  flushSpectrumChunks: () => Float32Array[]
  flushVectorscopeChunks: () => NativeAudioVectorscopeChunk[]
  flushVUMeterChunks: () => NativeAudioVUMeterChunk[]
  onEvent: (callback: (event: NativeAudioEvent) => void) => () => void
}

interface NativeAudioControllerOptions {
  unavailableReason?: string | null
}

class SupersededNativeAudioLoadError extends Error {
  constructor(message = 'Native audio load was superseded by a newer request.') {
    super(message)
    this.name = 'SupersededNativeAudioLoadError'
  }
}

interface DecodedPcmTrack {
  filePath: string
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioSampleFormat
  duration: number
  pcmData: Buffer
}

interface DecodeFileOptions {
  backendKind?: NativeAudioBackendKind
  forcedSampleFormat?: NativeAudioSampleFormat
}

interface LoadedTrackRequest {
  filePath: string
  metadata?: NativeAudioTrackMetadata
  sampleRate: number
  channels: number
  sampleFormat: NativeAudioSampleFormat
  duration: number
}

interface FfprobeStreamInfo {
  codec_name?: string
  codec_type?: string
  sample_rate?: string
  channels?: number
  duration?: string
  sample_fmt?: string
  bits_per_raw_sample?: string
}

const LOSSY_CODECS = new Set([
  'aac',
  'mp3',
  'vorbis',
  'opus',
  'wma',
  'wmav2',
  'wmavoice',
  'ac3',
  'eac3',
  'dts',
  'atrac3',
  'atrac3p',
  'cook'
])

const DEFAULT_UNAVAILABLE_CAPABILITIES: NativeAudioCapabilities = {
  bitPerfectAvailable: false,
  reasonUnavailable: 'Native bit-perfect playback is unavailable in this build.',
  activeBackend: 'unavailable',
  activeDeviceExclusive: false,
  activeSampleRate: null,
  activeSampleFormat: null,
  selectedDeviceId: null,
  selectedDeviceMaxChannels: null,
  devices: []
}

const EMPTY_AUDIO_BUFFER_MEMORY_STATS: AudioBufferMemoryStats = {
  currentBytes: 0,
  nextBytes: 0,
  totalBytes: 0
}

const EMPTY_PCM_BUFFER = Buffer.alloc(0)

function releaseDecodedPcmBuffer(decoded: DecodedPcmTrack): void {
  // Native copies PCM synchronously; keep metadata/byte counts without pinning external memory.
  decoded.pcmData = EMPTY_PCM_BUFFER
}

function looksLikePath(candidate: string): boolean {
  return candidate.includes('/') || candidate.includes('\\') || /^[a-zA-Z]:[\\/]/.test(candidate)
}

function toAsarUnpackedPath(candidate: string): string {
  if (!candidate.includes('app.asar')) return candidate
  return candidate.replace('app.asar', 'app.asar.unpacked')
}

function normalizeBackendKind(value: unknown): NativeAudioBackendKind {
  if (value === 'coreaudio' || value === 'wasapi-exclusive' || value === 'alsa-hw') return value
  return 'unavailable'
}

function normalizeSampleFormat(value: unknown): NativeAudioSampleFormat | null {
  if (value === 's16' || value === 's32' || value === 'f32') return value
  return null
}

function normalizeOutputDevices(value: unknown): NativeAudioOutputDevice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as Partial<NativeAudioOutputDevice>
    if (typeof raw.deviceId !== 'string' || raw.deviceId.trim().length === 0) return []
    const label = typeof raw.label === 'string' && raw.label.trim().length > 0
      ? raw.label.trim()
      : raw.deviceId
    return [{
      deviceId: raw.deviceId.trim(),
      label,
      maxChannels: Number.isFinite(raw.maxChannels) ? Math.max(1, Math.round(Number(raw.maxChannels))) : 2,
      isDefault: Boolean(raw.isDefault)
    }]
  })
}

function normalizeCapabilities(value: unknown): NativeAudioCapabilities {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_UNAVAILABLE_CAPABILITIES }
  }

  const raw = value as Partial<NativeAudioCapabilities>
  return {
    bitPerfectAvailable: Boolean(raw.bitPerfectAvailable),
    reasonUnavailable: typeof raw.reasonUnavailable === 'string' && raw.reasonUnavailable.trim().length > 0
      ? raw.reasonUnavailable.trim()
      : null,
    activeBackend: normalizeBackendKind(raw.activeBackend),
    activeDeviceExclusive: Boolean(raw.activeDeviceExclusive),
    activeSampleRate: Number.isFinite(raw.activeSampleRate) ? Math.max(1, Math.round(Number(raw.activeSampleRate))) : null,
    activeSampleFormat: normalizeSampleFormat(raw.activeSampleFormat),
    selectedDeviceId: typeof raw.selectedDeviceId === 'string' && raw.selectedDeviceId.trim().length > 0
      ? raw.selectedDeviceId.trim()
      : null,
    selectedDeviceMaxChannels: Number.isFinite(raw.selectedDeviceMaxChannels)
      ? Math.max(1, Math.round(Number(raw.selectedDeviceMaxChannels)))
      : null,
    devices: normalizeOutputDevices(raw.devices)
  }
}

function normalizePlaybackSnapshot(value: unknown): NativeAudioPlaybackSnapshot {
  if (!value || typeof value !== 'object') {
    return {
      playbackState: 'stopped',
      currentTime: 0,
      duration: 0,
      sampleRate: null,
      channels: null,
      sampleFormat: null,
      deviceId: null,
      deviceLabel: null,
      activeBackend: 'unavailable',
      activeDeviceExclusive: false,
      bitPerfectActive: false
    }
  }

  const raw = value as Partial<NativeAudioPlaybackSnapshot>
  const playbackState = raw.playbackState === 'playing' || raw.playbackState === 'paused' || raw.playbackState === 'loading'
    ? raw.playbackState
    : 'stopped'

  return {
    playbackState,
    currentTime: Number.isFinite(raw.currentTime) ? Math.max(0, Number(raw.currentTime)) : 0,
    duration: Number.isFinite(raw.duration) ? Math.max(0, Number(raw.duration)) : 0,
    sampleRate: Number.isFinite(raw.sampleRate) ? Math.max(1, Math.round(Number(raw.sampleRate))) : null,
    channels: Number.isFinite(raw.channels) ? Math.max(1, Math.round(Number(raw.channels))) : null,
    sampleFormat: normalizeSampleFormat(raw.sampleFormat),
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId.trim().length > 0 ? raw.deviceId.trim() : null,
    deviceLabel: typeof raw.deviceLabel === 'string' && raw.deviceLabel.trim().length > 0 ? raw.deviceLabel.trim() : null,
    activeBackend: normalizeBackendKind(raw.activeBackend),
    activeDeviceExclusive: Boolean(raw.activeDeviceExclusive),
    bitPerfectActive: Boolean(raw.bitPerfectActive)
  }
}

function normalizeEvent(value: unknown): NativeAudioEvent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<NativeAudioEvent> & { message?: unknown }
  switch (raw.type) {
    case 'stateChange':
      return {
        type: 'stateChange',
        playbackState: raw.playbackState === 'playing' || raw.playbackState === 'paused' || raw.playbackState === 'loading'
          ? raw.playbackState
          : 'stopped'
      }
    case 'timeUpdate':
      return {
        type: 'timeUpdate',
        currentTime: Number.isFinite(raw.currentTime) ? Math.max(0, Number(raw.currentTime)) : 0
      }
    case 'durationChange':
      return {
        type: 'durationChange',
        duration: Number.isFinite(raw.duration) ? Math.max(0, Number(raw.duration)) : 0
      }
    case 'ended':
      return { type: 'ended' }
    case 'gaplessTransition':
      return { type: 'gaplessTransition' }
    case 'deviceReopened':
      return {
        type: 'deviceReopened',
        sampleRate: Number.isFinite(raw.sampleRate) ? Math.max(1, Math.round(Number(raw.sampleRate))) : null,
        sampleFormat: normalizeSampleFormat(raw.sampleFormat),
        deviceId: typeof raw.deviceId === 'string' && raw.deviceId.trim().length > 0 ? raw.deviceId.trim() : null
      }
    case 'sampleRateChanged':
      return {
        type: 'sampleRateChanged',
        sampleRate: Number.isFinite(raw.sampleRate) ? Math.max(1, Math.round(Number(raw.sampleRate))) : null
      }
    case 'error':
      return {
        type: 'error',
        message: typeof raw.message === 'string' && raw.message.trim().length > 0
          ? raw.message.trim()
          : 'Unknown native audio error.'
      }
    default:
      return null
  }
}

function normalizeTrackLoadResult(
  snapshot: NativeAudioPlaybackSnapshot,
  decoded: DecodedPcmTrack
): NativeAudioTrackLoadResult {
  return {
    sampleRate: snapshot.sampleRate ?? decoded.sampleRate,
    channels: snapshot.channels ?? decoded.channels,
    sampleFormat: snapshot.sampleFormat ?? decoded.sampleFormat,
    duration: snapshot.duration > 0 ? snapshot.duration : decoded.duration,
    bitPerfectActive: snapshot.bitPerfectActive
  }
}

function normalizePromotedTrackLoadResult(
  snapshot: NativeAudioPlaybackSnapshot,
  fallback: LoadedTrackRequest | null
): NativeAudioTrackLoadResult {
  return {
    sampleRate: snapshot.sampleRate ?? fallback?.sampleRate ?? fallback?.metadata?.sampleRate ?? 0,
    channels: snapshot.channels ?? fallback?.channels ?? fallback?.metadata?.channels ?? 2,
    sampleFormat: snapshot.sampleFormat ?? fallback?.sampleFormat ?? 'f32',
    duration: snapshot.duration > 0 ? snapshot.duration : fallback?.duration ?? 0,
    bitPerfectActive: snapshot.bitPerfectActive
  }
}

function createExecFilePromise(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message
        reject(new Error(message))
        return
      }
      resolve(stdout)
    })
  })
}

async function resolveStaticBinary(binary: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  try {
    if (binary === 'ffmpeg') {
      const mod = await import('ffmpeg-static')
      return typeof mod.default === 'string' ? mod.default : null
    }
    const mod = await import('ffprobe-static') as { path?: string; default?: { path?: string } }
    const modulePath = mod.path ?? mod.default?.path
    return typeof modulePath === 'string' ? modulePath : null
  } catch {
    return null
  }
}

async function resolveBinary(binary: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  const isWindows = process.platform === 'win32'
  const executable = `${binary}${isWindows ? '.exe' : ''}`
  const staticModulePath = await resolveStaticBinary(binary)
  const packagedStaticCandidates = process.env.NODE_ENV === 'development'
    ? []
    : (
        binary === 'ffmpeg'
          ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', executable)]
          : [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, executable)]
      )
  const candidates = [
    ...(process.env.NODE_ENV === 'development' ? [] : [
      join(process.resourcesPath, executable),
      join(process.resourcesPath, 'bin', executable)
    ]),
    ...packagedStaticCandidates,
    ...(staticModulePath ? [staticModulePath] : []),
    ...(binary === 'ffmpeg'
      ? (isWindows ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
      : (isWindows ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']))
  ]

  for (const rawCandidate of candidates) {
    const candidate = toAsarUnpackedPath(rawCandidate)
    if (looksLikePath(candidate)) {
      try {
        await access(candidate)
      } catch {
        continue
      }
    }
    try {
      await createExecFilePromise(candidate, ['-version'])
      return candidate
    } catch {
      // Try next candidate.
    }
  }

  return null
}

function parseSampleRate(value: string | number | undefined): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.round(numeric)
}

function resolveSampleFormat(
  stream: FfprobeStreamInfo,
  metadata?: NativeAudioTrackMetadata,
  backendKind: NativeAudioBackendKind = 'unavailable',
  forcedSampleFormat?: NativeAudioSampleFormat
): NativeAudioSampleFormat {
  if (forcedSampleFormat) {
    return forcedSampleFormat
  }

  const codec = (stream.codec_name ?? metadata?.codec ?? '').trim().toLowerCase()
  const sampleFormat = (stream.sample_fmt ?? '').trim().toLowerCase()
  const bitDepth = Number(stream.bits_per_raw_sample ?? metadata?.bitDepth ?? 0)

  // Many ALSA hw devices reject float PCM in direct mode, especially for common
  // 44.1 kHz lossy material. Keep the exact sample rate, but prefer integer PCM
  // for Linux hardware output when the source does not provide integer samples.
  if (backendKind === 'alsa-hw') {
    if (sampleFormat.startsWith('u8') || sampleFormat.startsWith('s8') || sampleFormat.startsWith('s16')) {
      return 's32'
    }

    if (sampleFormat.startsWith('s24') || sampleFormat.startsWith('s32') || sampleFormat.startsWith('s64')) {
      return 's32'
    }

    if (Number.isFinite(bitDepth) && bitDepth > 0) {
      return bitDepth > 16 ? 's32' : 's32'
    }

    if (LOSSY_CODECS.has(codec)) {
      return 's16'
    }

    if (sampleFormat.startsWith('flt') || sampleFormat.startsWith('dbl')) {
      return Number.isFinite(bitDepth) && bitDepth > 16 ? 's32' : 's16'
    }
  }

  if (LOSSY_CODECS.has(codec)) {
    return 'f32'
  }

  if (sampleFormat.startsWith('flt') || sampleFormat.startsWith('dbl')) {
    return 'f32'
  }

  if (sampleFormat.startsWith('u8') || sampleFormat.startsWith('s8') || sampleFormat.startsWith('s16')) {
    return 's16'
  }

  if (sampleFormat.startsWith('s24') || sampleFormat.startsWith('s32') || sampleFormat.startsWith('s64')) {
    return 's32'
  }

  if (Number.isFinite(bitDepth) && bitDepth > 16) {
    return 's32'
  }

  if (Number.isFinite(bitDepth) && bitDepth > 0 && bitDepth <= 16) {
    return 's16'
  }

  return 'f32'
}

function getFfmpegFormatArgs(sampleFormat: NativeAudioSampleFormat): string[] {
  switch (sampleFormat) {
    case 's16':
      return ['-c:a', 'pcm_s16le', '-f', 's16le']
    case 's32':
      return ['-c:a', 'pcm_s32le', '-f', 's32le']
    case 'f32':
      return ['-c:a', 'pcm_f32le', '-f', 'f32le']
  }
}

export function createNativeAudioController(
  nativeModule: NativeAudioAddonModule | null,
  options: NativeAudioControllerOptions = {}
): NativeAudioControllerApi {
  const playback = nativeModule?.playback ?? null
  const listeners = new Set<(event: NativeAudioEvent) => void>()
  let eventPollTimer: ReturnType<typeof setInterval> | null = null
  let currentTrackRequest: LoadedTrackRequest | null = null
  let nextTrackRequest: LoadedTrackRequest | null = null
  let loadGeneration = 0
  let prebufferGeneration = 0
  let currentBufferBytes = 0
  let nextBufferBytes = 0
  const fallbackUnavailableReason = options.unavailableReason?.trim() || DEFAULT_UNAVAILABLE_CAPABILITIES.reasonUnavailable
  let capabilitiesCache: NativeAudioCapabilities = {
    ...DEFAULT_UNAVAILABLE_CAPABILITIES,
    reasonUnavailable: fallbackUnavailableReason
  }

  const buildBufferMemoryStats = (): AudioBufferMemoryStats => ({
    currentBytes: currentBufferBytes,
    nextBytes: nextBufferBytes,
    totalBytes: currentBufferBytes + nextBufferBytes
  })

  const beginLoadOperation = (): number => {
    loadGeneration += 1
    prebufferGeneration += 1
    return loadGeneration
  }

  const invalidateLoadOperations = (): void => {
    loadGeneration += 1
    prebufferGeneration += 1
  }

  const beginPrebufferOperation = (): number => {
    prebufferGeneration += 1
    return prebufferGeneration
  }

  const invalidatePrebufferOperations = (): void => {
    prebufferGeneration += 1
  }

  const assertCurrentLoadOperation = (generation: number): void => {
    if (generation !== loadGeneration) {
      throw new SupersededNativeAudioLoadError()
    }
  }

  const assertCurrentPrebufferOperation = (generation: number): void => {
    if (generation !== prebufferGeneration) {
      throw new SupersededNativeAudioLoadError('Native audio prebuffer was superseded by a newer request.')
    }
  }

  const notify = (event: NativeAudioEvent) => {
    if (event.type === 'gaplessTransition') {
      currentBufferBytes = nextBufferBytes
      nextBufferBytes = 0
      currentTrackRequest = nextTrackRequest
      nextTrackRequest = null
    }

    for (const listener of listeners) {
      listener(event)
    }
  }

  const refreshCapabilities = (): NativeAudioCapabilities => {
    if (!playback) {
      capabilitiesCache = {
        ...DEFAULT_UNAVAILABLE_CAPABILITIES,
        reasonUnavailable: fallbackUnavailableReason
      }
      return capabilitiesCache
    }
    capabilitiesCache = normalizeCapabilities(playback.getCapabilities())
    return capabilitiesCache
  }

  const ensureEventPoller = (): void => {
    if (!playback || eventPollTimer !== null) return
    eventPollTimer = setInterval(() => {
      try {
        const drained = playback.drainEvents()
        for (const rawEvent of drained) {
          const event = normalizeEvent(rawEvent)
          if (event) notify(event)
        }
      } catch (error) {
        notify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to poll native audio events.'
        })
      }
    }, 50)
  }

  const ensureAvailable = async (): Promise<NativeAudioAddonPlayback> => {
    const caps = refreshCapabilities()
    if (!playback || !caps.bitPerfectAvailable) {
      throw new Error(caps.reasonUnavailable ?? 'Native bit-perfect playback is unavailable.')
    }
    ensureEventPoller()
    return playback
  }

  const decodeFileToPcm = async (
    filePath: string,
    metadata?: NativeAudioTrackMetadata,
    options: DecodeFileOptions = {}
  ): Promise<DecodedPcmTrack> => {
    const ffprobePath = await resolveBinary('ffprobe')
    const ffmpegPath = await resolveBinary('ffmpeg')
    if (!ffprobePath || !ffmpegPath) {
      throw new Error('FFmpeg/ffprobe could not be resolved for native playback.')
    }

    const ffprobeStdout = await createExecFilePromise(ffprobePath, [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      filePath
    ])
    const ffprobePayload = JSON.parse(ffprobeStdout) as {
      streams?: FfprobeStreamInfo[]
    }
    const stream = ffprobePayload.streams?.find((entry) => entry.codec_type === 'audio') ?? ffprobePayload.streams?.[0]
    if (!stream) {
      throw new Error('No audio stream found for native playback.')
    }

    const sampleRate = parseSampleRate(stream.sample_rate) ?? metadata?.sampleRate
    if (!sampleRate || sampleRate <= 0) {
      throw new Error('Could not determine sample rate for native playback.')
    }
    const channels = Number.isFinite(stream.channels) ? Math.max(1, Math.round(Number(stream.channels))) : (metadata?.channels ?? 2)
    const duration = Number.isFinite(Number(stream.duration))
      ? Math.max(0, Number(stream.duration))
      : 0
    const sampleFormat = resolveSampleFormat(
      stream,
      metadata,
      options.backendKind ?? capabilitiesCache.activeBackend,
      options.forcedSampleFormat
    )

    const ffmpegArgs = [
      '-v', 'error',
      '-i', filePath,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      ...getFfmpegFormatArgs(sampleFormat),
      'pipe:1'
    ]

    const pcmData = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const chunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk))
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(Buffer.from(chunk))
      })
      child.on('error', (error) => reject(error))
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(stderrChunks).toString('utf8').trim() || `ffmpeg exited with code ${code}`))
          return
        }
        resolve(Buffer.concat(chunks))
      })
    })

    return {
      filePath,
      sampleRate,
      channels,
      sampleFormat,
      duration,
      pcmData
    }
  }

  const loadDecodedTrack = (
    engine: NativeAudioAddonPlayback,
    decoded: DecodedPcmTrack
  ): NativeAudioTrackLoadResult => {
    const snapshot = normalizePlaybackSnapshot(engine.loadTrack(
      new Uint8Array(decoded.pcmData.buffer, decoded.pcmData.byteOffset, decoded.pcmData.byteLength),
      decoded.sampleRate,
      decoded.channels,
      decoded.sampleFormat,
      decoded.duration
    ))
    return normalizeTrackLoadResult(snapshot, decoded)
  }

  return {
    initialize: async () => {
      const caps = refreshCapabilities()
      if (caps.bitPerfectAvailable) {
        ensureEventPoller()
      }
      return caps
    },

    getCapabilities: async () => refreshCapabilities(),

    setOutputDevice: async (deviceId: string) => {
      const engine = await ensureAvailable()
      capabilitiesCache = normalizeCapabilities(engine.setOutputDevice(deviceId))
      return capabilitiesCache
    },

    loadTrack: async (filePath: string, metadata?: NativeAudioTrackMetadata) => {
      const loadOperation = beginLoadOperation()
      const engine = await ensureAvailable()
      assertCurrentLoadOperation(loadOperation)
      const backendKind = capabilitiesCache.activeBackend
      const decoded = await decodeFileToPcm(filePath, metadata, { backendKind })
      const decodedByteLength = decoded.pcmData.byteLength
      try {
        assertCurrentLoadOperation(loadOperation)
        currentTrackRequest = {
          filePath,
          metadata,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          sampleFormat: decoded.sampleFormat,
          duration: decoded.duration
        }
        const result = loadDecodedTrack(engine, decoded)
        currentBufferBytes = decodedByteLength
        nextBufferBytes = 0
        nextTrackRequest = null
        return result
      } finally {
        releaseDecodedPcmBuffer(decoded)
      }
    },

    preloadNextTrack: async (filePath: string, metadata?: NativeAudioTrackMetadata) => {
      const prebufferOperation = beginPrebufferOperation()
      const engine = await ensureAvailable()
      assertCurrentPrebufferOperation(prebufferOperation)
      const decoded = await decodeFileToPcm(filePath, metadata, {
        backendKind: capabilitiesCache.activeBackend
      })
      const decodedByteLength = decoded.pcmData.byteLength
      try {
        assertCurrentPrebufferOperation(prebufferOperation)
        engine.preloadNextTrack(
          new Uint8Array(decoded.pcmData.buffer, decoded.pcmData.byteOffset, decoded.pcmData.byteLength),
          decoded.sampleRate,
          decoded.channels,
          decoded.sampleFormat,
          decoded.duration
        )
        nextBufferBytes = decodedByteLength
        nextTrackRequest = {
          filePath,
          metadata,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          sampleFormat: decoded.sampleFormat,
          duration: decoded.duration
        }
        const snapshot = normalizePlaybackSnapshot(engine.getPlaybackSnapshot())
        return normalizeTrackLoadResult(snapshot, decoded)
      } finally {
        releaseDecodedPcmBuffer(decoded)
      }
    },

    promoteNextTrack: async (filePath: string, metadata?: NativeAudioTrackMetadata) => {
      const loadOperation = beginLoadOperation()
      const engine = await ensureAvailable()
      assertCurrentLoadOperation(loadOperation)
      const promotedRequest = nextTrackRequest?.filePath === filePath
        ? nextTrackRequest
        : null
      const snapshot = normalizePlaybackSnapshot(engine.promoteNextTrack())
      currentTrackRequest = promotedRequest ?? (
        snapshot.sampleRate && snapshot.channels && snapshot.sampleFormat
          ? {
              filePath,
              metadata,
              sampleRate: snapshot.sampleRate,
              channels: snapshot.channels,
              sampleFormat: snapshot.sampleFormat,
              duration: snapshot.duration
            }
          : null
      )
      currentBufferBytes = nextBufferBytes
      nextBufferBytes = 0
      nextTrackRequest = null
      return normalizePromotedTrackLoadResult(snapshot, currentTrackRequest)
    },

    play: async () => {
      const engine = await ensureAvailable()
      try {
        return normalizePlaybackSnapshot(await engine.play())
      } catch (error) {
        if (capabilitiesCache.activeBackend !== 'alsa-hw' || !currentTrackRequest) {
          throw error
        }

        const retrySampleFormat = currentTrackRequest.sampleFormat === 'f32'
          ? 's16'
          : currentTrackRequest.sampleFormat === 's16'
            ? 's32'
            : null

        if (!retrySampleFormat) {
          throw error
        }

        const decoded = await decodeFileToPcm(currentTrackRequest.filePath, currentTrackRequest.metadata, {
          backendKind: capabilitiesCache.activeBackend,
          forcedSampleFormat: retrySampleFormat
        })
        const decodedByteLength = decoded.pcmData.byteLength
        currentTrackRequest = {
          ...currentTrackRequest,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          sampleFormat: decoded.sampleFormat,
          duration: decoded.duration
        }
        try {
          loadDecodedTrack(engine, decoded)
          currentBufferBytes = decodedByteLength
          nextBufferBytes = 0
          nextTrackRequest = null
          return normalizePlaybackSnapshot(await engine.play())
        } finally {
          releaseDecodedPcmBuffer(decoded)
        }
      }
    },

    pause: async () => {
      const engine = await ensureAvailable()
      return normalizePlaybackSnapshot(engine.pause())
    },

    stop: async () => {
      invalidateLoadOperations()
      const engine = await ensureAvailable()
      return normalizePlaybackSnapshot(engine.stop())
    },

    seek: async (seconds: number) => {
      const engine = await ensureAvailable()
      return normalizePlaybackSnapshot(engine.seek(seconds))
    },

    clearNextTrack: async () => {
      invalidatePrebufferOperations()
      const engine = await ensureAvailable()
      nextBufferBytes = 0
      nextTrackRequest = null
      engine.clearNextTrack()
    },

    getPlaybackSnapshot: async () => {
      const engine = await ensureAvailable()
      return normalizePlaybackSnapshot(engine.getPlaybackSnapshot())
    },

    getBufferMemoryStats: async () => {
      if (!playback) return { ...EMPTY_AUDIO_BUFFER_MEMORY_STATS }
      return buildBufferMemoryStats()
    },

    setVisualizerTapDemand: async (demand: NativeAudioVisualizerTapDemand) => {
      const engine = await ensureAvailable()
      engine.setVisualizerTapDemand({
        oscilloscope: Boolean(demand.oscilloscope),
        spectrum: Boolean(demand.spectrum),
        vectorscope: Boolean(demand.vectorscope),
        vumeter: Boolean(demand.vumeter),
      })
    },

    flushOscilloscopeChunks: () => {
      if (!playback) return []
      const samples = playback.flushOscilloscopeSamples()
      return samples && samples.length > 0 ? [samples] : []
    },

    flushSpectrumChunks: () => {
      if (!playback) return []
      const samples = playback.flushSpectrumSamples()
      return samples && samples.length > 0 ? [samples] : []
    },

    flushVectorscopeChunks: () => {
      if (!playback) return []
      const samples = playback.flushVectorscopeSamples()
      return samples && samples.left.length > 0 && samples.right.length > 0 ? [samples] : []
    },

    flushVUMeterChunks: () => {
      if (!playback) return []
      const samples = playback.flushVUMeterSamples()
      return samples && samples.channels.some((channel) => channel.length > 0) ? [samples] : []
    },

    onEvent: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    }
  }
}
