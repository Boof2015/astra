import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import { installFixedWindowZoom } from './fixedWindowZoom.ts'

class FakeWebContents extends EventEmitter {
  zoomLevel = 2
  visualLimits: number[] = []
  destroyed = false
  isDestroyed() { return this.destroyed }
  setZoomLevel(level: number) { this.zoomLevel = level }
  async setVisualZoomLevelLimits(min: number, max: number) { this.visualLimits = [min, max] }
}

test('fixed window zoom resets on each load and disables visual zoom', () => {
  const contents = new FakeWebContents()
  installFixedWindowZoom(contents as unknown as WebContents)
  for (const inheritedZoom of [-1, 2]) {
    contents.zoomLevel = inheritedZoom
    contents.emit('dom-ready')
    assert.equal(contents.zoomLevel, 0)
    assert.deepEqual(contents.visualLimits, [1, 1])
  }
})

test('fixed windows consume platform scale shortcuts and leave ordinary input alone', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const contents = new FakeWebContents()
    installFixedWindowZoom(contents as unknown as WebContents, platform)
    const modifier = platform === 'darwin' ? { meta: true } : { control: true }
    for (const [key, code] of [['+', 'Equal'], ['=', 'Equal'], ['-', 'Minus'], ['0', 'Digit0'], ['Unidentified', 'NumpadAdd'], ['Unidentified', 'NumpadSubtract'], ['Unidentified', 'Numpad0']]) {
      let prevented = false
      contents.zoomLevel = 1
      contents.emit('before-input-event', { preventDefault: () => { prevented = true } }, { type: 'keyDown', key, code, ...modifier })
      assert.equal(prevented, true, `${platform} ${code}`)
      assert.equal(contents.zoomLevel, 0)
    }
    for (const input of [{ type: 'keyDown', key: 'a', ...modifier }, { type: 'keyDown', key: '+' }, { type: 'keyUp', key: '+', ...modifier }]) {
      contents.emit('before-input-event', { preventDefault: () => assert.fail('ordinary input was consumed') }, input)
    }
  }
})

test('wheel zoom requests are consumed without forwarding input to the main window', () => {
  const contents = new FakeWebContents()
  installFixedWindowZoom(contents as unknown as WebContents)
  let prevented = false
  contents.emit('zoom-changed', { preventDefault: () => { prevented = true } }, 'in')
  assert.equal(prevented, true)
  assert.equal(contents.zoomLevel, 0)
  contents.destroyed = true
  contents.setZoomLevel = () => assert.fail('cannot reset a destroyed window')
  contents.emit('zoom-changed', { preventDefault() {} }, 'out')
})
