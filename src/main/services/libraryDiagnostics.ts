import { mkdir, open, rename, rm, stat } from 'fs/promises'
import { closeSync, fsyncSync, openSync, writeSync } from 'fs'
import { join } from 'path'
import {
  LIBRARY_DIAGNOSTICS_SCHEMA_VERSION,
  type LibraryDiagnosticsStatus
} from '../../types/libraryDiagnostics'

const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1_000
const EVENT_LOOP_STALL_THRESHOLD_MS = 250

type JsonPrimitive = string | number | boolean | null
type SanitizedValue = JsonPrimitive | SanitizedValue[] | { [key: string]: SanitizedValue }

export interface LibraryDiagnosticsServiceOptions {
  userDataPath: string
  getSessionDetails: () => Record<string, unknown>
  showItemInFolder?: (path: string) => void
  onStatusChange?: (status: LibraryDiagnosticsStatus) => void
  now?: () => number
}

export interface LibraryDiagnosticsLogRecord {
  schemaVersion: number
  timestamp: string
  timestampMs: number
  sessionId: string
  event: string
  runId: string | null
  details: Record<string, SanitizedValue> | null
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|_)(?:path|paths|directory|directories|file|files|file_name|file_names|folder|folders|folder_name|folder_names)$/i.test(key)
    || /(?:Path|Paths|Directory|Directories|File|Files|FileName|FileNames|Folder|Folders|FolderName|FolderNames)$/i.test(key)
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^\//.test(value)
    || value.includes('\\')
    || value.includes('/')
}

function sanitizeNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function sanitizeValue(value: unknown, depth = 0): SanitizedValue | undefined {
  if (depth > 6) return undefined
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return sanitizeNumber(value)
  if (typeof value === 'string') {
    if (looksLikeAbsolutePath(value)) return '[redacted-path]'
    return value.length <= 512 ? value : `${value.slice(0, 509)}...`
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 256)
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry): entry is SanitizedValue => entry !== undefined)
  }
  if (!value || typeof value !== 'object') return undefined

  const sanitized: Record<string, SanitizedValue> = {}
  for (const [key, entry] of Object.entries(value).slice(0, 256)) {
    if (isSensitiveKey(key)) continue
    const next = sanitizeValue(entry, depth + 1)
    if (next !== undefined) sanitized[key] = next
  }
  return sanitized
}

function sanitizeDetails(details?: Record<string, unknown>): Record<string, SanitizedValue> | null {
  if (!details) return null
  const sanitized = sanitizeValue(details)
  return sanitized && !Array.isArray(sanitized) && typeof sanitized === 'object'
    ? sanitized
    : null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function createSessionId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000
}

export class LibraryDiagnosticsService {
  private readonly options: LibraryDiagnosticsServiceOptions
  private readonly logDirPath: string
  private readonly currentLogPath: string
  private readonly previousLogPath: string
  private readonly now: () => number
  private enabled = false
  private hasCurrentLog = false
  private hasPreviousLog = false
  private sessionStartedAt: number | null = null
  private sessionId = ''
  private writeQueue: Promise<boolean> = Promise.resolve(true)
  private eventLoopTimer: ReturnType<typeof setInterval> | null = null
  private expectedEventLoopSampleAt = 0

  constructor(options: LibraryDiagnosticsServiceOptions) {
    this.options = options
    this.logDirPath = join(options.userDataPath, 'logs')
    this.currentLogPath = join(this.logDirPath, 'library-diagnostics-current.jsonl')
    this.previousLogPath = join(this.logDirPath, 'library-diagnostics-prev.jsonl')
    this.now = options.now ?? Date.now
  }

  getStatus(): LibraryDiagnosticsStatus {
    return {
      enabled: this.enabled,
      schemaVersion: LIBRARY_DIAGNOSTICS_SCHEMA_VERSION,
      currentLogPath: this.currentLogPath,
      previousLogPath: this.previousLogPath,
      hasCurrentLog: this.hasCurrentLog,
      hasPreviousLog: this.hasPreviousLog,
      sessionStartedAt: this.sessionStartedAt
    }
  }

  async initialize(enabled: boolean): Promise<void> {
    try {
      await mkdir(this.logDirPath, { recursive: true })
      this.hasCurrentLog = await pathExists(this.currentLogPath)
      this.hasPreviousLog = await pathExists(this.previousLogPath)
    } catch (error) {
      console.warn('Failed to initialize library diagnostics directory:', error)
    }

    if (enabled) {
      await this.enable('startup')
    } else {
      this.broadcastStatus()
    }
  }

  async setEnabled(enabled: boolean): Promise<LibraryDiagnosticsStatus> {
    if (enabled) await this.enable('user')
    else await this.disable('user')
    return this.getStatus()
  }

  async logEvent(
    event: string,
    details?: Record<string, unknown>,
    runId?: string | null,
    options: { flush?: boolean } = {}
  ): Promise<boolean> {
    if (!this.enabled) return false
    let record: LibraryDiagnosticsLogRecord
    try {
      record = this.createRecord(event, details, runId)
    } catch (error) {
      console.warn('Failed to prepare library diagnostics record:', error)
      return false
    }
    this.writeQueue = this.writeQueue
      .catch(() => false)
      .then(() => this.appendRecord(record, options.flush === true))
    return this.writeQueue
  }

