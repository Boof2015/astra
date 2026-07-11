import { access, appendFile, mkdir, rename, rm, writeFile } from 'fs/promises'
import { shell, type ProcessMetric } from 'electron'
import { join } from 'path'
import type {
  MemoryDiagnosticsCaptureBundleResult,
  MemoryDiagnosticsEventPayload,
  MemoryDiagnosticsRendererSnapshot,
  MemoryDiagnosticsSnapshotReason,
  MemoryDiagnosticsSnapshotRequest,
  MemoryDiagnosticsStatus
} from '../../types/diagnostics'

const BYTES_PER_MB = 1024 * 1024
const KB_PER_MB = 1024
const MS_PER_SECOND = 1000
const RENDERER_REQUEST_TIMEOUT_MS = 1200
const IMMEDIATE_SAMPLE_THROTTLE_MS = 1200
const CSV_COLUMNS = [
  'timestamp_iso',
  'timestamp_ms',
  'entry_kind',
  'session_reason',
  'app_version',
  'platform',
  'sample_interval_ms',
  'current_log_path',
  'previous_log_path',
  'window_roles_json',
  'process_labels_json',
  'event_source',
  'event_name',
  'event_track_path',
  'event_source_type',
  'event_session_id',
  'event_message',
  'event_details_json',
  'sample_reason',
  'sample_trigger',
  'sample_index',
  'renderer_snapshot_state',
  'renderer_snapshot_age_ms',
  'main_rss_mb',
  'main_heap_used_mb',
  'main_heap_total_mb',
  'main_external_mb',
  'main_array_buffers_mb',
  'processes_total_cpu_percent',
  'processes_total_working_set_mb',
  'processes_process_count',
  'processes_working_set_by_type_json',
  'processes_working_set_by_label_json',
  'delta_total_working_set_mb',
  'delta_main_rss_mb',
  'delta_renderer_private_mb',
  'delta_audio_buffer_mb',
  'delta_renderer_heap_used_mb',
  'delta_renderer_old_space_mb',
  'delta_track_artwork_mb',
  'delta_waveform_cache_mb',
  'delta_discord_cache_mb',
  'renderer_private_mb',
  'renderer_process_rss_mb',
  'renderer_process_heap_used_mb',
  'renderer_process_heap_total_mb',
  'renderer_process_external_mb',
  'renderer_process_array_buffers_mb',
  'renderer_js_heap_used_mb',
  'renderer_js_heap_total_mb',
  'renderer_js_heap_limit_mb',
  'renderer_v8_old_space_mb',
  'renderer_v8_new_space_mb',
  'renderer_v8_code_space_mb',
  'renderer_v8_map_space_mb',
  'renderer_v8_large_object_space_mb',
  'titlebar_sampled_at_ms',
  'titlebar_sample_age_ms',
  'titlebar_app_footprint_mb',
  'titlebar_app_footprint_source',
  'titlebar_app_footprint_complete',
  'titlebar_app_footprint_failed_pids_json',
  'titlebar_app_footprint_process_count',
  'titlebar_child_process_footprint_mb',
  'titlebar_child_process_count',
  'titlebar_combined_footprint_mb',
  'titlebar_renderer_private_mb',
  'titlebar_app_memory_mb',
  'titlebar_buffer_memory_mb',
  'titlebar_current_buffer_memory_mb',
  'titlebar_next_buffer_memory_mb',
  'titlebar_other_process_memory_mb',
  'titlebar_main_process_memory_mb',
  'titlebar_helper_processes_memory_mb',
  'titlebar_total_private_mb',
  'titlebar_total_working_set_mb',
  'titlebar_peak_captured_at_ms',
  'titlebar_peak_age_ms',
  'titlebar_peak_app_footprint_mb',
  'titlebar_peak_app_footprint_source',
  'titlebar_peak_app_footprint_complete',
  'titlebar_peak_app_footprint_failed_pids_json',
  'titlebar_peak_app_footprint_process_count',
  'titlebar_peak_child_process_footprint_mb',
  'titlebar_peak_child_process_count',
  'titlebar_peak_combined_footprint_mb',
  'titlebar_peak_renderer_private_mb',
  'titlebar_peak_app_memory_mb',
  'titlebar_peak_buffer_memory_mb',
  'titlebar_peak_current_buffer_memory_mb',
  'titlebar_peak_next_buffer_memory_mb',
  'titlebar_peak_other_process_memory_mb',
  'titlebar_peak_total_working_set_mb',
  'dev_gapless_prebuffer_disabled',
  'dev_standard_analysis_graph_disabled',
  'playback_state',
  'current_time_seconds',
  'current_track_path',
  'current_track_source_type',
  'current_track_duration_seconds',
  'current_track_artwork_data_mb',
  'next_track_path',
  'next_track_source_type',
  'audio_playback_output_mode',
  'audio_bitperfect_active',
  'audio_has_context',
  'audio_has_audio_buffer',
  'audio_has_next_buffer',
  'audio_current_buffer_track_path',
  'audio_next_buffer_track_path',
  'audio_current_buffer_mb',
  'audio_next_buffer_mb',
  'audio_total_buffer_mb',
  'audio_native_next_track_buffered',
  'audio_gapless_scheduled',
  'audio_gapless_target_delta_seconds',
  'audio_normalization_approximate',
  'audio_remote_stream_active',
  'audio_remote_stream_session_id',
  'audio_remote_stream_source_type',
  'audio_remote_buffered_seconds',
  'audio_remote_buffered_frames',
  'audio_remote_analyzed_frames',
  'audio_visualizer_consumer_count',
  'audio_pending_visualizer_chunks_total',
  'queue_user_count',
  'queue_auto_count',
  'queue_playback_history_count',
  'queue_playback_future_count',
  'queue_shuffle',
  'queue_repeat',
  'queue_retained_track_count',
  'queue_distinct_retained_track_count',
  'queue_retained_artwork_track_count',
  'queue_retained_artwork_mb',
  'remote_load_stage',
  'remote_load_loaded_mb',
  'remote_load_total_mb',
  'remote_load_percent',
  'remote_load_chunk_count',
  'remote_load_done',
  'remote_load_failed',
  'remote_load_buffered_seconds',
  'remote_load_buffered_percent',
  'remote_load_analyzed_seconds',
  'remote_load_analyzed_percent',
  'remote_load_playable',
  'waveform_cache_entries',
  'waveform_cache_mb',
  'waveform_current_mb',
  'artwork_full_entries',
  'artwork_full_mb',
  'artwork_thumbnail_entries',
  'artwork_thumbnail_mb',
  'artwork_card_entries',
  'artwork_card_mb',
  'artwork_request_count',
  'cover_art_accent_entries',
  'cover_art_accent_mb',
  'discord_enabled',
  'discord_cover_art_enabled',
  'discord_cover_art_entries',
  'discord_cover_art_hit_entries',
  'discord_cover_art_not_found_entries',
  'discord_cover_art_transient_error_entries',
  'discord_cover_art_estimated_mb',
  'discord_cover_art_oldest_entry_age_seconds',
  'discord_cover_art_newest_entry_age_seconds',
  'discord_cover_art_max_entries',
  'discord_pending_lookups',
  'visualizer_is_running',
  'visualizer_fft_size',
  'visualizer_spectrogram_fft_size',
  'visualizer_hidden_scope_count',
  'visualizer_active_scope_count',
  'visualizer_open_scopes_json',
  'visualizer_active_scopes_json',
  'visualizer_mini_mode',
  'scope_popouts_json',
  'library_total_track_count',
  'library_visible_track_count',
  'library_full_track_count',
  'library_album_count',
  'library_artist_count',
  'library_folder_count',
  'library_favorite_count',
  'library_favorite_track_count',
  'library_recently_played_count',
  'library_search_result_count',
  'library_selection_history_count',
  'library_selection_history_track_count',
  'library_selected_detail_track_count',
  'library_scan_in_progress',
  'titlebar_renderer_heap_used_mb',
  'titlebar_renderer_external_mb',
  'titlebar_renderer_array_buffers_mb',
  'titlebar_renderer_old_space_mb',
  'titlebar_renderer_large_object_space_mb',
  'titlebar_main_rss_mb',
  'titlebar_main_heap_used_mb',
  'titlebar_main_external_mb',
  'titlebar_main_array_buffers_mb',
  'titlebar_peak_renderer_heap_used_mb',
  'titlebar_peak_renderer_external_mb',
  'titlebar_peak_renderer_array_buffers_mb',
  'titlebar_peak_renderer_old_space_mb',
  'titlebar_peak_renderer_large_object_space_mb',
  'titlebar_peak_main_rss_mb',
  'titlebar_peak_main_heap_used_mb',
  'titlebar_peak_main_external_mb',
  'titlebar_peak_main_array_buffers_mb'
] as const

