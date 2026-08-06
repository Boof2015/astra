import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEbur128Args,
  LoudnessAnalysisJobQueue,
  LOUDNESS_FFMPEG_MAX_STDERR_BYTES,
  parseEbur128Summary,
  type LoudnessJobDiagnostics
} from './loudnessAnalysis.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('ebur128 arguments suppress frame logging and retain a bounded stderr buffer', () => {
  const args = buildEbur128Args('/music/test.flac')
  assert.equal(args[args.indexOf('-af') + 1], 'ebur128=peak=sample:framelog=verbose')
  assert.equal(args.includes('ebur128=peak=sample'), false)
  assert.equal(LOUDNESS_FFMPEG_MAX_STDERR_BYTES, 1024 * 1024)
})

test('parseEbur128Summary reads the final integrated loudness and sample peak', () => {
  const stderr = [
    '[Parsed_ebur128_0] t: 0.0999792 TARGET:-23 LUFS M:-120.7 S:-120.7 I: -70.0 LUFS',
    '  Integrated loudness:',
    '    I:         -14.2 LUFS',
    '  True peak:',
    '    Peak:       -1.5 dBFS'
  ].join('\n')

  const parsed = parseEbur128Summary(stderr)
  assert.ok(parsed)
  assert.equal(parsed.loudnessLufs, -14.2)
  assert.ok(parsed.peakLinear !== null)
  assert.ok(Math.abs(parsed.peakLinear - Math.pow(10, -1.5 / 20)) < 1e-12)
})

test('parseEbur128Summary handles silence and rejects missing summaries', () => {
  assert.deepEqual(parseEbur128Summary('    I:         -70.0 LUFS\n    Peak:       -inf dBFS\n'), {
    loudnessLufs: -70,
    peakLinear: 0
  })
  assert.equal(parseEbur128Summary('ffmpeg failed before the summary'), null)
})

test('loudness queue deduplicates matching background requests', async () => {
  const gate = deferred<string>()
  let runs = 0
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async () => {
      runs += 1
      return gate.promise
    },
    createAbortedResult: () => null
  })

  const first = queue.enqueue('/music/a.flac', 'a', 'background')
  const duplicate = queue.enqueue('/music/a.flac', 'a', 'background')
  assert.equal(first, duplicate)
  gate.resolve('done')
  assert.equal(await first, 'done')
  assert.equal(runs, 1)
})

test('loudness queue accepts fresh work for a key after its prior job settles', async () => {
  let runs = 0
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async () => `run-${++runs}`,
    createAbortedResult: () => null
  })

  assert.equal(await queue.enqueue('/music/a.flac', 'a', 'background'), 'run-1')
  assert.equal(await queue.enqueue('/music/a.flac', 'a', 'background'), 'run-2')
})

test('interactive request reuses and reprioritizes an active matching background job', async () => {
  const gate = deferred<{ loudnessLufs: number; peakLinear: number }>()
  const startedPriorities: string[] = []
  const priorityChanges: string[] = []
  const settledDiagnostics: LoudnessJobDiagnostics[] = []
  const exactResult = { loudnessLufs: -14.23456789, peakLinear: 0.87654321 }
  let runs = 0
  const queue = new LoudnessAnalysisJobQueue<string, typeof exactResult | null>({
    run: async (_payload, context) => {
      runs += 1
      startedPriorities.push(context.priority)
      const unsubscribe = context.onPriorityChanged((priority) => priorityChanges.push(priority))
      try {
        return await gate.promise
      } finally {
        unsubscribe()
      }
    },
    createAbortedResult: () => null,
    onSettled: (result) => { settledDiagnostics.push(result) }
  })

  const background = queue.enqueue('/music/a.flac', 'a', 'background')
  const promoted = queue.enqueue('/music/a.flac', 'a', 'interactive')
  assert.equal(background, promoted)
  gate.resolve(exactResult)
  assert.equal(await promoted, exactResult)
  assert.equal(runs, 1)
  assert.deepEqual(startedPriorities, ['background'])
  assert.deepEqual(priorityChanges, ['interactive'])
  const diagnostics = settledDiagnostics[0]
  assert.equal(diagnostics?.wasPromoted, true)
  assert.equal(diagnostics?.wasAborted, false)
  assert.equal(diagnostics?.attempts, 1)
  assert.equal(diagnostics?.finalPriority, 'interactive')
})

test('interactive work aborts an unrelated background job', async () => {
  const started: string[] = []
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async (payload, context) => {
      started.push(`${payload}:${context.priority}`)
      if (context.priority === 'interactive') return payload
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return null
    },
    createAbortedResult: () => null
  })

  const background = queue.enqueue('/music/a.flac', 'a', 'background')
  const interactive = queue.enqueue('/music/b.flac', 'b', 'interactive')
  assert.equal(await background, null)
  assert.equal(await interactive, 'b')
  assert.deepEqual(started, ['a:background', 'b:interactive'])
})

