import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinateLocalPcmProbeAndDecode } from './localPcmProbeDecodeCoordinator.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('overlap starts decode before probe resolves and waits for both', async () => {
  const probe = deferred<string>()
  const decode = deferred<string>()
  const events: string[] = []
  const coordinated = coordinateLocalPcmProbeAndDecode({
    probePromise: probe.promise,
    overlap: true,
    startDecode: () => {
      events.push('decode-started')
      return decode.promise
    },
    acceptProbe: (value) => {
      events.push(`probe-accepted:${value}`)
    }
  })

  assert.deepEqual(events, ['decode-started'])
  decode.resolve('pcm')
  await Promise.resolve()
  probe.resolve('stereo')
  assert.deepEqual(await coordinated, { probe: 'stereo', decode: 'pcm' })
  assert.deepEqual(events, ['decode-started', 'probe-accepted:stereo'])
})

test('serial rollback accepts probe before starting decode', async () => {
  const events: string[] = []
  const result = await coordinateLocalPcmProbeAndDecode({
    probePromise: Promise.resolve('stereo'),
    overlap: false,
    acceptProbe: () => {
      events.push('probe-accepted')
    },
    startDecode: async () => {
      events.push('decode-started')
      return 'pcm'
    }
  })

  assert.deepEqual(result, { probe: 'stereo', decode: 'pcm' })
  assert.deepEqual(events, ['probe-accepted', 'decode-started'])
})

test('a rejected probe never starts decode in serial rollback mode', async () => {
  let decodeStarted = false
  await assert.rejects(
    coordinateLocalPcmProbeAndDecode({
      probePromise: Promise.reject(new Error('probe failed')),
      overlap: false,
      acceptProbe: () => undefined,
      startDecode: async () => {
        decodeStarted = true
        return 'pcm'
      }
    }),
    /probe failed/
  )
  assert.equal(decodeStarted, false)
})

test('a rejected probe propagates after overlapped decode has started', async () => {
  let decodeStarted = false
  await assert.rejects(
    coordinateLocalPcmProbeAndDecode({
      probePromise: Promise.reject(new Error('probe failed')),
      overlap: true,
      acceptProbe: () => undefined,
      startDecode: async () => {
        decodeStarted = true
        return 'pcm'
      }
    }),
    /probe failed/
  )
  assert.equal(decodeStarted, true)
})

test('an early overlapped decode rejection remains ordered behind probe acceptance', async () => {
  const probe = deferred<string>()
  const events: string[] = []
  const coordinated = coordinateLocalPcmProbeAndDecode({
    probePromise: probe.promise,
    overlap: true,
    startDecode: async () => {
      events.push('decode-started')
      throw new Error('decode failed')
    },
    acceptProbe: () => {
      events.push('probe-accepted')
    }
  })

  await Promise.resolve()
  assert.deepEqual(events, ['decode-started'])
  probe.resolve('stereo')
  await assert.rejects(coordinated, /decode failed/)
  assert.deepEqual(events, ['decode-started', 'probe-accepted'])
})
