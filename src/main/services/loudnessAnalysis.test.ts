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

test('interactive request restarts an active background job at interactive priority', async () => {
  const attempts: string[] = []
  const settledDiagnostics: LoudnessJobDiagnostics[] = []
  const queue = new LoudnessAnalysisJobQueue<string, string | null>({
    run: async (_payload, context) => {
      attempts.push(context.priority)
      if (context.priority === 'interactive') return 'interactive-result'
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return null
    },
    createAbortedResult: () => null,
    onSettled: (result) => { settledDiagnostics.push(result) }
  })

  const background = queue.enqueue('/music/a.flac', 'a', 'background')
  const promoted = queue.enqueue('/music/a.flac', 'a', 'interactive')
  assert.equal(background, promoted)
  assert.equal(await promoted, 'interactive-result')
  assert.deepEqual(attempts, ['background', 'interactive'])
  const diagnostics = settledDiagnostics[0]
  assert.equal(diagnostics?.wasPromoted, true)
  assert.equal(diagnostics?.wasAborted, true)
  assert.equal(diagnostics?.attempts, 2)
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
