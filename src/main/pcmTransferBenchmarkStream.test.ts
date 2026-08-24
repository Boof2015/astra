import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_PCM_STREAM_CHUNK_BYTES,
  LOCAL_PCM_STREAM_INITIAL_CREDITS,
  LOCAL_PCM_STREAM_VERSION,
  isLocalPcmStreamMainMessage,
  type LocalPcmStreamMainMessage,
  type LocalPcmStreamRendererMessage
} from '../shared/localPcmStream.ts'
import type { PcmTransferBenchmarkStreamOpenRequest } from '../shared/pcmTransferBenchmark.ts'
import {
  PCM_TRANSFER_BENCHMARK_STREAM_CHANNELS,
  PCM_TRANSFER_BENCHMARK_STREAM_SAMPLE_RATE,
  PcmTransferBenchmarkStreamCoordinator,
  type PcmTransferBenchmarkStreamPort
} from './pcmTransferBenchmarkStream.ts'

class FakePort implements PcmTransferBenchmarkStreamPort {
  readonly messages: LocalPcmStreamMainMessage[] = []
  started = false
  closed = false
  private messageListener: ((data: unknown) => void) | null = null
  private closeListener: (() => void) | null = null
  private readonly queuedMessages: LocalPcmStreamRendererMessage[] = []

  postMessage(message: LocalPcmStreamMainMessage): void {
    this.messages.push(message)
  }

  start(): void {
    this.started = true
    for (const message of this.queuedMessages.splice(0)) {
      this.messageListener?.(message)
    }
  }

  close(): void {
    this.closed = true
  }

  subscribe(onMessage: (data: unknown) => void, onClose: () => void): () => void {
    this.messageListener = onMessage
    this.closeListener = onClose
    return () => {
      this.messageListener = null
      this.closeListener = null
    }
  }

  receive(message: LocalPcmStreamRendererMessage): void {
    this.messageListener?.(message)
  }

  queueBeforeStart(message: LocalPcmStreamRendererMessage): void {
    this.queuedMessages.push(message)
  }

  remoteClose(): void {
    this.closeListener?.()
  }
}

function request(sizeBytes: number, requestId = 7): PcmTransferBenchmarkStreamOpenRequest {
  return {
    version: LOCAL_PCM_STREAM_VERSION,
    requestId,
    sizeBytes,
    nonce: `benchmark_${requestId}`
  }
}

function ready(value: PcmTransferBenchmarkStreamOpenRequest): LocalPcmStreamRendererMessage {
  return {
    type: 'ready',
    version: LOCAL_PCM_STREAM_VERSION,
    requestId: value.requestId,
    nonce: value.nonce,
    credits: LOCAL_PCM_STREAM_INITIAL_CREDITS
  }
}

function credit(
  value: PcmTransferBenchmarkStreamOpenRequest,
  sequence: number
): LocalPcmStreamRendererMessage {
  return {
    type: 'credit',
    version: LOCAL_PCM_STREAM_VERSION,
    requestId: value.requestId,
    nonce: value.nonce,
    sequence,
    credits: 1
  }
}

