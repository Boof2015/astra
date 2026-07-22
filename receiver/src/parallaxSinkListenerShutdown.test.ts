import assert from 'node:assert/strict'
import { createServer as createTcpServer, createConnection } from 'node:net'
import test from 'node:test'
import { ParallaxSinkListener } from '../../src/main/services/parallaxSinkListener.ts'

async function getFreePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test('pairing listener stop destroys a partially-read active request', async () => {
  const port = await getFreePort()
  const listener = new ParallaxSinkListener({
    getEndpointUuid: () => '11111111-2222-3333-4444-555555555555',
    getSinkName: () => 'Test Sink',
    getHasPersistedConnection: () => false,
    onPaired: async () => undefined,
    onIncomingPairChange: () => undefined
  })
  await listener.start(port)

  const socket = createConnection({ host: '127.0.0.1', port })
  const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('connect', resolve)
    })
    await new Promise<void>((resolve, reject) => {
      socket.write(
        'POST /v1/parallax/pair-request HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Content-Type: application/json\r\n'
        + 'Content-Length: 512\r\n'
        + 'Connection: keep-alive\r\n\r\n'
        + '{"pairingId":"still-arriving"',
        (error) => error ? reject(error) : resolve()
      )
    })

    await Promise.all([listener.stop(), socketClosed])
    assert.equal(listener.isRunning, false)
  } finally {
    socket.destroy()
    await listener.stop()
  }
})