type CsvColumn = (typeof CSV_COLUMNS)[number]
type CsvRow = Partial<Record<CsvColumn, unknown>>

interface PendingRendererSnapshotRequest {
  resolve: (result: RendererSnapshotResolution) => void
  timeoutId: ReturnType<typeof setTimeout>
}

interface RendererSnapshotResolution {
  state: 'fresh' | 'stale' | 'missing'
  snapshot: MemoryDiagnosticsRendererSnapshot | null
  ageMs: number | null
}

interface SampleMemorySummary {
  totalWorkingSetMb: number
  mainRssMb: number
  rendererPrivateMb: number | null
  audioBufferMb: number | null
  rendererHeapUsedMb: number | null
  rendererOldSpaceMb: number | null
  trackArtworkMb: number | null
  waveformCacheMb: number | null
  discordCacheMb: number | null
}

interface AppMetricsSummary {
  totalCpuPercent: number
  totalWorkingSetMb: number
  processCount: number
  workingSetMbByType: Record<string, number>
  workingSetMbByLabel: Record<string, number>
}

interface MemoryDiagnosticsCaptureSummary {
  bundleVersion: 1
  capturedAt: number
  completedAt: number
  tag: string | null
  directoryPath: string
  files: {
    summaryPath: string
    heapSnapshotPath: string
  }
  appVersion: string
  platform: NodeJS.Platform
  currentLogPath: string
  previousLogPath: string
  windowRoles: Record<string, unknown>
  processLabels: Record<number, string>
  rendererSnapshotState: RendererSnapshotResolution['state']
  rendererSnapshotAgeMs: number | null
  mainProcessMemory: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    arrayBuffersBytes: number
    rssMb: number | null
    heapUsedMb: number | null
    heapTotalMb: number | null
    externalMb: number | null
    arrayBuffersMb: number | null
  }
  appMetrics: AppMetricsSummary
  performanceMemory: {
    usedJSHeapSize: number | null
    totalJSHeapSize: number | null
    jsHeapSizeLimit: number | null
  } | null
  userAgentSpecificMemory: MemoryDiagnosticsRendererSnapshot['userAgentSpecificMemory']
  blinkResourceUsage: MemoryDiagnosticsRendererSnapshot['blinkResourceUsage']
  rendererSnapshot: MemoryDiagnosticsRendererSnapshot | null
}

export interface MemoryDiagnosticsServiceOptions {
  userDataPath: string
  platform: NodeJS.Platform
  appVersion: string
  sampleIntervalMs: number
  getMainProcessMemoryUsage: () => NodeJS.MemoryUsage
  getAppMetrics: () => ProcessMetric[]
  takeRendererHeapSnapshot: (filePath: string) => Promise<void>
  sendRendererSnapshotRequest: (request: MemoryDiagnosticsSnapshotRequest) => boolean
  getProcessLabels: () => Record<number, string>
  getWindowRoleSummary: () => Record<string, unknown>
  onStatusChange?: (status: MemoryDiagnosticsStatus) => void
}

function sanitizeKeySegment(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return normalized.length > 0 ? normalized : 'value'
}

