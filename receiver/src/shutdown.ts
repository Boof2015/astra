export const RECEIVER_SHUTDOWN_DEADLINE_MS = 10_000

export interface NamedShutdownAction {
  name: string
  run: () => void
}

export interface NamedShutdownTask {
  name: string
  run: () => Promise<unknown>
}

export interface ShutdownTimer {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface ShutdownCoordinatorOptions {
  prepare: NamedShutdownAction[]
  cleanup: NamedShutdownTask[]
  finalizers: NamedShutdownAction[]
  log: (message: string) => void
  exit: (code: number) => void
  deadlineMs?: number
  timer?: ShutdownTimer
}

export type ShutdownReceiver = (reason: string) => Promise<void>

const systemTimer: ShutdownTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Creates the receiver's single shutdown funnel. Every cleanup task is started before the
 * coordinator awaits, then all of them share one deadline. Synchronous finalizers and exit are
 * attempted exactly once even when preparation, cleanup, or the deadline fails.
 */
export function createShutdownCoordinator(options: ShutdownCoordinatorOptions): ShutdownReceiver {
  const deadlineMs = options.deadlineMs ?? RECEIVER_SHUTDOWN_DEADLINE_MS
  const timer = options.timer ?? systemTimer
  let shutdownPromise: Promise<void> | null = null
  const log = (message: string): void => {
    try { options.log(message) } catch { /* logging must never break shutdown */ }
  }

  const runShutdown = async (reason: string): Promise<void> => {
    log(`${reason} — shutting down`)
    try {
      for (const action of options.prepare) {
        try {
          action.run()
        } catch (error) {
          log(`shutdown preparation '${action.name}' failed: ${errorDetail(error)}`)
        }
      }

      const unfinished = new Set<string>()
      const cleanupPromises = options.cleanup.map((task) => {
        unfinished.add(task.name)
        let taskPromise: Promise<unknown>
        try {
          // Calling run() here starts every component before Promise.allSettled is awaited. The
          // host client therefore aborts its shared controller before any cleanup wait begins.
          taskPromise = Promise.resolve(task.run())
        } catch (error) {
          taskPromise = Promise.reject(error)
        }
        return taskPromise
          .catch((error) => {
            log(`shutdown cleanup '${task.name}' failed: ${errorDetail(error)}`)
          })
          .finally(() => unfinished.delete(task.name))
      })

      const allCleanup = Promise.allSettled(cleanupPromises)
      let deadlineHandle: unknown = null
      let deadlineExpired = false
      const deadline = new Promise<void>((resolve) => {
        deadlineHandle = timer.setTimeout(() => {
          deadlineExpired = true
          resolve()
        }, deadlineMs)
      })

      await Promise.race([allCleanup, deadline])
      if (deadlineExpired) {
        log(
          `shutdown cleanup deadline expired after ${deadlineMs} ms; unfinished: ${[...unfinished].join(', ')}`
        )
      } else if (deadlineHandle !== null) {
        timer.clearTimeout(deadlineHandle)
      }
    } finally {
      for (const action of options.finalizers) {
        try {
          action.run()
        } catch (error) {
          log(`shutdown finalizer '${action.name}' failed: ${errorDetail(error)}`)
        }
      }
      options.exit(0)
    }
  }

  return (reason) => {
    if (!shutdownPromise) shutdownPromise = runShutdown(reason)
    return shutdownPromise
  }
}
