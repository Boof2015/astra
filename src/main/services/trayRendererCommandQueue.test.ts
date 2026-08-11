import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrayRendererCommand } from '../../types/desktopIntegration.ts'
import { TrayRendererCommandQueue } from './trayRendererCommandQueue.ts'

test('tray renderer commands remain queued until readiness flushes them in order', () => {
  const queue = new TrayRendererCommandQueue()
  const sent: TrayRendererCommand[] = []
  queue.enqueue({ type: 'open-settings', section: 'appearance' })
  queue.enqueue({ type: 'start-sleep-timer', minutes: 30 })

  assert.equal(queue.size, 2)
  assert.equal(sent.length, 0)
  assert.equal(queue.flush((command) => sent.push(command)), 2)
  assert.deepEqual(sent, [
    { type: 'open-settings', section: 'appearance' },
    { type: 'start-sleep-timer', minutes: 30 },
  ])
  assert.equal(queue.size, 0)
})

test('commands enqueued after a flush wait for the next renderer-ready cycle', () => {
  const queue = new TrayRendererCommandQueue()
  const sent: TrayRendererCommand[] = []
  queue.enqueue({ type: 'reveal-current-track' })
  queue.flush((command) => sent.push(command))
  queue.enqueue({ type: 'cancel-sleep-timer' })

  assert.deepEqual(sent, [{ type: 'reveal-current-track' }])
  assert.equal(queue.size, 1)
})
