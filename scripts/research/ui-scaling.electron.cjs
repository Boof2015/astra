// Real renderer geometry and native input; synthetic library/audio, isolated user data.
// npm run test:ui-scaling [-- --dpr=2]
const electron = require('electron')
if (typeof electron === 'string') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, Menu } = electron
const { build } = require('esbuild')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const root = join(__dirname, '../..')
const output = mkdtempSync(join(tmpdir(), 'astra-ui-scaling-'))
const requestedDpr = process.argv.find(arg => arg.startsWith('--dpr='))?.split('=')[1] ?? '1'
app.commandLine.appendSwitch('force-device-scale-factor', requestedDpr)
app.setPath('userData', join(output, 'profile'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
const query = code => win.webContents.executeJavaScript(code)
const rect = selector => query(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`)
const near = (actual, expected, message, tolerance = 1.5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`)
async function settle() {
  await query('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await delay(40)
}
async function screenshot(name) {
  const file = join(output, `${name}.png`)
  writeFileSync(file, (await win.webContents.capturePage()).toPNG())
  console.log(`Screenshot: ${file}`)
}
async function dragTo(fractionX, fractionY, keepDown = false) {
  const point = await rect('.eq-band-point-shape')
  const area = await rect('.eq-response-svg')
  const x = Math.round(area.x + fractionX * area.width)
  const y = Math.round(area.y + fractionY * area.height)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x + point.width / 2), y: Math.round(point.y + point.height / 2) })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x + point.width / 2), y: Math.round(point.y + point.height / 2), button: 'left', clickCount: 1 })
  await delay(20)
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  await settle()
  if (!keepDown) win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  return { x, y, area }
}
async function testEQ(scale) {
  await query(`fixture.useUIStore.setState({ uiScalePercent: ${scale} }); fixture.resetBand()`)
  await settle()
  const target = await dragTo(0.72, 0.25)
  const handle = await rect('.eq-band-point-shape')
  near(handle.x + handle.width / 2, target.x, `EQ x follows cursor at ${scale}%`)
  near(handle.y + handle.height / 2, target.y, `EQ y follows cursor at ${scale}%`)
  await dragTo(1.05, -0.1)
  assert.deepEqual(await query('({frequency: fixture.useFixtureStore.getState().band.frequency, gain: fixture.useFixtureStore.getState().band.gain})'), { frequency: 20000, gain: 12 })
  await query('fixture.resetBand()')
  await settle()
  await dragTo(-0.05, 1.1)
  assert.deepEqual(await query('({frequency: fixture.useFixtureStore.getState().band.frequency, gain: fixture.useFixtureStore.getState().band.gain})'), { frequency: 20, gain: -12 })
  for (const type of ['highpass', 'lowpass']) {
    await query(`fixture.resetBand('${type}')`)
    await settle()
    const passTarget = await dragTo(0.65, 0.1)
    const passHandle = await rect('.eq-band-point-shape')
    near(passHandle.x + passHandle.width / 2, passTarget.x, `${type} x follows cursor`)
    assert.equal(await query('fixture.useFixtureStore.getState().band.gain'), 0)
  }
  await query('fixture.resetBand()')
  await settle()
  console.log(`PASS EQ cursor alignment, clamping, and pass filters at ${scale}%`)
}
async function checkMenu(scale) {
  const anchor = await rect('.sidebar-playlist-overflow-btn')
  const menu = await rect('.sidebar-playlist-popout')
  const viewport = await query('({ width: innerWidth, height: innerHeight })')
  const factor = scale / 100
  assert.ok(menu.x >= 10 * factor - 1)
  assert.ok(menu.right <= viewport.width - 10 * factor + 1)
  assert.ok(menu.y >= 10 * factor - 1)
  assert.ok(menu.bottom <= viewport.height - 10 * factor + 1)
  if (viewport.width > 600) near(menu.x, anchor.right + 12 * factor, 'menu anchored to button')
  near(menu.width, Math.min(304 * factor, viewport.width - 20 * factor), 'menu width')
  assert.equal(await query(`(() => { const el = document.querySelector('.sidebar-playlist-popout-list'); el.scrollTop = 100; return el.scrollTop > 0; })()`), true)
}
async function testRenderer() {
  await settle()
  assert.equal(await query('devicePixelRatio'), Number(requestedDpr))
  for (const scale of [80, 100, 125]) await testEQ(scale)
  // The SVG viewBox can change independently of its rendered dimensions.
  await query('fixture.useFixtureStore.setState({ viewWidth: 900, viewHeight: 120 })')
  await testEQ(80)
  await query('fixture.useFixtureStore.setState({ viewWidth: 600, viewHeight: 240 })')
  await query("document.querySelector('.sidebar-playlist-overflow-btn').click()")
  await delay(300)
  for (const scale of [80, 100, 125]) {
    await query(`fixture.useUIStore.setState({ uiScalePercent: ${scale} })`)
    await settle()
    await checkMenu(scale)
    await screenshot(`eq-menu-${scale}`)
    win.setSize(350, 500)
    await settle()
    await checkMenu(scale)
    win.setSize(1200, 900)
    await settle()
  }
  console.log('PASS More Playlists anchoring, live scale changes, edge clamping, and scrolling')
  await query("fixture.useFixtureStore.setState({ mode: 'spectrum' })")
  for (const scale of [80, 100, 125]) {
    await query(`fixture.useUIStore.setState({ uiScalePercent: ${scale} })`)
    for (const [width, height] of [[1200, 900], [950, 650]]) {
      win.setSize(width, height)
      await settle()
      const canvas = await rect('.fullscreen-ambient-canvas')
      const container = await rect('.fullscreen-ambient-spectrum')
      for (const edge of ['left', 'right', 'top', 'bottom']) near(canvas[edge], container[edge], `canvas ${edge} covers container at ${scale}%`)
      const backing = await query(`(() => { const c = document.querySelector('canvas'); return { width: c.width, height: c.height }; })()`)
      assert.ok(backing.width * backing.height <= 12_000_000)
      // This fixture remains below the memory limit, so the DPR cap determines resolution.
      near(backing.width, Math.floor(container.width / (scale / 100)) * Math.min(1.5, Number(requestedDpr) * scale / 100), 'canvas backing resolution', 2)
    }
    await screenshot(`spectrum-${scale}`)
  }
  assert.deepEqual(await query('rendererErrors'), [])
  console.log(`PASS fullscreen spectrum coverage, live resizing, and backing resolution at DPR ${requestedDpr}`)
}
async function testPopouts(installFixedWindowZoom) {
  // Include native menu accelerators: hiding the menu bar does not disable these.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] }]))
  const modifier = process.platform === 'darwin' ? 'meta' : 'control'
  for (const mode of ['mini', 'lyrics-popout']) {
    for (let opening = 0; opening < 2; opening++) {
      const popout = new BrowserWindow({ show: false, width: 420, height: 320, webPreferences: { offscreen: true, backgroundThrottling: false } })
      installFixedWindowZoom(popout.webContents)
      await popout.loadFile(join(output, 'popout.html'), { query: { window: mode } })
      const read = code => popout.webContents.executeJavaScript(code)
      await delay(50)
      for (const scale of [80, 100, 125]) {
        await query(`fixture.useUIStore.setState({ uiScalePercent: ${scale} })`)
        for (const keyCode of ['=', '+', '-', '0']) {
          popout.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [modifier] })
          popout.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [modifier] })
        }
        popout.webContents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaY: 120, modifiers: ['control'], canScroll: true })
        await delay(100)
        assert.equal(popout.webContents.getZoomLevel(), 0)
        assert.equal(await read('document.querySelector("div").getBoundingClientRect().width'), 100)
        assert.deepEqual(await read('zoomKeys'), [], 'zoom shortcuts never reach the renderer')
        assert.equal(await query('fixture.useUIStore.getState().uiScalePercent'), scale, 'popout shortcuts do not change main scale')
      }
      popout.setSize(500, 400)
      await delay(50)
      assert.equal(popout.webContents.getZoomLevel(), 0)
      // Reload must also clear inherited native page zoom.
      popout.webContents.setZoomLevel(1)
      await popout.loadFile(join(output, 'popout.html'), { query: { window: mode } })
      assert.equal(popout.webContents.getZoomLevel(), 0)
      popout.destroy()
    }
  }
  console.log('PASS mini/lyrics fixed zoom, shortcut and wheel suppression, resize, reload, and reopen')
}
app.whenReady().then(async () => {
  await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {FixtureApp} from './scripts/research/ui-scaling.fixture.jsx';
      window.rendererErrors = []; window.addEventListener('error', e => rendererErrors.push(e.message));
      createRoot(document.getElementById('root')).render(<React.StrictMode><FixtureApp/></React.StrictMode>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, platform: 'browser', outfile: join(output, 'renderer.js'),
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'scaling-fixtures', setup(builder) {
      builder.onResolve({ filter: /\/(?:stores\/(?:ui|library|playlist|graph|listeningStats|visualizerSettings)Store|audio\/eqAnalyzerFrameSource)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export * from ${JSON.stringify(join(__dirname, 'ui-scaling.fixture.jsx'))}`, resolveDir: root }))
      builder.onResolve({ filter: /\/CreatePlaylistModal$/ }, () => ({ path: 'modal', namespace: 'unused-modal' }))
      builder.onLoad({ filter: /.*/, namespace: 'unused-modal' }, () => ({ contents: 'export default () => null' }))
    } }]
  })
  await build({ entryPoints: [join(root, 'src/main/fixedWindowZoom.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(output, 'fixedWindowZoom.cjs') })
  writeFileSync(join(output, 'globals.css'), readFileSync(join(root, 'src/renderer/styles/globals.css')))
  writeFileSync(join(output, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="globals.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
  writeFileSync(join(output, 'popout.html'), '<!doctype html><div style="width:100px;height:100px">Popout</div><script>window.zoomKeys=[];addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&["+","=","-","0"].includes(e.key))zoomKeys.push(e.key)})</script>')
  win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false, offscreen: true } })
  await win.loadFile(join(output, 'index.html'))
  win.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 0, height: 0 },
    viewPosition: { x: 0, y: 0 }, viewSize: { width: 0, height: 0 }, deviceScaleFactor: Number(requestedDpr), scale: 1 })
  await testRenderer()
  await testPopouts(require(join(output, 'fixedWindowZoom.cjs')).installFixedWindowZoom)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
setTimeout(() => { console.error('UI scaling regression timed out'); app.exit(1) }, 120000).unref()
