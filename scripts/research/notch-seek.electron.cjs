// Real Chromium range-input regression check with delayed playback snapshots.
// Add --motion-check to check collapse, reversal, and reduced motion instead.
// No audio, native notch panel, or normal Astra profile is opened.
const { app, BrowserWindow, ipcMain } = require('electron')
const { buildSync } = require('esbuild')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const root = join(__dirname, '../..')
const output = mkdtempSync(join(tmpdir(), 'astra-notch-seek-'))
app.setPath('userData', join(output, 'profile'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const commands = []
let win
let state = { prefs: { enabled: true, restingView: 'hidden', hoverEnabled: true, trackChangePopups: true, showOverFullscreen: true },
  availability: 'available', attached: true, notchWidth: 185, notchHeight: 32, view: 'expanded', reason: 'expanded', proximity: 0, visualizerMode: 'off', error: null }
let snapshot = { currentTime: 8, duration: 100, playbackState: 'playing', volume: 0.6, isMuted: false,
  currentTrack: { path: 'fixture:a', title: 'Seek regression', artist: 'Silent fixture', artworkData: null } }
const sendSnapshot = () => win.webContents.send('fixture:snapshot', snapshot)
ipcMain.handle('fixture:state', () => state)
ipcMain.handle('fixture:snapshot', () => snapshot)
ipcMain.on('fixture:command', (_, command) => {
  commands.push(command)
  console.log('COMMAND', JSON.stringify(command))
  if (command.type === 'seek') {
    // Playback commits immediately but its next bridge snapshot arrives later.
    setTimeout(() => { snapshot = { ...snapshot, currentTime: command.time }; sendSnapshot() }, 500)
  }
})
ipcMain.on('fixture:collapse', () => {
  state = { ...state, view: 'hidden', reason: 'resting' }
  win.webContents.send('fixture:state', state)
})
writeFileSync(join(output, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
const subscribe=(channel,fn)=>{const listener=(_,value)=>fn(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener)};
contextBridge.exposeInMainWorld('electronAPI',{notch:{getState:()=>ipcRenderer.invoke('fixture:state'),getSnapshot:()=>ipcRenderer.invoke('fixture:snapshot'),onState:fn=>subscribe('fixture:state',fn),onSnapshot:fn=>subscribe('fixture:snapshot',fn),onVisualizerChunk:()=>()=>{},ready(){},setSurface(){},setReducedMotion(){},expand(){},collapse:()=>ipcRenderer.send('fixture:collapse'),openAstra:()=>ipcRenderer.send('fixture:collapse'),sendCommand:value=>ipcRenderer.send('fixture:command',value)}});`)
buildSync({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import NotchApp from './src/renderer/components/notch/NotchApp'; createRoot(document.getElementById('root')).render(<NotchApp/>);`,
  resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', outfile: join(output, 'renderer.js'), define: { 'process.env.NODE_ENV': '"production"' } })
writeFileSync(join(output, 'index.html'), '<!doctype html><html data-window-mode="notch"><head><link rel="stylesheet" href="renderer.css"><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
const query = code => win.webContents.executeJavaScript(code)
const read = () => query(`({value:document.querySelector('[aria-label="Seek"]').value,focus:document.activeElement?.getAttribute('aria-label')})`)
async function clickAt(x, y) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  await delay(20)
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  await delay(20)
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await delay(20)
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 440, height: 256, webPreferences: { preload: join(output, 'preload.cjs'), sandbox: false, backgroundThrottling: false, offscreen: true } })
  await win.loadFile(join(output, 'index.html'))
  await delay(400)
  try {
    if (process.argv.includes('--motion-check')) {
      await require('./notch-motion-check.cjs')({ win, output, setView: view => {
        state = { ...state, view, reason: view === 'expanded' ? 'expanded' : 'resting' }
        win.webContents.send('fixture:state', state)
      } })
      app.exit(0)
      return
    }
    const rect = await query(`document.querySelector('[aria-label="Seek"]').getBoundingClientRect().toJSON()`)
    // Range uses an 8px thumb, hence 4px inset at either end of its travel.
    await clickAt(Math.round(rect.x + 4 + (rect.width - 8) * 0.3), Math.round(rect.y + rect.height / 2))
    const released = await read()
    console.log('AFTER_RELEASE', JSON.stringify(released))
    assert.ok(Math.abs(Number(released.value) - 30) < 0.5, 'the slider must hold the seek target while its snapshot is pending')
    const close = await query(`document.querySelector('[aria-label="Collapse player"]').getBoundingClientRect().toJSON()`)
    await clickAt(Math.round(close.x + close.width / 2), Math.round(close.y + close.height / 2))
    assert.equal(Number((await read()).value), 30, 'closing before acknowledgement must retain the pending seek')
    state = { ...state, view: 'expanded', reason: 'expanded' }
    win.webContents.send('fixture:state', state)
    await delay(20)
    assert.equal(Number((await read()).value), 30, 'reopening before acknowledgement must retain the pending seek')
    await delay(600)
    console.log('AFTER_COLLAPSE', JSON.stringify({ ...await read(), playback: snapshot.currentTime, commands }))
    assert.equal(commands.length, 1, 'one pointer seek must not seek again on blur/collapse')
    assert.ok(Math.abs(snapshot.currentTime - 30) < 0.5, 'collapse must preserve the requested position')
    console.log('PASS pointer seek, immediate collapse/reopen, delayed acknowledgement')

    // A drag must survive stale snapshots while held and commit only once.
    commands.length = 0
    snapshot = { ...snapshot, currentTime: 8, currentTrack: { ...snapshot.currentTrack, path: 'fixture:b' } }
    sendSnapshot(); await delay(30)
    const y = Math.round(rect.y + rect.height / 2)
    const x = time => Math.round(rect.x + 4 + (rect.width - 8) * time / 100)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x(8), y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: x(8), y, button: 'left', clickCount: 1 })
    await delay(20)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x(60), y, button: 'left' })
    await delay(20)
    snapshot = { ...snapshot, currentTime: 8.2 }; sendSnapshot()
    await delay(20)
    assert.ok(Math.abs(Number((await read()).value) - 60) < 0.5)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x(60), y, button: 'left', clickCount: 1 })
    await delay(20)
    assert.ok(Math.abs(Number((await read()).value) - 60) < 0.5)
    await delay(550)
    await clickAt(Math.round(close.x + close.width / 2), Math.round(close.y + close.height / 2))
    assert.equal(commands.length, 1)
    assert.ok(Math.abs(snapshot.currentTime - 60) < 0.5)
    console.log('PASS drag with stale snapshots and blur after acknowledgement')

    commands.length = 0
    state = { ...state, view: 'expanded', reason: 'expanded' }
    win.webContents.send('fixture:state', state)
    await delay(350)
    await query(`document.querySelector('[aria-label="Seek"]').focus()`)
    const beforeKeyboard = Number((await read()).value)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
    await delay(20)
    assert.ok(Number((await read()).value) > beforeKeyboard)
    await query(`document.querySelector('[aria-label="Seek"]').blur()`)
    await delay(550)
    assert.equal(commands.length, 1)
    assert.ok(snapshot.currentTime > beforeKeyboard)
    console.log('PASS keyboard seek and blur')
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
setTimeout(() => { console.error('Notch seek check timed out'); app.exit(2) }, 15000).unref()
