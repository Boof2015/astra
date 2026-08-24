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
  readonly priority: LoudnessAnalysisPriority
  initialPriority: LoudnessAnalysisPriority
  attempt: number
  queueDepthAtStart: number
  wasPromoted: boolean
  onPriorityChanged: (listener: (priority: LoudnessAnalysisPriority) => void) => () => void
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
  priorityListeners: Set<(priority: LoudnessAnalysisPriority) => void>
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
// interactive request promotes matching background work in place. Running jobs
// expose a priority-change hook so callers can best-effort reprioritize their
// worker without throwing away completed analysis. Unrelated interactive work
// is latest-wins: queued jobs are settled as aborted and an active job receives
// an abort signal before the newest request runs.
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
      if (priority === 'interactive') {
        this.promote(existing)
        this.cancelQueuedInteractiveJobs(existing)
        this.abortUnrelatedActiveJob(existing)
      }
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
      priorityListeners: new Set(),
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
      this.cancelQueuedInteractiveJobs(job)
      this.queue.unshift(job)
      this.abortUnrelatedActiveJob(job)
    } else {
      this.queue.push(job)
    }
    this.pump()
    return promise
  }

  supersedeInteractiveExcept(key: string): void {
    const matching = this.jobsByKey.get(key) ?? null
    if (matching) this.promote(matching)

    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index]
      if (queued === matching || queued.priority !== 'interactive') continue
      this.queue.splice(index, 1)
      this.settleQueuedJobAsAborted(queued)
    }

    const active = this.activeJob
    if (
      active
      && active !== matching
      && active.priority === 'interactive'
      && !active.abortController.signal.aborted
    ) {
      active.wasAborted = true
      active.abortController.abort()
    }
  }

  private promote(job: LoudnessJob<TPayload, TResult>): void {
    if (job.priority === 'interactive') {
      // A -> B -> A can revisit the still-active A job after B has canceled it.
      // Treat that matching request as the newest intent and restart A with a fresh
      // controller instead of resolving the shared promise as aborted.
      if (this.activeJob === job && job.abortController.signal.aborted) {
        job.restartAfterPromotion = true
      }
      return
    }

    job.priority = 'interactive'
    job.wasPromoted = true
    if (this.activeJob === job) {
      // A prior, unrelated interactive request may already have cancelled this
      // background run. Only that edge case needs a retry; ordinary promotion
      // keeps the exact in-progress analysis and its promise intact.
      if (job.abortController.signal.aborted) job.restartAfterPromotion = true
      this.notifyPriorityChanged(job)
      return
    }

    const queuedIndex = this.queue.indexOf(job)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      this.queue.unshift(job)
    }
    this.notifyPriorityChanged(job)
  }

  private notifyPriorityChanged(job: LoudnessJob<TPayload, TResult>): void {
    for (const listener of job.priorityListeners) {
      try {
        listener(job.priority)
      } catch {
        // Reprioritization is explicitly best effort. A platform priority API
        // failure must never discard or alter the loudness result.
      }
    }
  }

  private abortUnrelatedActiveJob(incomingJob: LoudnessJob<TPayload, TResult>): void {
    const active = this.activeJob
    if (!active || active === incomingJob || active.abortController.signal.aborted) return
    active.wasAborted = true
    active.abortController.abort()
  }

  private cancelQueuedInteractiveJobs(incomingJob: LoudnessJob<TPayload, TResult>): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index]
      if (queued === incomingJob || queued.priority !== 'interactive') continue
      this.queue.splice(index, 1)
      this.settleQueuedJobAsAborted(queued)
    }
  }

  private settleQueuedJobAsAborted(job: LoudnessJob<TPayload, TResult>): void {
    job.wasAborted = true
    job.abortController.abort()
    if (this.jobsByKey.get(job.key) === job) this.jobsByKey.delete(job.key)
    const result = this.options.createAbortedResult()
    this.options.onSettled?.({
      key: job.key,
      initialPriority: job.initialPriority,
      finalPriority: job.priority,
      wasPromoted: job.wasPromoted,
      wasAborted: true,
      attempts: 0,
      queueDepthAtStart: 0,
      durationMs: 0
    }, result, undefined)
    job.resolve(result)
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
    job.priorityListeners.clear()
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
          const context: LoudnessJobRunContext = {
            signal: currentController.signal,
            get priority() { return job.priority },
            initialPriority: job.initialPriority,
            attempt: job.attempts,
            queueDepthAtStart: job.queueDepthAtStart,
            wasPromoted: job.wasPromoted,
            onPriorityChanged: (listener) => {
              job.priorityListeners.add(listener)
              return () => job.priorityListeners.delete(listener)
            }
          }
          result = await this.options.run(job.payload, context)
          if (currentController.signal.aborted) {
            if (job.restartAfterPromotion) {
              job.restartAfterPromotion = false
              job.abortController = new AbortController()
              continue
            }
            result = this.options.createAbortedResult()
          }
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