  logCheckpointSync(event: string, details?: Record<string, unknown>, runId?: string | null): boolean {
    if (!this.enabled || !this.hasCurrentLog) return false
    let fileDescriptor: number | null = null
    try {
      fileDescriptor = openSync(this.currentLogPath, 'a')
      writeSync(fileDescriptor, `${JSON.stringify(this.createRecord(event, details, runId))}\n`, null, 'utf8')
      fsyncSync(fileDescriptor)
      return true
    } catch (error) {
      console.warn('Failed to write synchronous library diagnostics checkpoint:', error)
      return false
    } finally {
      if (fileDescriptor !== null) {
        try {
          closeSync(fileDescriptor)
        } catch {
          // The checkpoint is best-effort and must never affect folder removal.
        }
      }
    }
  }

  async revealCurrentLog(): Promise<boolean> {
    if (!this.hasCurrentLog || !this.options.showItemInFolder) return false
    this.options.showItemInFolder(this.currentLogPath)
    return true
  }

  async revealPreviousLog(): Promise<boolean> {
    if (!this.hasPreviousLog || !this.options.showItemInFolder) return false
    this.options.showItemInFolder(this.previousLogPath)
    return true
  }

  async shutdown(): Promise<void> {
    this.stopEventLoopSampling()
    await this.writeQueue.catch(() => false)
  }

  private async enable(reason: 'startup' | 'user'): Promise<void> {
    if (this.enabled) return

    try {
      await mkdir(this.logDirPath, { recursive: true })
      await rm(this.previousLogPath, { force: true })
      if (await pathExists(this.currentLogPath)) {
        await rename(this.currentLogPath, this.previousLogPath)
        this.hasPreviousLog = true
      }
      this.enabled = true
      this.sessionStartedAt = this.now()
      this.sessionId = createSessionId(this.sessionStartedAt)
      this.hasCurrentLog = false
      const sessionStarted = await this.logEvent('session_started', {
        reason,
        ...this.options.getSessionDetails()
      }, null, { flush: true })
      if (!sessionStarted) {
        this.enabled = false
        this.sessionStartedAt = null
        this.sessionId = ''
        this.stopEventLoopSampling()
        this.broadcastStatus()
        return
      }
      this.startEventLoopSampling()
    } catch (error) {
      this.enabled = false
      this.sessionStartedAt = null
      console.warn('Failed to enable library diagnostics:', error)
    }
    this.broadcastStatus()
  }

  private async disable(reason: 'startup' | 'user'): Promise<void> {
    if (!this.enabled) return
    await this.logEvent('session_stopped', { reason })
    this.enabled = false
    this.sessionStartedAt = null
    this.stopEventLoopSampling()
    this.broadcastStatus()
  }

  private createRecord(
    event: string,
    details?: Record<string, unknown>,
    runId?: string | null
  ): LibraryDiagnosticsLogRecord {
    const timestampMs = this.now()
    return {
      schemaVersion: LIBRARY_DIAGNOSTICS_SCHEMA_VERSION,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      sessionId: this.sessionId,
      event: typeof event === 'string' && event.trim() ? event.trim().slice(0, 120) : 'unknown',
      runId: typeof runId === 'string' && runId.trim() ? runId.trim().slice(0, 128) : null,
      details: sanitizeDetails(details)
    }
  }

  private async appendRecord(record: LibraryDiagnosticsLogRecord, flush: boolean): Promise<boolean> {
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      fileHandle = await open(this.currentLogPath, 'a')
      await fileHandle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      if (flush) await fileHandle.sync()
      const statusChanged = !this.hasCurrentLog
      this.hasCurrentLog = true
      if (statusChanged) this.broadcastStatus()
      return true
    } catch (error) {
      console.warn('Failed to append library diagnostics record:', error)
      return false
    } finally {
      if (fileHandle) {
        try {
          await fileHandle.close()
        } catch {
          // Logging cleanup remains best-effort.
        }
      }
    }
  }

  private startEventLoopSampling(): void {
    this.stopEventLoopSampling()
    this.expectedEventLoopSampleAt = monotonicNowMs() + EVENT_LOOP_SAMPLE_INTERVAL_MS
    this.eventLoopTimer = setInterval(() => {
      const sampledAt = monotonicNowMs()
      const lagMs = Math.max(0, sampledAt - this.expectedEventLoopSampleAt)
      this.expectedEventLoopSampleAt = sampledAt + EVENT_LOOP_SAMPLE_INTERVAL_MS
      if (lagMs >= EVENT_LOOP_STALL_THRESHOLD_MS) {
        void this.logEvent('main_event_loop_stall', { lagMs })
      }
    }, EVENT_LOOP_SAMPLE_INTERVAL_MS)
    this.eventLoopTimer.unref?.()
  }

  private stopEventLoopSampling(): void {
    if (this.eventLoopTimer !== null) {
      clearInterval(this.eventLoopTimer)
      this.eventLoopTimer = null
    }
  }

  private broadcastStatus(): void {
    try {
      this.options.onStatusChange?.(this.getStatus())
    } catch (error) {
      console.warn('Library diagnostics status callback failed:', error)
    }
  }
}
