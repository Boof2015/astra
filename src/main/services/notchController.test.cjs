const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { runInNewContext } = require('node:vm')
const { buildSync } = require('esbuild')
const { join } = require('node:path')

const source = buildSync({
  entryPoints: [join(__dirname, 'notchController.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], write: false,
}).outputFiles[0].text

function setup() {
  const ipc = new EventEmitter(), handlers = new Map(), commands = [], surfaces = []
  ipc.handle = (name, handler) => handlers.set(name, handler)
  const exported = { exports: {} }
  const native = { stop() {}, setSurface: value => surfaces.push(value), getGeometry: () => ({ displayId: 1, x: 663, y: 0, width: 185, height: 32 }) }
  const electron = { app: {}, BrowserWindow: class {}, ipcMain: ipc, screen: new EventEmitter(), powerMonitor: new EventEmitter() }
  runInNewContext(source, { module: exported, exports: exported.exports,
    require: id => id === 'electron' ? electron : require(id),
    console, process, __dirname, setTimeout, clearTimeout, Buffer,
  })
  const createMain = () => Object.assign(new EventEmitter(), {
    webContents: { send() {} }, focused: false, visible: true, minimized: false,
    isDestroyed: () => false, isFocused() { return this.focused },
    isVisible() { return this.visible }, isMinimized() { return this.minimized },
  })
  let main = createMain()
  let focused = 0, blurred = 0, opened = 0, destroyed = 0, notchFocused = false
  const notch = { webContents: { send() {} }, focus() { focused++; notchFocused = true },
    isFocused: () => notchFocused, blur() { blurred++; notchFocused = false }, isDestroyed: () => false, destroy() { destroyed++ } }
  const controller = new exported.exports.NotchController({ getMainWindow: () => main,
    openAstra: () => { opened++; notchFocused = false; main.focused = true; main.emit('focus') }, sendCommand: command => commands.push(command), preload: '', rendererFile: '',
  })
  controller.window = notch
  controller.addon = native
  controller.ready = true
  controller.onActiveSpace = true
  const emit = (name, sender, value) => ipc.emit(`notch:${name}`, { sender }, value)
  return { controller, main: main.webContents, notch: notch.webContents, foreign: {}, emit, handlers,
    get mainWindow() { return main }, replaceMain: () => { main = createMain(); return main },
    commands, surfaces, releaseNotchFocus: () => { notchFocused = false }, stats: () => ({ focused, blurred, opened, destroyed }) }
}

test('dismissal releases a focused panel once without reordering an already unfocused panel', () => {
  const qa = setup()
  qa.emit('expand', qa.notch)
  qa.emit('collapse', qa.notch)
  assert.equal(qa.stats().blurred, 1)
  assert.equal(qa.controller.state.view, 'hidden')
  qa.emit('collapse', qa.notch)
  assert.equal(qa.stats().blurred, 1)
  qa.emit('expand', qa.notch)
  qa.releaseNotchFocus()
  qa.emit('collapse', qa.notch)
  assert.equal(qa.stats().blurred, 1, 'an outside click already released focus')
  qa.emit('expand', qa.notch)
  qa.emit('openAstra', qa.notch)
  assert.equal(qa.stats().blurred, 2, 'Open Astra releases the panel before transferring focus')
  qa.emit('openAstra', qa.notch)
  assert.equal(qa.stats().blurred, 2, 'Open Astra must not reorder the already unfocused panel')
  qa.controller.dispose()
})

test('notch IPC rejects foreign windows and separates settings from playback interaction', () => {
  const qa = setup()
  const getState = qa.handlers.get('notch:getState')
  assert.throws(() => getState({ sender: qa.foreign }), /Invalid notch sender/)
  assert.equal(getState({ sender: qa.main }).attached, true)
  assert.throws(() => qa.handlers.get('notch:setPrefs')({ sender: qa.notch }, {}), /Invalid notch sender/)
  qa.emit('expand', qa.main)
  qa.emit('openAstra', qa.foreign)
  qa.emit('command', qa.foreign, { type: 'togglePlay' })
  assert.equal(qa.stats().focused, 0)
  assert.equal(qa.stats().opened, 0)
  assert.equal(qa.commands.length, 0)
  qa.emit('expand', qa.notch)
  assert.equal(qa.controller.state.view, 'expanded')
  assert.equal(qa.stats().focused, 1)
  qa.emit('openAstra', qa.notch)
  assert.equal(qa.controller.state.view, 'hidden')
  assert.equal(qa.stats().opened, 1)
  qa.controller.dispose()
  assert.equal(qa.stats().destroyed, 1)
})

test('main-window focus suppresses automatic content and visualization but preserves intentional access', () => {
  const qa = setup(), chunks = []
  qa.controller.prefs = { enabled: true, restingView: 'spectrum', hoverEnabled: true, trackChangePopups: true, showOverFullscreen: true }
  qa.controller.interaction.configure(qa.controller.prefs)
  qa.controller.reconcile()
  qa.notch.send = (channel, value) => { if (channel === 'notch:visualizerChunk') chunks.push(value) }
  qa.controller.publishSnapshot({ currentTrack: { path: 'a' }, playbackState: 'playing' })
  assert.equal(qa.controller.state.view, 'spectrum')
  qa.mainWindow.focused = true; qa.mainWindow.emit('focus')
  assert.equal(qa.controller.state.view, 'hidden')
  assert.equal(qa.controller.state.visualizerMode, 'off')
  qa.controller.publishVisualizerChunk({ reset: false })
  assert.equal(chunks.length, 0)
  qa.controller.publishSnapshot({ currentTrack: { path: 'b' }, playbackState: 'playing' })
  assert.equal(qa.controller.state.view, 'hidden')
  qa.emit('expand', qa.notch)
  assert.equal(qa.controller.state.view, 'expanded')
  qa.emit('openAstra', qa.notch)
  assert.equal(qa.controller.state.view, 'hidden')
  qa.mainWindow.focused = false; qa.mainWindow.emit('blur')
  assert.equal(qa.controller.state.view, 'spectrum')
  assert.equal(qa.controller.state.reason, 'resting')
  qa.controller.publishVisualizerChunk({ reset: false })
  assert.equal(chunks.length, 1)
  qa.controller.dispose()
  assert.equal(qa.mainWindow.listenerCount('focus'), 0)
})

test('foreground observation follows replaced main windows and stops on disable', () => {
  const qa = setup()
  qa.controller.prefs = { enabled: true, restingView: 'metadata', hoverEnabled: true, trackChangePopups: true, showOverFullscreen: true }
  qa.controller.interaction.configure(qa.controller.prefs)
  qa.mainWindow.focused = true
  qa.controller.reconcile()
  qa.controller.publishSnapshot({ currentTrack: { path: 'a' }, playbackState: 'playing' })
  assert.equal(qa.controller.state.view, 'hidden')
  qa.mainWindow.visible = false; qa.mainWindow.emit('hide')
  assert.equal(qa.controller.state.view, 'metadata')
  qa.mainWindow.visible = true; qa.mainWindow.emit('show')
  assert.equal(qa.controller.state.view, 'hidden')
  qa.mainWindow.minimized = true; qa.mainWindow.emit('minimize')
  assert.equal(qa.controller.state.view, 'metadata')
  qa.mainWindow.minimized = false; qa.mainWindow.emit('restore')
  assert.equal(qa.controller.state.view, 'hidden')
  const oldMain = qa.mainWindow
  qa.replaceMain(); qa.controller.reconcile()
  assert.equal(oldMain.listenerCount('focus'), 0)
  assert.equal(qa.mainWindow.listenerCount('focus'), 1)
  assert.equal(qa.controller.state.view, 'metadata')
  qa.controller.prefs = { ...qa.controller.prefs, enabled: false }
  qa.controller.reconcile()
  assert.equal(qa.mainWindow.listenerCount('focus'), 0)
  qa.controller.dispose()
})

test('notch commands are restricted, seek/volume are finite and bounded, stale windows lose access', () => {
  const qa = setup()
  qa.controller.publishSnapshot({ duration: 120, currentTrack: null, playbackState: 'paused' })
  for (const command of [null, {}, { type: 'toggleShuffle' }, { type: 'seek', time: Infinity }, { type: 'setVolume', volume: '1' }]) {
    qa.emit('command', qa.notch, command)
  }
  assert.equal(qa.commands.length, 0)
  qa.emit('command', qa.notch, { type: 'seek', time: 999 })
  qa.emit('command', qa.notch, { type: 'seek', time: -1 })
  qa.emit('command', qa.notch, { type: 'setVolume', volume: 4 })
  qa.emit('command', qa.notch, { type: 'setVolume', volume: -2 })
  qa.emit('command', qa.notch, { type: 'togglePlay', extra: 'discarded' })
  qa.emit('command', qa.notch, { type: 'toggleMute', extra: 'discarded' })
  assert.deepEqual(JSON.parse(JSON.stringify(qa.commands)), [
    { type: 'seek', time: 120 }, { type: 'seek', time: 0 },
    { type: 'setVolume', volume: 1 }, { type: 'setVolume', volume: 0 }, { type: 'togglePlay' }, { type: 'toggleMute' },
  ])
  const surface = { x: 0, y: 0, width: 249, height: 56, points: [{ x: 0, y: 0 }, { x: 249, y: 0 }, { x: 249, y: 56 }, { x: 0, y: 56 }] }
  qa.emit('surface', qa.main, surface)
  qa.emit('surface', qa.notch, { ...surface, width: NaN })
  qa.emit('surface', qa.notch, { ...surface, points: [{ x: Infinity, y: 0 }, ...surface.points] })
  qa.emit('surface', qa.notch, { ...surface, points: [{ x: -1, y: 0 }, ...surface.points] })
  qa.emit('surface', qa.notch, { ...surface, points: [{ x: 0, y: 57 }, ...surface.points] })
  qa.emit('surface', qa.notch, { ...surface, points: Array(65).fill({ x: 0, y: 0 }) })
  qa.emit('surface', qa.notch, { ...surface, points: [] })
  assert.equal(qa.surfaces.length, 0)
  qa.emit('surface', qa.notch, surface)
  assert.deepEqual(qa.surfaces[0].points, surface.points)
  qa.controller.dispose()
  qa.emit('command', qa.notch, { type: 'playNext' })
  assert.equal(qa.commands.length, 6)
})

test('visualization forwarding stops for hidden, reduced-motion, inactive-Space and destroyed surfaces', () => {
  const qa = setup(), chunks = []
  qa.notch.send = (channel, value) => { if (channel === 'notch:visualizerChunk') chunks.push(value) }
  qa.controller.interaction.configure({ enabled: true, restingView: 'oscilloscope', hoverEnabled: true, trackChangePopups: true, showOverFullscreen: true })
  qa.controller.publishVisualizerChunk({ reset: false })
  assert.equal(chunks.length, 0)
  qa.controller.publishSnapshot({ currentTrack: { path: 'track' }, playbackState: 'playing' })
  qa.controller.publishVisualizerChunk({ reset: false })
  assert.equal(chunks.length, 1)
  qa.emit('reducedMotion', qa.notch, true)
  qa.controller.publishVisualizerChunk({ reset: false })
  qa.emit('reducedMotion', qa.notch, false)
  qa.controller.onActiveSpace = false
  qa.controller.publishVisualizerChunk({ reset: false })
  qa.controller.dispose()
  qa.controller.publishVisualizerChunk({ reset: false })
  assert.equal(chunks.length, 1)
})