test('streams bounded sentinel payloads with two-credit backpressure and complete timings', () => {
  let now = 100
  const coordinator = new PcmTransferBenchmarkStreamCoordinator({
    now: () => {
      now += 0.25
      return now
    },
    setTimer: () => ({}) as NodeJS.Timeout,
    clearTimer: () => undefined
  })
  const port = new FakePort()
  const sizeBytes = (LOCAL_PCM_STREAM_CHUNK_BYTES * 2) + 16
  const openRequest = request(sizeBytes)

  assert.equal(coordinator.start(port, openRequest, 100), true)
  assert.equal(port.started, true)
  assert.equal(port.messages[0]?.type, 'accepted')

  port.receive(ready(openRequest))
  const startMessage = port.messages.find((message) => message.type === 'start')
  assert.deepEqual(startMessage && {
    sampleRate: startMessage.sampleRate,
    channels: startMessage.channels,
    backingBufferBytes: startMessage.backingBufferBytes
  }, {
    sampleRate: PCM_TRANSFER_BENCHMARK_STREAM_SAMPLE_RATE,
    channels: PCM_TRANSFER_BENCHMARK_STREAM_CHANNELS,
    backingBufferBytes: sizeBytes
  })

  let chunks = port.messages.filter((message) => message.type === 'chunk')
  assert.equal(chunks.length, 2)
  assert.equal(chunks.every((chunk) => chunk.byteLength <= LOCAL_PCM_STREAM_CHUNK_BYTES), true)
  assert.equal(port.messages.some((message) => message.type === 'complete'), false)

  port.receive(credit(openRequest, 0))
  chunks = port.messages.filter((message) => message.type === 'chunk')
  assert.equal(chunks.length, 3)
  assert.equal(chunks[2]?.byteLength, 16)
  assert.equal(port.messages.some((message) => message.type === 'complete'), false)

  port.receive(credit(openRequest, 1))
  assert.equal(port.messages.some((message) => message.type === 'complete'), false)
  port.receive(credit(openRequest, 2))

  const complete = port.messages.find((message) => message.type === 'complete')
  assert.ok(complete && complete.type === 'complete')
  assert.equal(isLocalPcmStreamMainMessage(complete), true)
  assert.equal(complete.pcmByteLength, sizeBytes)
  assert.equal(complete.frames, sizeBytes / Float32Array.BYTES_PER_ELEMENT)
  assert.equal(complete.chunkCount, 3)
  assert.equal(complete.transportTimings.streamChunkCount, 3)
  assert.equal((complete.transportTimings.benchmarkMainGenerationMs ?? -1) >= 0, true)
  assert.equal((complete.transportTimings.benchmarkMainFillMs ?? -1) >= 0, true)
  assert.equal(complete.transportTimings.allocationMs >= 0, true)
  assert.equal(complete.transportTimings.streamDispatchCopyMs >= 0, true)
  assert.equal(complete.transportTimings.streamDispatchPostMs >= 0, true)
  assert.equal(complete.transportTimings.streamTailMs > 0, true)
  assert.equal(port.closed, true)
  assert.equal(coordinator.busy, false)

  const assembled = new Uint8Array(sizeBytes)
  for (const chunk of chunks) {
    if (chunk.type !== 'chunk') continue
    assembled.set(new Uint8Array(chunk.payload), chunk.byteOffset)
  }
  assert.equal(assembled[0], 0xa5)
  assert.equal(assembled[Math.floor(sizeBytes / 2)], 0x5a)
  assert.equal(assembled[sizeBytes - 1], 0xc3)
  assert.equal(assembled[12345], 0x6d)
})

test('publishes accepted before start flushes an already queued ready control', () => {
  const coordinator = new PcmTransferBenchmarkStreamCoordinator({
    setTimer: () => ({}) as NodeJS.Timeout,
    clearTimer: () => undefined
  })
  const port = new FakePort()
  const openRequest = request(16)
  port.queueBeforeStart(ready(openRequest))

  assert.equal(coordinator.start(port, openRequest), true)
  assert.deepEqual(port.messages.slice(0, 3).map((message) => message.type), [
    'accepted',
    'start',
    'chunk'
  ])

  port.receive(credit(openRequest, 0))
  assert.equal(port.messages.at(-1)?.type, 'complete')
  assert.equal(port.closed, true)
})

test('rejects a concurrent stream and keeps the active one intact', () => {
  const coordinator = new PcmTransferBenchmarkStreamCoordinator({
    setTimer: () => ({}) as NodeJS.Timeout,
    clearTimer: () => undefined
  })
  const firstPort = new FakePort()
  const secondPort = new FakePort()
  const firstRequest = request(1024, 1)
  const secondRequest = request(1024, 2)

  assert.equal(coordinator.start(firstPort, firstRequest), true)
  assert.equal(coordinator.start(secondPort, secondRequest), false)
  assert.equal(secondPort.messages.at(-1)?.type, 'error')
  assert.equal(secondPort.closed, true)
  assert.equal(firstPort.closed, false)
  assert.equal(coordinator.busy, true)

  firstPort.receive({
    type: 'cancel',
    version: LOCAL_PCM_STREAM_VERSION,
    requestId: firstRequest.requestId,
    nonce: firstRequest.nonce
  })
  assert.equal(firstPort.messages.at(-1)?.type, 'cancelled')
  assert.equal(firstPort.closed, true)
  assert.equal(coordinator.busy, false)
})

test('closes a stream on invalid or duplicate credits', () => {
  const coordinator = new PcmTransferBenchmarkStreamCoordinator({
    setTimer: () => ({}) as NodeJS.Timeout,
    clearTimer: () => undefined
  })
  const port = new FakePort()
  const openRequest = request(LOCAL_PCM_STREAM_CHUNK_BYTES * 3)
  coordinator.start(port, openRequest)
  port.receive(ready(openRequest))
  port.receive(credit(openRequest, 1))

  const error = port.messages.at(-1)
  assert.ok(error && error.type === 'error')
  assert.equal(error.code, 'PCM_BENCHMARK_STREAM_PROTOCOL_ERROR')
  assert.equal(port.closed, true)
  assert.equal(coordinator.busy, false)
})
