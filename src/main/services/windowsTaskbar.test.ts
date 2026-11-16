import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow, NativeImage, NativeTheme, ThumbarButton } from 'electron'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer.ts'
import { installWindowsTaskbarControls } from './windowsTaskbar.ts'

function snapshot(overrides: Partial<MiniPlayerSnapshot> = {}): MiniPlayerSnapshot {
  return {
    playbackState: 'playing', currentTime: 10, duration: 180, queueLength: 2,
    shuffle: false, repeat: 'none', outputDeviceLabel: null,
    timeDisplayMode: 'remaining', visualizerLineColor: '#0097ff',
    currentTrack: { id: '1', path: '/song.flac', title: 'Song', artist: 'Artist', album: '', isFavorite: false },
    ...overrides,
  }
}

function harness() {
  let destroyed = false
  let accepted = true
  const updates: ThumbarButton[][] = []
  const commands: MiniPlayerCommand[] = []
  const loadedIcons: string[] = []
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed })
  const window = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => destroyed,
    setThumbarButtons: (buttons: ThumbarButton[]) => { updates.push(buttons); return accepted },
  })
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColorsForSystemIntegratedUI: true })
  const controls = installWindowsTaskbarControls({
    window: window as unknown as BrowserWindow,
    theme: theme as unknown as NativeTheme,
    loadIcon: (name, dark) => {
      const key = `${name}-${dark ? 'dark' : 'light'}`
      loadedIcons.push(key)
      return { name: key } as unknown as NativeImage
    },
    sendCommand: command => commands.push(command),
  })
  return {
    window, theme, controls, commands, updates, loadedIcons,
    buttons: () => updates.at(-1)!,
    setAccepted: (value: boolean) => { accepted = value },
    close: () => { destroyed = true; window.emit('closed') },
  }
}

test('toolbar waits for the window and disables actions until a track and renderer are ready', () => {
  const h = harness()
  h.controls.setRendererReady(true)
  assert.equal(h.updates.length, 0)
  h.window.emit('ready-to-show')
  assert.deepEqual(h.buttons().map(button => button.tooltip), ['Add to favorites', 'Previous', 'Play', 'Next'])
  assert.ok(h.buttons().every(button => button.flags?.includes('disabled')))
  h.buttons().forEach(button => button.click())
  assert.deepEqual(h.commands, [])
  h.controls.publishSnapshot(snapshot())
  assert.ok(h.buttons().every(button => button.flags?.length === 0))
  h.controls.setRendererReady(false)
  assert.ok(h.buttons().every(button => button.flags?.includes('disabled')))
})

test('all four buttons dispatch existing player commands without activating the window', () => {
  const h = harness()
  h.controls.publishSnapshot(snapshot())
  h.controls.setRendererReady(true)
  h.window.emit('ready-to-show')
  h.buttons().forEach(button => button.click())
  assert.deepEqual(h.commands, [
    { type: 'toggleFavoriteCurrent' }, { type: 'playPrevious' }, { type: 'togglePlay' }, { type: 'playNext' },
  ])
  assert.ok(h.buttons().every(button => !button.flags?.includes('dismissonclick')))
})

test('playback and favorite changes update icons, but clock ticks do not rebuild the toolbar', () => {
  const h = harness()
  h.controls.setRendererReady(true)
  h.controls.publishSnapshot(snapshot())
  h.window.emit('ready-to-show')
  assert.equal(h.buttons()[2].tooltip, 'Pause')
  h.controls.publishSnapshot(snapshot({ currentTime: 11 }))
  assert.equal(h.updates.length, 1)
  h.controls.publishSnapshot(snapshot({ playbackState: 'loading' }))
  assert.equal(h.updates.length, 1)
  const track = { ...snapshot().currentTrack!, isFavorite: true }
  h.controls.publishSnapshot(snapshot({ playbackState: 'paused', currentTrack: track }))
  assert.equal(h.buttons()[0].tooltip, 'Remove from favorites')
  assert.deepEqual(h.buttons()[0].icon, { name: 'favorited-dark' })
  assert.equal(h.buttons()[2].tooltip, 'Play')
  assert.deepEqual(h.buttons()[2].icon, { name: 'play-dark' })
  h.controls.publishSnapshot(snapshot({ playbackState: 'stopped', currentTrack: null }))
  assert.ok(h.buttons().every(button => button.flags?.includes('disabled')))
  assert.equal(h.buttons()[0].tooltip, 'Add to favorites')
})

test('renderer reloads and crashes clear stale state and guard previously enabled callbacks', () => {
  const h = harness()
  h.controls.setRendererReady(true)
  h.controls.publishSnapshot(snapshot())
  h.window.emit('ready-to-show')
  const oldButtons = h.buttons()
  h.window.webContents.emit('did-start-navigation', {}, 'file:///app', false, false)
  h.window.webContents.emit('did-start-navigation', {}, 'file:///app#queue', true, true)
  assert.equal(h.updates.length, 1)
  h.window.webContents.emit('did-start-navigation', {}, 'file:///app', false, true)
  oldButtons.forEach(button => button.click())
  assert.deepEqual(h.commands, [])
  h.controls.setRendererReady(true)
  assert.ok(h.buttons().every(button => button.flags?.includes('disabled')))
  h.controls.publishSnapshot(snapshot())
  assert.ok(h.buttons().every(button => button.flags?.length === 0))
  h.window.webContents.emit('render-process-gone')
  assert.ok(h.buttons().every(button => button.flags?.includes('disabled')))
  h.controls.publishSnapshot(snapshot())
  assert.ok(h.buttons().every(button => button.flags?.includes('disabled')))
})

test('system theme changes replace icons and the listener is removed when the window closes', () => {
  const h = harness()
  h.window.emit('ready-to-show')
  h.theme.shouldUseDarkColorsForSystemIntegratedUI = false
  h.theme.emit('updated')
  assert.deepEqual(h.buttons()[1].icon, { name: 'previous-light' })
  h.theme.shouldUseDarkColorsForSystemIntegratedUI = true
  h.theme.emit('updated')
  assert.equal(h.loadedIcons.filter(name => name === 'previous-dark').length, 1)
  h.close()
  assert.equal(h.theme.listenerCount('updated'), 0)
  const count = h.updates.length
  h.controls.publishSnapshot(snapshot())
  assert.equal(h.updates.length, count)
})

test('failed native registration can retry and showing a hidden window reapplies its controls', () => {
  const h = harness()
  h.setAccepted(false)
  h.window.emit('ready-to-show')
  h.setAccepted(true)
  h.controls.setRendererReady(false)
  assert.equal(h.updates.length, 2)
  h.controls.setRendererReady(false)
  assert.equal(h.updates.length, 2)
  h.window.emit('show')
  assert.equal(h.updates.length, 3)
})
