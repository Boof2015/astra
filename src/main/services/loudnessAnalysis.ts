export const LOUDNESS_FFMPEG_MAX_STDERR_BYTES = 1024 * 1024

export type LoudnessAnalysisPriority = 'interactive' | 'background'

export function buildEbur128Args(filePath: string): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-i', filePath,
    '-map', '0:a:0',
    '-vn',
    '-af', 'ebur128=peak=sample:framelog=verbose',
    '-f', 'null', '-'
  ]
}

// Parse the summary block ffmpeg's ebur128 filter prints at the end of stderr.
// Use the last match so the parser remains safe if a future ffmpeg build emits
// another ebur128 block before the final summary.
export function parseEbur128Summary(stderr: string): { loudnessLufs: number; peakLinear: number | null } | null {
  const integratedMatches = [...stderr.matchAll(/^\s+I:\s+(-?[\d.]+)\s+LUFS\s*$/gm)]
  const lastIntegrated = integratedMatches[integratedMatches.length - 1]
  if (!lastIntegrated) return null
  const loudnessLufs = Number(lastIntegrated[1])
  if (!Number.isFinite(loudnessLufs)) return null

  const peakMatches = [...stderr.matchAll(/^\s+Peak:\s+(-?[\d.]+|-?inf)\s+dBFS\s*$/gm)]
  const lastPeak = peakMatches[peakMatches.length - 1]
  let peakLinear: number | null = null
  if (lastPeak) {
    if (lastPeak[1] === '-inf') {
      peakLinear = 0
    } else {
      const peakDb = Number(lastPeak[1])
      if (Number.isFinite(peakDb)) {
        peakLinear = Math.pow(10, peakDb / 20)
      }
    }
  }

  return { loudnessLufs, peakLinear }
}

export interface LoudnessJobRunContext {
  signal: AbortSignal
  priority: LoudnessAnalysisPriority
  initialPriority: LoudnessAnalysisPriority
  attempt: number
  queueDepthAtStart: number
  wasPromoted: boolean
}

export interface LoudnessJobDiagnostics {
  key: string
  initialPriority: LoudnessAnalysisPriority
  finalPriority: LoudnessAnalysisPriority
  wasPromoted: boolean
  wasAborted: boolean
  attempts: number
  queueDepthAtStart: number
  durationMs: number
}

interface LoudnessJob<TPayload, TResult> {
  key: string
  payload: TPayload
  initialPriority: LoudnessAnalysisPriority
  priority: LoudnessAnalysisPriority
  abortController: AbortController
  restartAfterPromotion: boolean
  wasPromoted: boolean
  wasAborted: boolean
  attempts: number
  queueDepthAtStart: number
  startedAtMs: number | null
  promise: Promise<TResult>
  resolve: (result: TResult) => void
  reject: (error: unknown) => void
}

export interface LoudnessJobQueueOptions<TPayload, TResult> {
  run: (payload: TPayload, context: LoudnessJobRunContext) => Promise<TResult>
  createAbortedResult: () => TResult
  onSettled?: (diagnostics: LoudnessJobDiagnostics, result: TResult | undefined, error: unknown) => void
}

// A single-worker, path-deduplicated priority queue for loudness scans. An
// interactive request promotes a queued background job. If that job is already
// running, its low-priority process is aborted and the same promise is retried
// interactively, avoiding both duplicate work and priority-inversion stalls.
export class LoudnessAnalysisJobQueue<TPayload, TResult> {
  private readonly jobsByKey = new Map<string, LoudnessJob<TPayload, TResult>>()
  private readonly queue: LoudnessJob<TPayload, TResult>[] = []
  private readonly options: LoudnessJobQueueOptions<TPayload, TResult>
  private activeJob: LoudnessJob<TPayload, TResult> | null = null

  constructor(options: LoudnessJobQueueOptions<TPayload, TResult>) {
    this.options = options
  }

  enqueue(key: string, payload: TPayload, priority: LoudnessAnalysisPriority): Promise<TResult> {
    const existing = this.jobsByKey.get(key)
    if (existing) {
      if (priority === 'interactive') this.promote(existing)
      return existing.promise
    }

    let resolveJob!: (result: TResult) => void
    let rejectJob!: (error: unknown) => void
    const promise = new Promise<TResult>((resolve, reject) => {
      resolveJob = resolve
      rejectJob = reject
    })
    const job: LoudnessJob<TPayload, TResult> = {
      key,
      payload,
      initialPriority: priority,
      priority,
      abortController: new AbortController(),
      restartAfterPromotion: false,
      wasPromoted: false,
      wasAborted: false,
      attempts: 0,
      queueDepthAtStart: 0,
      startedAtMs: null,
      promise,
      resolve: resolveJob,
      reject: rejectJob
    }

    this.jobsByKey.set(key, job)
    if (priority === 'interactive') {
      this.queue.unshift(job)
      this.abortUnrelatedBackgroundJob(job)
    } else {
      this.queue.push(job)
    }
    this.pump()
    return promise
  }

  private promote(job: LoudnessJob<TPayload, TResult>): void {
    if (job.priority === 'interactive') return

    job.priority = 'interactive'
    job.wasPromoted = true
    if (this.activeJob === job) {
      job.restartAfterPromotion = true
      job.wasAborted = true
      job.abortController.abort()
      return
    }

    const queuedIndex = this.queue.indexOf(job)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      this.queue.unshift(job)
    }
    this.abortUnrelatedBackgroundJob(job)
  }

  private abortUnrelatedBackgroundJob(incomingJob: LoudnessJob<TPayload, TResult>): void {
    const active = this.activeJob
    if (!active || active === incomingJob || active.priority !== 'background') return
    active.wasAborted = true
    active.abortController.abort()
  }

  private pump(): void {
    if (this.activeJob) return
    const job = this.queue.shift()
    if (!job) return

    this.activeJob = job
    job.startedAtMs = Date.now()
    job.queueDepthAtStart = this.queue.length
    void this.runJob(job)
      .then(
        (result) => {
          this.finishJob(job)
          job.resolve(result)
        },
        (error) => {
          this.finishJob(job)
          job.reject(error)
        }
      )
  }

  private finishJob(job: LoudnessJob<TPayload, TResult>): void {
    if (this.jobsByKey.get(job.key) === job) this.jobsByKey.delete(job.key)
    if (this.activeJob === job) this.activeJob = null
    this.pump()
  }

  private async runJob(job: LoudnessJob<TPayload, TResult>): Promise<TResult> {
    let result: TResult | undefined
    let settledError: unknown

    try {
      while (true) {
        job.attempts += 1
        const currentController = job.abortController
        try {
          result = await this.options.run(job.payload, {
            signal: currentController.signal,
            priority: job.priority,
            initialPriority: job.initialPriority,
            attempt: job.attempts,
            queueDepthAtStart: job.queueDepthAtStart,
            wasPromoted: job.wasPromoted
          })
          return result
        } catch (error) {
          if (!currentController.signal.aborted) throw error
          if (!job.restartAfterPromotion) {
            result = this.options.createAbortedResult()
            return result
          }

          job.restartAfterPromotion = false
          job.abortController = new AbortController()
        }
      }
    } catch (error) {
      settledError = error
      throw error
    } finally {
      this.options.onSettled?.({
        key: job.key,
        initialPriority: job.initialPriority,
        finalPriority: job.priority,
        wasPromoted: job.wasPromoted,
        wasAborted: job.wasAborted,
        attempts: job.attempts,
        queueDepthAtStart: job.queueDepthAtStart,
        durationMs: Date.now() - (job.startedAtMs ?? Date.now())
      }, result, settledError)
    }
  }
}