test('interactive request promotes queued matching work ahead of other background jobs', async () => {
  const started: string[] = []
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async (payload, context) => {
      started.push(`${payload}:${context.priority}`)
      if (payload === 'a') {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return payload
    },
    createAbortedResult: () => null
  })

  const activeBackground = queue.enqueue('/music/a.flac', 'a', 'background')
  const queuedBackground = queue.enqueue('/music/b.flac', 'b', 'background')
  const promoted = queue.enqueue('/music/b.flac', 'b', 'interactive')
  assert.equal(queuedBackground, promoted)
  assert.equal(await activeBackground, null)
  assert.equal(await promoted, 'b')
  assert.deepEqual(started, ['a:background', 'b:interactive'])
})

test('new interactive work cancels an obsolete active interactive analysis', async () => {
  const started: string[] = []
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async (payload, context) => {
      started.push(payload)
      if (payload === 'b') return 'b-result'
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return 'stale-result'
    },
    createAbortedResult: () => null
  })

  const obsolete = queue.enqueue('/music/a.flac', 'a', 'interactive')
  const newest = queue.enqueue('/music/b.flac', 'b', 'interactive')
  assert.equal(await obsolete, null)
  assert.equal(await newest, 'b-result')
  assert.deepEqual(started, ['a', 'b'])
})

test('a newest cached-or-skipped request can cancel obsolete interactive work without enqueueing', async () => {
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async (_payload, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return 'stale-result'
    },
    createAbortedResult: () => null
  })

  const obsolete = queue.enqueue('/music/a.flac', 'a', 'interactive')
  queue.supersedeInteractiveExcept('/music/cached-b.flac')
  assert.equal(await obsolete, null)
})

test('a supersede-only hint does not discard unrelated background warmup work', async () => {
  const gate = deferred<string>()
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async () => gate.promise,
    createAbortedResult: () => null
  })

  const background = queue.enqueue('/music/a.flac', 'a', 'background')
  queue.supersedeInteractiveExcept('/music/cached-b.flac')
  gate.resolve('background-result')

  assert.equal(await background, 'background-result')
})

test('the newest matching request restarts an active interactive job canceled by an intermediate track', async () => {
  const started: string[] = []
  const staleAttempt = deferred<string>()
  let aAttempts = 0
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async (payload, context) => {
      started.push(payload)
      if (payload === 'a') {
        aAttempts += 1
        if (aAttempts > 1) return 'a-newest-result'
        // Deliberately ignore cancellation on the first attempt. The queue must
        // suppress this stale value and restart the matching newest request.
        return staleAttempt.promise
      }
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return null
    },
    createAbortedResult: () => null
  })

  const firstA = queue.enqueue('/music/a.flac', 'a', 'interactive')
  const intermediateB = queue.enqueue('/music/b.flac', 'b', 'interactive')
  const newestA = queue.enqueue('/music/a.flac', 'a', 'interactive')
  staleAttempt.resolve('a-stale-result')

  assert.equal(firstA, newestA)
  assert.equal(await intermediateB, null)
  assert.equal(await newestA, 'a-newest-result')
  assert.deepEqual(started, ['a', 'a'])
})

test('newest interactive work cancels queued intermediate analyses before they run', async () => {
  const started: string[] = []
  const diagnostics: LoudnessJobDiagnostics[] = []
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async (payload, context) => {
      started.push(payload)
      if (payload === 'c') return 'c-result'
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return 'stale-result'
    },
    createAbortedResult: () => null,
    onSettled: (result) => diagnostics.push(result)
  })

  const active = queue.enqueue('/music/a.flac', 'a', 'interactive')
  const intermediate = queue.enqueue('/music/b.flac', 'b', 'interactive')
  const newest = queue.enqueue('/music/c.flac', 'c', 'interactive')

  assert.equal(await active, null)
  assert.equal(await intermediate, null)
  assert.equal(await newest, 'c-result')
  assert.deepEqual(started, ['a', 'c'])
  const queuedCancellation = diagnostics.find((entry) => entry.key === '/music/b.flac')
  assert.equal(queuedCancellation?.wasAborted, true)
  assert.equal(queuedCancellation?.attempts, 0)
})

test('an aborted runner cannot commit a stale interactive result', async () => {
  const staleGate = deferred<string>()
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    // Deliberately ignore the signal to prove the queue still suppresses a
    // stale result from a non-cooperative analysis implementation.
    run: async (payload) => payload === 'a' ? staleGate.promise : 'newest-result',
    createAbortedResult: () => null
  })

  const stale = queue.enqueue('/music/a.flac', 'a', 'interactive')
  const newest = queue.enqueue('/music/b.flac', 'b', 'interactive')
  staleGate.resolve('stale-result')

  assert.equal(await stale, null)
  assert.equal(await newest, 'newest-result')
})