function roundNumber(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function bytesToMb(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return roundNumber(value / BYTES_PER_MB)
}

function kbToMb(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return roundNumber(value / KB_PER_MB)
}

function msToSeconds(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return roundNumber(value / MS_PER_SECOND)
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return 'null'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function getNumberField(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(roundNumber(value)) : ''
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  const text = typeof value === 'string' ? value : jsonStringify(value)
  return `"${text.replace(/"/g, '""')}"`
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function summarizeAppMetrics(metrics: ProcessMetric[], processLabels: Record<number, string>): AppMetricsSummary {
  const workingSetMbByType: Record<string, number> = {}
  const workingSetMbByLabel: Record<string, number> = {}
  let totalCpuPercent = 0
  let totalWorkingSetMb = 0

  for (const metric of metrics) {
    const typeKey = sanitizeKeySegment(String(metric.type ?? 'unknown'))
    const workingSetMb = kbToMb(metric.memory.workingSetSize)
    const cpuPercent = Number.isFinite(metric.cpu.percentCPUUsage) ? metric.cpu.percentCPUUsage : 0
    const label = processLabels[metric.pid] ?? (
      typeKey === 'tab' || typeKey === 'renderer'
        ? `unmapped_${typeKey}`
        : typeKey
    )
    const labelKey = sanitizeKeySegment(label)

    totalCpuPercent += cpuPercent
    totalWorkingSetMb += workingSetMb
    workingSetMbByType[typeKey] = roundNumber((workingSetMbByType[typeKey] ?? 0) + workingSetMb)
    workingSetMbByLabel[labelKey] = roundNumber((workingSetMbByLabel[labelKey] ?? 0) + workingSetMb)
  }

  return {
    totalCpuPercent: roundNumber(totalCpuPercent),
    totalWorkingSetMb: roundNumber(totalWorkingSetMb),
    processCount: metrics.length,
    workingSetMbByType,
    workingSetMbByLabel
  }
}

function normalizeCaptureTag(tag: string | null | undefined): string | null {
  if (typeof tag !== 'string') return null
  const trimmed = tag.trim()
  return trimmed.length > 0 ? trimmed : null
}

export class MemoryDiagnosticsService {
  private readonly sampleIntervalMs: number
  private readonly logDirPath: string
  private readonly currentLogPath: string
  private readonly previousLogPath: string
  private readonly options: MemoryDiagnosticsServiceOptions
  private enabled = false
  private hasCurrentLog = false
  private hasPreviousLog = false
  private sessionStartedAt: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private immediateSampleTimer: ReturnType<typeof setTimeout> | null = null
  private nextRequestId = 0
  private nextSampleIndex = 0
  private pendingRendererSnapshots = new Map<string, PendingRendererSnapshotRequest>()
  private lastRendererSnapshot: MemoryDiagnosticsRendererSnapshot | null = null
  private lastSampleStartedAt = 0
  private lastSampleSummary: SampleMemorySummary | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private sampleInFlight: Promise<void> | null = null
  private bundleCaptureInFlight: Promise<MemoryDiagnosticsCaptureBundleResult> | null = null
  private pendingImmediateEventName: string | null = null

  constructor(options: MemoryDiagnosticsServiceOptions) {
    this.options = options
    this.sampleIntervalMs = options.sampleIntervalMs
    this.logDirPath = join(options.userDataPath, 'logs')
    this.currentLogPath = join(this.logDirPath, 'memory-diagnostics-current.csv')
    this.previousLogPath = join(this.logDirPath, 'memory-diagnostics-prev.csv')
  }

  getStatus(): MemoryDiagnosticsStatus {
    return {
      enabled: this.enabled,
      sampleIntervalMs: this.sampleIntervalMs,
      currentLogPath: this.currentLogPath,
      previousLogPath: this.previousLogPath,
      hasCurrentLog: this.hasCurrentLog,
      hasPreviousLog: this.hasPreviousLog,
      sessionStartedAt: this.sessionStartedAt
    }
  }

  async initialize(enabled: boolean): Promise<void> {
    await mkdir(this.logDirPath, { recursive: true })
    this.hasCurrentLog = await pathExists(this.currentLogPath)
    this.hasPreviousLog = await pathExists(this.previousLogPath)
    if (enabled) {
      await this.enable('startup')
      return
    }
    this.broadcastStatus()
  }

  async setEnabled(enabled: boolean): Promise<MemoryDiagnosticsStatus> {
    if (enabled) {
      await this.enable('user')
    } else {
      await this.disable('user')
    }
    return this.getStatus()
  }

  async revealCurrentLog(): Promise<boolean> {
    if (!this.hasCurrentLog) return false
    shell.showItemInFolder(this.currentLogPath)
    return true
  }

  async revealPreviousLog(): Promise<boolean> {
    if (!this.hasPreviousLog) return false
    shell.showItemInFolder(this.previousLogPath)
    return true
  }

  async captureMemoryBundle(tag?: string): Promise<MemoryDiagnosticsCaptureBundleResult> {
    if (this.bundleCaptureInFlight) {
      return this.bundleCaptureInFlight
    }

    this.bundleCaptureInFlight = this.doCaptureMemoryBundle(tag)
      .finally(() => {
        this.bundleCaptureInFlight = null
      })

    return this.bundleCaptureInFlight
  }

  async logEvent(payload: MemoryDiagnosticsEventPayload, options: { captureSample?: boolean } = {}): Promise<void> {
    if (!this.enabled) return
    const details = isRecord(payload.details) ? payload.details : null
    await this.appendRow({
      entry_kind: 'EVENT',
      event_source: payload.source,
      event_name: payload.name,
      event_track_path: getStringField(details, 'trackPath'),
      event_source_type: getStringField(details, 'sourceType'),
      event_session_id: getNumberField(details, 'sessionId'),
      event_message: getStringField(details, 'message') ?? getStringField(details, 'statusMessage'),
      event_details_json: details
    })
    if (options.captureSample !== false) {
      this.requestImmediateSample(payload.name)
    }
  }

  publishRendererSnapshot(requestId: string, snapshot: MemoryDiagnosticsRendererSnapshot): void {
    this.lastRendererSnapshot = snapshot
    const pending = this.pendingRendererSnapshots.get(requestId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timeoutId)
    this.pendingRendererSnapshots.delete(requestId)
    pending.resolve({
      state: 'fresh',
      snapshot,
      ageMs: 0
    })
  }

  async shutdown(): Promise<void> {
    this.stopSampling()
    for (const pending of this.pendingRendererSnapshots.values()) {
      clearTimeout(pending.timeoutId)
      pending.resolve({
        state: this.lastRendererSnapshot ? 'stale' : 'missing',
        snapshot: this.lastRendererSnapshot,
        ageMs: this.lastRendererSnapshot ? Math.max(0, Date.now() - this.lastRendererSnapshot.capturedAt) : null
      })
    }
    this.pendingRendererSnapshots.clear()
    await this.writeQueue
  }

  private async enable(reason: 'startup' | 'user'): Promise<void> {
    if (this.enabled) {
      return
    }
    this.enabled = true
    this.nextSampleIndex = 0
    this.lastRendererSnapshot = null
    this.lastSampleSummary = null
    await this.rotateLogs()
    this.sessionStartedAt = Date.now()
    await this.writeCsvHeader()
    this.hasCurrentLog = true
    await this.writeSessionHeader(reason)
    this.startSampling()
    this.broadcastStatus()
    await this.logEvent({
      name: 'diagnostics_enabled',
      source: 'main',
      details: { reason }
    })
    await this.captureSample(reason === 'startup' ? 'startup' : 'event', 'diagnostics_enabled')
  }

  private async disable(reason: 'startup' | 'user'): Promise<void> {
    if (!this.enabled) {
      return
    }
    await this.appendRow({
      entry_kind: 'EVENT',
      event_source: 'main',
      event_name: 'diagnostics_disabled',
      event_message: reason,
      event_details_json: { reason }
    })
    this.enabled = false
    this.sessionStartedAt = null
    this.stopSampling()
    this.broadcastStatus()
  }

  private broadcastStatus(): void {
    this.options.onStatusChange?.(this.getStatus())
  }

  private startSampling(): void {
    this.stopSampling()
    this.timer = setInterval(() => {
      void this.captureSample('timer', 'interval')
    }, this.sampleIntervalMs)
  }

  private stopSampling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.immediateSampleTimer !== null) {
      clearTimeout(this.immediateSampleTimer)
      this.immediateSampleTimer = null
    }
    this.pendingImmediateEventName = null
  }

  private requestImmediateSample(eventName: string): void {
    if (!this.enabled) return
    this.pendingImmediateEventName = eventName
    if (this.immediateSampleTimer !== null) {
      return
    }
    const elapsedMs = Date.now() - this.lastSampleStartedAt
    const delayMs = elapsedMs >= IMMEDIATE_SAMPLE_THROTTLE_MS
      ? 0
      : IMMEDIATE_SAMPLE_THROTTLE_MS - elapsedMs
    this.immediateSampleTimer = setTimeout(() => {
      this.immediateSampleTimer = null
      const pendingEventName = this.pendingImmediateEventName ?? 'event'
      this.pendingImmediateEventName = null
      void this.captureSample('event', pendingEventName)
    }, delayMs)
  }

  private async rotateLogs(): Promise<void> {
    await mkdir(this.logDirPath, { recursive: true })
    if (await pathExists(this.previousLogPath)) {
      await rm(this.previousLogPath, { force: true })
    }
    if (await pathExists(this.currentLogPath)) {
      await rename(this.currentLogPath, this.previousLogPath)
      this.hasPreviousLog = true
    } else {
      this.hasPreviousLog = await pathExists(this.previousLogPath)
    }
  }

  private async writeCsvHeader(): Promise<void> {
    const header = `${CSV_COLUMNS.join(',')}\n`
    await writeFile(this.currentLogPath, header, 'utf-8')
  }

  private async writeSessionHeader(reason: 'startup' | 'user'): Promise<void> {
    await this.appendRow({
      entry_kind: 'SESSION',
      session_reason: reason,
      app_version: this.options.appVersion,
      platform: this.options.platform,
      sample_interval_ms: this.sampleIntervalMs,
      current_log_path: this.currentLogPath,
      previous_log_path: this.previousLogPath,
      window_roles_json: this.options.getWindowRoleSummary(),
      process_labels_json: this.options.getProcessLabels()
    })
  }

  private async captureSample(reason: MemoryDiagnosticsSnapshotReason, trigger: string): Promise<void> {
    if (!this.enabled) return
    if (this.sampleInFlight) {
      return this.sampleInFlight
    }
    this.lastSampleStartedAt = Date.now()
    this.sampleInFlight = this.doCaptureSample(reason, trigger).finally(() => {
      this.sampleInFlight = null
    })
    return this.sampleInFlight
  }

  private async doCaptureSample(reason: MemoryDiagnosticsSnapshotReason, trigger: string): Promise<void> {
    const mainMemory = this.options.getMainProcessMemoryUsage()
    const metricsSummary = summarizeAppMetrics(this.options.getAppMetrics(), this.options.getProcessLabels())
    const rendererResolution = await this.resolveRendererSnapshot(reason)
    const snapshot = rendererResolution.snapshot
    const rowCapturedAt = Date.now()
    const summary: SampleMemorySummary = {
      totalWorkingSetMb: metricsSummary.totalWorkingSetMb,
      mainRssMb: bytesToMb(mainMemory.rss) ?? 0,
      rendererPrivateMb: snapshot?.rendererPrivateMb ?? null,
      audioBufferMb: snapshot ? bytesToMb(snapshot.audio.totalBufferBytes) : null,
      rendererHeapUsedMb: snapshot ? bytesToMb(snapshot.rendererProcessHeapUsedBytes) : null,
      rendererOldSpaceMb: snapshot ? bytesToMb(snapshot.heapSpaces.oldSpaceUsedBytes) : null,
      trackArtworkMb: snapshot ? bytesToMb(snapshot.queue.retainedArtworkDataBytes) : null,
      waveformCacheMb: snapshot ? bytesToMb(snapshot.caches.waveformBytes) : null,
      discordCacheMb: snapshot ? bytesToMb(snapshot.caches.discordCoverArtEstimatedBytes) : null
    }
    const delta = this.computeDelta(summary)
    this.lastSampleSummary = summary
    this.nextSampleIndex += 1

    await this.appendRow({
      entry_kind: 'SAMPLE',
      sample_reason: reason,
      sample_trigger: trigger,
      sample_index: this.nextSampleIndex,
      renderer_snapshot_state: rendererResolution.state,
      renderer_snapshot_age_ms: rendererResolution.ageMs,
      main_rss_mb: bytesToMb(mainMemory.rss),
      main_heap_used_mb: bytesToMb(mainMemory.heapUsed),
      main_heap_total_mb: bytesToMb(mainMemory.heapTotal),
      main_external_mb: bytesToMb(mainMemory.external),
      main_array_buffers_mb: bytesToMb(mainMemory.arrayBuffers),
      processes_total_cpu_percent: metricsSummary.totalCpuPercent,
      processes_total_working_set_mb: metricsSummary.totalWorkingSetMb,
      processes_process_count: metricsSummary.processCount,
      processes_working_set_by_type_json: metricsSummary.workingSetMbByType,
      processes_working_set_by_label_json: metricsSummary.workingSetMbByLabel,
      delta_total_working_set_mb: delta.totalWorkingSetMb,
      delta_main_rss_mb: delta.mainRssMb,
      delta_renderer_private_mb: delta.rendererPrivateMb,
      delta_audio_buffer_mb: delta.audioBufferMb,
      delta_renderer_heap_used_mb: delta.rendererHeapUsedMb,
      delta_renderer_old_space_mb: delta.rendererOldSpaceMb,
      delta_track_artwork_mb: delta.trackArtworkMb,
      delta_waveform_cache_mb: delta.waveformCacheMb,
      delta_discord_cache_mb: delta.discordCacheMb,
      renderer_private_mb: snapshot?.rendererPrivateMb ?? null,
      renderer_process_rss_mb: bytesToMb(snapshot?.rendererProcessRssBytes),
      renderer_process_heap_used_mb: bytesToMb(snapshot?.rendererProcessHeapUsedBytes),
      renderer_process_heap_total_mb: bytesToMb(snapshot?.rendererProcessHeapTotalBytes),
      renderer_process_external_mb: bytesToMb(snapshot?.rendererProcessExternalBytes),
      renderer_process_array_buffers_mb: bytesToMb(snapshot?.rendererProcessArrayBuffersBytes),
      renderer_js_heap_used_mb: bytesToMb(snapshot?.jsHeapUsedBytes),
      renderer_js_heap_total_mb: bytesToMb(snapshot?.jsHeapTotalBytes),
      renderer_js_heap_limit_mb: bytesToMb(snapshot?.jsHeapLimitBytes),
      renderer_v8_old_space_mb: bytesToMb(snapshot?.heapSpaces.oldSpaceUsedBytes),
      renderer_v8_new_space_mb: bytesToMb(snapshot?.heapSpaces.newSpaceUsedBytes),
      renderer_v8_code_space_mb: bytesToMb(snapshot?.heapSpaces.codeSpaceUsedBytes),
      renderer_v8_map_space_mb: bytesToMb(snapshot?.heapSpaces.mapSpaceUsedBytes),
      renderer_v8_large_object_space_mb: bytesToMb(snapshot?.heapSpaces.largeObjectSpaceUsedBytes),
      titlebar_sampled_at_ms: snapshot?.titleBar.sampledAt ?? null,
      titlebar_sample_age_ms: snapshot?.titleBar.sampledAt != null
        ? Math.max(0, rowCapturedAt - snapshot.titleBar.sampledAt)
        : null,
      titlebar_app_footprint_mb: snapshot?.titleBar.appFootprintMb ?? null,
      titlebar_app_footprint_source: snapshot?.titleBar.appFootprintSource ?? null,
      titlebar_app_footprint_complete: snapshot?.titleBar.appFootprintComplete ?? null,
      titlebar_app_footprint_failed_pids_json: snapshot?.titleBar.appFootprintFailedPids ?? null,
      titlebar_app_footprint_process_count: snapshot?.titleBar.appFootprintProcessCount ?? null,
      titlebar_child_process_footprint_mb: snapshot?.titleBar.childProcessFootprintMb ?? null,
      titlebar_child_process_count: snapshot?.titleBar.appFootprintChildProcessCount ?? null,
      titlebar_combined_footprint_mb: snapshot?.titleBar.combinedFootprintMb ?? null,
      titlebar_renderer_private_mb: snapshot?.titleBar.rendererPrivateMb ?? null,
      titlebar_app_memory_mb: snapshot?.titleBar.appMemoryMb ?? null,
      titlebar_buffer_memory_mb: snapshot?.titleBar.bufferMemoryMb ?? null,
      titlebar_current_buffer_memory_mb: snapshot?.titleBar.currentBufferMemoryMb ?? null,
      titlebar_next_buffer_memory_mb: snapshot?.titleBar.nextBufferMemoryMb ?? null,
      titlebar_other_process_memory_mb: snapshot?.titleBar.otherProcessMemoryMb ?? null,
      titlebar_main_process_memory_mb: snapshot?.titleBar.mainProcessMemoryMb ?? null,
      titlebar_helper_processes_memory_mb: snapshot?.titleBar.helperProcessesMemoryMb ?? null,
      titlebar_total_private_mb: snapshot?.titleBar.totalPrivateMb ?? null,
      titlebar_total_working_set_mb: snapshot?.titleBar.totalWorkingSetMb ?? null,
      titlebar_peak_captured_at_ms: snapshot?.titleBarPeaks.capturedAt ?? null,
      titlebar_peak_age_ms: snapshot?.titleBarPeaks.capturedAt != null
        ? Math.max(0, rowCapturedAt - snapshot.titleBarPeaks.capturedAt)
        : null,
      titlebar_peak_app_footprint_mb: snapshot?.titleBarPeaks.appFootprintMb ?? null,
      titlebar_peak_app_footprint_source: snapshot?.titleBarPeaks.appFootprintSource ?? null,
      titlebar_peak_app_footprint_complete: snapshot?.titleBarPeaks.appFootprintComplete ?? null,
      titlebar_peak_app_footprint_failed_pids_json: snapshot?.titleBarPeaks.appFootprintFailedPids ?? null,
      titlebar_peak_app_footprint_process_count: snapshot?.titleBarPeaks.appFootprintProcessCount ?? null,
      titlebar_peak_child_process_footprint_mb: snapshot?.titleBarPeaks.childProcessFootprintMb ?? null,
      titlebar_peak_child_process_count: snapshot?.titleBarPeaks.appFootprintChildProcessCount ?? null,
      titlebar_peak_combined_footprint_mb: snapshot?.titleBarPeaks.combinedFootprintMb ?? null,
      titlebar_peak_renderer_private_mb: snapshot?.titleBarPeaks.rendererPrivateMb ?? null,
      titlebar_peak_app_memory_mb: snapshot?.titleBarPeaks.appMemoryMb ?? null,
      titlebar_peak_buffer_memory_mb: snapshot?.titleBarPeaks.bufferMemoryMb ?? null,
      titlebar_peak_current_buffer_memory_mb: snapshot?.titleBarPeaks.currentBufferMemoryMb ?? null,
      titlebar_peak_next_buffer_memory_mb: snapshot?.titleBarPeaks.nextBufferMemoryMb ?? null,
      titlebar_peak_other_process_memory_mb: snapshot?.titleBarPeaks.otherProcessMemoryMb ?? null,
      titlebar_peak_total_working_set_mb: snapshot?.titleBarPeaks.totalWorkingSetMb ?? null,
      titlebar_renderer_heap_used_mb: snapshot?.titleBar.rendererHeapUsedMb ?? null,
      titlebar_renderer_external_mb: snapshot?.titleBar.rendererExternalMb ?? null,
      titlebar_renderer_array_buffers_mb: snapshot?.titleBar.rendererArrayBuffersMb ?? null,
      titlebar_renderer_old_space_mb: snapshot?.titleBar.rendererOldSpaceMb ?? null,
      titlebar_renderer_large_object_space_mb: snapshot?.titleBar.rendererLargeObjectSpaceMb ?? null,
      titlebar_main_rss_mb: snapshot?.titleBar.mainRssMb ?? null,
      titlebar_main_heap_used_mb: snapshot?.titleBar.mainHeapUsedMb ?? null,
      titlebar_main_external_mb: snapshot?.titleBar.mainExternalMb ?? null,
      titlebar_main_array_buffers_mb: snapshot?.titleBar.mainArrayBuffersMb ?? null,
      titlebar_peak_renderer_heap_used_mb: snapshot?.titleBarPeaks.rendererHeapUsedMb ?? null,
      titlebar_peak_renderer_external_mb: snapshot?.titleBarPeaks.rendererExternalMb ?? null,
      titlebar_peak_renderer_array_buffers_mb: snapshot?.titleBarPeaks.rendererArrayBuffersMb ?? null,
      titlebar_peak_renderer_old_space_mb: snapshot?.titleBarPeaks.rendererOldSpaceMb ?? null,
      titlebar_peak_renderer_large_object_space_mb: snapshot?.titleBarPeaks.rendererLargeObjectSpaceMb ?? null,
      titlebar_peak_main_rss_mb: snapshot?.titleBarPeaks.mainRssMb ?? null,
      titlebar_peak_main_heap_used_mb: snapshot?.titleBarPeaks.mainHeapUsedMb ?? null,
      titlebar_peak_main_external_mb: snapshot?.titleBarPeaks.mainExternalMb ?? null,
      titlebar_peak_main_array_buffers_mb: snapshot?.titleBarPeaks.mainArrayBuffersMb ?? null,
      dev_gapless_prebuffer_disabled: snapshot?.gaplessPrebufferDisabledDev ?? null,
      dev_standard_analysis_graph_disabled: snapshot?.standardAnalysisGraphDisabledDev ?? null,
      playback_state: snapshot?.playbackState ?? null,
      current_time_seconds: snapshot?.currentTimeSeconds ?? null,
      current_track_path: snapshot?.currentTrackPath ?? null,
      current_track_source_type: snapshot?.currentTrackSourceType ?? null,
      current_track_duration_seconds: snapshot?.currentTrackDurationSeconds ?? null,
      current_track_artwork_data_mb: bytesToMb(snapshot?.currentTrackArtworkDataBytes),
      next_track_path: snapshot?.nextTrackPath ?? null,
      next_track_source_type: snapshot?.nextTrackSourceType ?? null,
      audio_playback_output_mode: snapshot?.audio.playbackOutputMode ?? null,
      audio_bitperfect_active: snapshot?.audio.bitPerfectActive ?? null,
      audio_has_context: snapshot?.audio.hasContext ?? null,
      audio_has_audio_buffer: snapshot?.audio.hasAudioBuffer ?? null,
      audio_has_next_buffer: snapshot?.audio.hasNextBuffer ?? null,
      audio_current_buffer_track_path: snapshot?.audio.currentBufferTrackPath ?? null,
      audio_next_buffer_track_path: snapshot?.audio.nextBufferTrackPath ?? null,
      audio_current_buffer_mb: bytesToMb(snapshot?.audio.currentBufferBytes),
      audio_next_buffer_mb: bytesToMb(snapshot?.audio.nextBufferBytes),
      audio_total_buffer_mb: bytesToMb(snapshot?.audio.totalBufferBytes),
      audio_native_next_track_buffered: snapshot?.audio.nativeNextTrackBuffered ?? null,
      audio_gapless_scheduled: snapshot?.audio.gaplessScheduled ?? null,
      audio_gapless_target_delta_seconds: snapshot?.audio.gaplessTargetDeltaSeconds ?? null,
      audio_normalization_approximate: snapshot?.audio.normalizationApproximate ?? null,
      audio_remote_stream_active: snapshot?.audio.remoteStreamActive ?? null,
      audio_remote_stream_session_id: snapshot?.audio.remoteStreamSessionId ?? null,
      audio_remote_stream_source_type: snapshot?.audio.remoteStreamSourceType ?? null,
      audio_remote_buffered_seconds: snapshot?.audio.remoteBufferedSeconds ?? null,
      audio_remote_buffered_frames: snapshot?.audio.remoteBufferedFrames ?? null,
      audio_remote_analyzed_frames: snapshot?.audio.remoteAnalyzedFrames ?? null,
      audio_visualizer_consumer_count: snapshot?.audio.visualizerConsumerCount ?? null,
      audio_pending_visualizer_chunks_total: snapshot?.audio.pendingVisualizerChunksTotal ?? null,
      queue_user_count: snapshot?.queue.userQueueCount ?? null,
      queue_auto_count: snapshot?.queue.autoQueueCount ?? null,
      queue_playback_history_count: snapshot?.queue.playbackHistoryCount ?? null,
      queue_playback_future_count: snapshot?.queue.playbackFutureCount ?? null,
      queue_shuffle: snapshot?.queue.shuffle ?? null,
      queue_repeat: snapshot?.queue.repeat ?? null,
      queue_retained_track_count: snapshot?.queue.retainedTrackCount ?? null,
      queue_distinct_retained_track_count: snapshot?.queue.distinctRetainedTrackCount ?? null,
      queue_retained_artwork_track_count: snapshot?.queue.retainedArtworkTrackCount ?? null,
      queue_retained_artwork_mb: bytesToMb(snapshot?.queue.retainedArtworkDataBytes),
      remote_load_stage: snapshot?.remoteLoad?.stage ?? null,
      remote_load_loaded_mb: bytesToMb(snapshot?.remoteLoad?.loadedBytes),
      remote_load_total_mb: bytesToMb(snapshot?.remoteLoad?.totalBytes),
      remote_load_percent: snapshot?.remoteLoad?.percent ?? null,
      remote_load_chunk_count: snapshot?.remoteLoad?.chunkCount ?? null,
      remote_load_done: snapshot?.remoteLoad?.done ?? null,
      remote_load_failed: snapshot?.remoteLoad?.failed ?? null,
      remote_load_buffered_seconds: snapshot?.remoteLoad?.bufferedSeconds ?? null,
      remote_load_buffered_percent: snapshot?.remoteLoad?.bufferedPercent ?? null,
      remote_load_analyzed_seconds: snapshot?.remoteLoad?.analyzedSeconds ?? null,
      remote_load_analyzed_percent: snapshot?.remoteLoad?.analyzedPercent ?? null,
      remote_load_playable: snapshot?.remoteLoad?.playable ?? null,
      waveform_cache_entries: snapshot?.caches.waveformEntries ?? null,
      waveform_cache_mb: bytesToMb(snapshot?.caches.waveformBytes),
      waveform_current_mb: bytesToMb(snapshot?.caches.currentWaveformBytes),
      artwork_full_entries: snapshot?.caches.artworkFullEntries ?? null,
      artwork_full_mb: bytesToMb(snapshot?.caches.artworkFullBytes),
      artwork_thumbnail_entries: snapshot?.caches.artworkThumbnailEntries ?? null,
      artwork_thumbnail_mb: bytesToMb(snapshot?.caches.artworkThumbnailBytes),
      artwork_card_entries: snapshot?.caches.artworkCardEntries ?? null,
      artwork_card_mb: bytesToMb(snapshot?.caches.artworkCardBytes),
      artwork_request_count: snapshot?.caches.artworkRequests ?? null,
      cover_art_accent_entries: snapshot?.caches.coverArtAccentEntries ?? null,
      cover_art_accent_mb: bytesToMb(snapshot?.caches.coverArtAccentBytes),
      discord_enabled: snapshot?.discordEnabled ?? null,
      discord_cover_art_enabled: snapshot?.discordCoverArtEnabled ?? null,
      discord_cover_art_entries: snapshot?.caches.discordCoverArtEntries ?? null,
      discord_cover_art_hit_entries: snapshot?.caches.discordCoverArtHitEntries ?? null,
      discord_cover_art_not_found_entries: snapshot?.caches.discordCoverArtNotFoundEntries ?? null,
      discord_cover_art_transient_error_entries: snapshot?.caches.discordCoverArtTransientErrorEntries ?? null,
      discord_cover_art_estimated_mb: bytesToMb(snapshot?.caches.discordCoverArtEstimatedBytes),
      discord_cover_art_oldest_entry_age_seconds: msToSeconds(snapshot?.caches.discordCoverArtOldestEntryAgeMs),
      discord_cover_art_newest_entry_age_seconds: msToSeconds(snapshot?.caches.discordCoverArtNewestEntryAgeMs),
      discord_cover_art_max_entries: snapshot?.caches.discordCoverArtMaxEntries ?? null,
      discord_pending_lookups: snapshot?.caches.discordPendingLookups ?? null,
      visualizer_is_running: snapshot?.visualizer.isRunning ?? null,
      visualizer_fft_size: snapshot?.visualizer.fftSize ?? null,
      visualizer_spectrogram_fft_size: snapshot?.visualizer.spectrogramFftSize ?? null,
      visualizer_hidden_scope_count: snapshot?.visualizer.hiddenScopeCount ?? null,
      visualizer_active_scope_count: snapshot?.visualizer.activeScopeCount ?? null,
      visualizer_open_scopes_json: snapshot?.visualizer.openScopes ?? null,
      visualizer_active_scopes_json: snapshot?.visualizer.activeScopes ?? null,
      visualizer_mini_mode: snapshot?.visualizer.miniVisualizerMode ?? null,
      scope_popouts_json: snapshot?.scopePopouts ?? null,
      library_total_track_count: snapshot?.library.totalTrackCount ?? null,
      library_visible_track_count: snapshot?.library.visibleTrackCount ?? null,
      library_full_track_count: snapshot?.library.fullTrackCount ?? null,
      library_album_count: snapshot?.library.albumCount ?? null,
      library_artist_count: snapshot?.library.artistCount ?? null,
      library_folder_count: snapshot?.library.folderCount ?? null,
      library_favorite_count: snapshot?.library.favoriteCount ?? null,
      library_favorite_track_count: snapshot?.library.favoriteTrackCount ?? null,
      library_recently_played_count: snapshot?.library.recentlyPlayedCount ?? null,
      library_search_result_count: snapshot?.library.searchResultCount ?? null,
      library_selection_history_count: snapshot?.library.selectionHistoryCount ?? null,
      library_selection_history_track_count: snapshot?.library.selectionHistoryTrackCount ?? null,
      library_selected_detail_track_count: snapshot?.library.selectedDetailTrackCount ?? null,
      library_scan_in_progress: snapshot?.library.scanInProgress ?? null
    })
  }

  private async doCaptureMemoryBundle(tag?: string): Promise<MemoryDiagnosticsCaptureBundleResult> {
    await mkdir(this.logDirPath, { recursive: true })

    const capturedAt = Date.now()
    const normalizedTag = normalizeCaptureTag(tag)
    const timestampSegment = new Date(capturedAt).toISOString().replace(/[.:]/g, '-')
    const directoryName = normalizedTag
      ? `${timestampSegment}-${sanitizeKeySegment(normalizedTag)}`
      : timestampSegment
    const directoryPath = join(this.logDirPath, 'memory-diagnostics-bundles', directoryName)
    const summaryPath = join(directoryPath, 'summary.json')
    const heapSnapshotPath = join(directoryPath, 'renderer.heapsnapshot')
    const processLabels = this.options.getProcessLabels()
    const windowRoles = this.options.getWindowRoleSummary()
    const mainMemory = this.options.getMainProcessMemoryUsage()
    const appMetrics = summarizeAppMetrics(this.options.getAppMetrics(), processLabels)
    const rendererResolution = await this.resolveRendererSnapshot('event')
    const rendererSnapshot = rendererResolution.snapshot

    await mkdir(directoryPath, { recursive: true })
    await this.options.takeRendererHeapSnapshot(heapSnapshotPath)

    const completedAt = Date.now()
    const summary: MemoryDiagnosticsCaptureSummary = {
      bundleVersion: 1,
      capturedAt,
      completedAt,
      tag: normalizedTag,
      directoryPath,
      files: {
        summaryPath,
        heapSnapshotPath
      },
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      currentLogPath: this.currentLogPath,
      previousLogPath: this.previousLogPath,
      windowRoles,
      processLabels,
      rendererSnapshotState: rendererResolution.state,
      rendererSnapshotAgeMs: rendererResolution.ageMs,
      mainProcessMemory: {
        rssBytes: mainMemory.rss,
        heapUsedBytes: mainMemory.heapUsed,
        heapTotalBytes: mainMemory.heapTotal,
        externalBytes: mainMemory.external,
        arrayBuffersBytes: mainMemory.arrayBuffers,
        rssMb: bytesToMb(mainMemory.rss),
        heapUsedMb: bytesToMb(mainMemory.heapUsed),
        heapTotalMb: bytesToMb(mainMemory.heapTotal),
        externalMb: bytesToMb(mainMemory.external),
        arrayBuffersMb: bytesToMb(mainMemory.arrayBuffers)
      },
      appMetrics,
      performanceMemory: rendererSnapshot
        ? {
            usedJSHeapSize: rendererSnapshot.jsHeapUsedBytes,
            totalJSHeapSize: rendererSnapshot.jsHeapTotalBytes,
            jsHeapSizeLimit: rendererSnapshot.jsHeapLimitBytes
          }
        : null,
      userAgentSpecificMemory: rendererSnapshot?.userAgentSpecificMemory ?? null,
      blinkResourceUsage: rendererSnapshot?.blinkResourceUsage ?? null,
      rendererSnapshot
    }

    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')

    return {
      capturedAt,
      tag: normalizedTag,
      directoryPath,
      summaryPath,
      heapSnapshotPath,
      files: [summaryPath, heapSnapshotPath]
    }
  }

  private computeDelta(next: SampleMemorySummary): Record<string, number | null> {
    const previous = this.lastSampleSummary
    if (!previous) {
      return {
        totalWorkingSetMb: null,
        mainRssMb: null,
        rendererPrivateMb: null,
        audioBufferMb: null,
        rendererHeapUsedMb: null,
        rendererOldSpaceMb: null,
        trackArtworkMb: null,
        waveformCacheMb: null,
        discordCacheMb: null
      }
    }
    return {
      totalWorkingSetMb: roundNumber(next.totalWorkingSetMb - previous.totalWorkingSetMb),
      mainRssMb: roundNumber(next.mainRssMb - previous.mainRssMb),
      rendererPrivateMb: next.rendererPrivateMb === null || previous.rendererPrivateMb === null
        ? null
        : roundNumber(next.rendererPrivateMb - previous.rendererPrivateMb),
      audioBufferMb: next.audioBufferMb === null || previous.audioBufferMb === null
        ? null
        : roundNumber(next.audioBufferMb - previous.audioBufferMb),
      rendererHeapUsedMb: next.rendererHeapUsedMb === null || previous.rendererHeapUsedMb === null
        ? null
        : roundNumber(next.rendererHeapUsedMb - previous.rendererHeapUsedMb),
      rendererOldSpaceMb: next.rendererOldSpaceMb === null || previous.rendererOldSpaceMb === null
        ? null
        : roundNumber(next.rendererOldSpaceMb - previous.rendererOldSpaceMb),
      trackArtworkMb: next.trackArtworkMb === null || previous.trackArtworkMb === null
        ? null
        : roundNumber(next.trackArtworkMb - previous.trackArtworkMb),
      waveformCacheMb: next.waveformCacheMb === null || previous.waveformCacheMb === null
        ? null
        : roundNumber(next.waveformCacheMb - previous.waveformCacheMb),
      discordCacheMb: next.discordCacheMb === null || previous.discordCacheMb === null
        ? null
        : roundNumber(next.discordCacheMb - previous.discordCacheMb)
    }
  }

  private async resolveRendererSnapshot(reason: MemoryDiagnosticsSnapshotReason): Promise<RendererSnapshotResolution> {
    const requestId = `renderer-${Date.now()}-${this.nextRequestId += 1}`
    const request: MemoryDiagnosticsSnapshotRequest = {
      requestId,
      reason,
      requestedAt: Date.now()
    }
    const dispatched = this.options.sendRendererSnapshotRequest(request)
    if (!dispatched) {
      return this.buildFallbackRendererSnapshot()
    }

    return new Promise<RendererSnapshotResolution>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingRendererSnapshots.delete(requestId)
        resolve(this.buildFallbackRendererSnapshot())
      }, RENDERER_REQUEST_TIMEOUT_MS)
      this.pendingRendererSnapshots.set(requestId, { resolve, timeoutId })
    })
  }

  private buildFallbackRendererSnapshot(): RendererSnapshotResolution {
    if (!this.lastRendererSnapshot) {
      return {
        state: 'missing',
        snapshot: null,
        ageMs: null
      }
    }
    return {
      state: 'stale',
      snapshot: this.lastRendererSnapshot,
      ageMs: Math.max(0, Date.now() - this.lastRendererSnapshot.capturedAt)
    }
  }

  private appendRow(row: CsvRow): Promise<void> {
    const timestamp = new Date()
    const fullRow: CsvRow = {
      timestamp_iso: timestamp.toISOString(),
      timestamp_ms: timestamp.getTime(),
      ...row
    }
    const line = `${CSV_COLUMNS.map((column) => toCsvCell(fullRow[column])).join(',')}\n`

    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.currentLogPath, line, 'utf-8'))
      .catch((error) => {
        console.warn('Failed to write memory diagnostics log entry:', error)
      })

    return this.writeQueue
  }
}
