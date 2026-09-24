// Exercises the real palette and react-window in Chromium with synthetic stores.
// npm run test:quick-search [-- --production | --visual-check]
const electron = require('electron')
if (typeof electron === 'string') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = electron
const { build } = require('esbuild')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const root = join(__dirname, '../..')
const output = mkdtempSync(join(tmpdir(), 'astra-quick-search-'))
const production = process.argv.includes('--production')
const visualCheck = process.argv.includes('--visual-check')
app.setPath('userData', join(output, 'profile'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
const query = code => win.webContents.executeJavaScript(code)
async function until(code, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await query(code)) return
    await delay(20)
  }
  throw new Error(`Timed out: ${message}\n${JSON.stringify(await query(`({errors: rendererErrors, text: document.body.innerText, selected: document.querySelector('.selected')?.textContent})`))}`)
}
async function key(keyCode) {
  keyCode = keyCode.replace(/^Arrow/, '')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  await delay(30)
}
async function input(value) {
  await query(`(() => {
    const input = document.querySelector('.quick-launch-input');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(30)
}
async function click(selector, index = 0) {
  const rect = await query(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect().toJSON()`)
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  // Two moves enable intentional hover selection just as in the app.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: x - 10, y })
  await delay(30)
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  await delay(30)
  // Enter the row again once hover selection has been enabled by panel motion.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 })
  await delay(20)
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  await delay(20)
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await delay(40)
}
async function open() {
  await query('fixture.useUIStore.getState().closeQuickLaunch()')
  await until("!document.querySelector('.quick-launch-overlay')", 'palette closed')
  await query('fixture.useUIStore.getState().openQuickLaunch()')
  await until("document.activeElement?.className === 'quick-launch-input' && !document.querySelector('.quick-launch-status')", 'palette ready')
}
async function artistEditor() {
  await open()
  await input('@artist')
  await key('Enter')
  await until("document.querySelector('.ql-editor-prefix')?.textContent === '@artist'", 'artist editor')
}

async function selectArtist(index, method = 'keyboard') {
  await artistEditor()
  if (method === 'mouse') {
    await click('.ql-suggestion-group button', index)
  } else {
    for (let row = 0; row < index; row++) await key('ArrowDown')
    if (method === 'completion') {
      await key('Tab')
      assert.equal(await query("document.querySelector('.quick-launch-input').value"), await query(`fixture.artistNames[${index}]`))
    }
    await key('Enter')
  }
  await selectedTrack(index)
  assert.equal(await query("document.querySelector('.ql-token-chip strong').textContent"), await query(`fixture.artistNames[${index}]`))
}

async function selectedTrack(artist, index = 0) {
  await until(`document.querySelector('.ql-structured-track-list .selected .quick-launch-result-label')?.textContent === ${JSON.stringify(`Song ${artist} ${index}`)}`, 'expected selected track')
  assert.equal(await query("document.querySelectorAll('.ql-structured-track-list .selected').length"), 1)
  assert.deepEqual(await query('rendererErrors'), [])
  assert.deepEqual(await query('boundaryErrors'), [])
}

async function regressions() {
  const initialLoads = await query('fixture.pageLoads')
  const count = await query('fixture.artistNames.length')
  for (const method of ['mouse', 'keyboard', 'completion']) {
    for (let artist = 0; artist < count; artist++) {
      await selectArtist(artist, method)
      await query('fixture.commands.length = 0')
      if (method === 'completion') {
        await input('/queue')
        await key('Enter')
        await selectedTrack(artist)
      }
      await key(method === 'keyboard' ? 'Tab' : 'Enter')
      await until('fixture.commands.length === 1', 'track action')
      const command = await query('fixture.commands[0]')
      assert.equal(command.action, method === 'mouse' ? 'play' : method === 'keyboard' ? 'next' : 'end')
      assert.equal(command.paths[command.startIndex ?? 0], `fixture:${artist}:0`)
      assert.equal(await query('fixture.useUIStore.getState().isQuickLaunchOpen'), false)
    }
    console.log(`PASS ${method}: all artist names, literal chip values, and track actions`)
  }
  assert.equal(await query('fixture.pageLoads'), initialLoads, 'healthy reopen preserves the corpus cache')

  await selectArtist(0)
  await key('ArrowUp')
  await selectedTrack(0, 7)
  await input('Song')
  await selectedTrack(0)
  await input('7')
  await selectedTrack(0, 7)
  assert.equal(await query("document.querySelectorAll('.ql-structured-track-list .quick-launch-result-row').length"), 1)
  await input('no-match-anywhere')
  await until("document.querySelector('.ql-empty')", 'empty results')
  const commandsBeforeEmpty = await query('fixture.commands.length')
  await key('Enter')
  await key('Tab')
  assert.equal(await query('fixture.commands.length'), commandsBeforeEmpty)
  await input('')
  await selectedTrack(0)
  await key('ArrowUp')
  await selectedTrack(0, 7)
  await query('fixture.refresh(fixture.tracks.filter(track => track.artist !== fixture.artistNames[0] || track.track_number <= 2))')
  await until("!document.querySelector('.quick-launch-status')", 'shorter corpus loaded')
  await selectedTrack(0, 1)
  await query('fixture.refresh(fixture.tracks)')
  await until("!document.querySelector('.quick-launch-status')", 'full corpus restored')
  await selectedTrack(0, 1)
  console.log('PASS query narrowing, empty actions, asynchronous shrink and growth without resurrecting the old index')

  await selectArtist(1)
  await click('.ql-token-chip')
  await until("document.querySelector('.ql-editor-prefix')", 'chip editor')
  assert.equal(await query("document.querySelector('.quick-launch-input').value"), await query('fixture.artistNames[1]'))
  await key('Escape')
  await selectedTrack(1)
  await click('.ql-token-chip')
  await input('')
  await key('Backspace')
  assert.equal(await query("Boolean(document.querySelector('.ql-editor-prefix') || document.querySelector('.ql-token-chip'))"), false)
  await input('@artist')
  await key('Enter')
  await input('*NSYNC')
  await key('Tab')
  await key('Enter')
  await selectedTrack(5)
  await key('Backspace')
  await key('Backspace')
  assert.equal(await query("Boolean(document.querySelector('.ql-token-chip'))"), false)
  console.log('PASS editing, cancelling, removing and reapplying artist filters')

  await open()
  await input('@playlist')
  await key('Enter')
  await key('ArrowDown') // Favorites is first; the delayed playlist is second.
  await key('Enter')
  await until("document.querySelector('.quick-launch-status')?.textContent === 'Loading playlist…'", 'playlist pending')
  assert.equal(await query("Boolean(document.querySelector('.ql-structured-track-list'))"), false)
  await query('fixture.resolvePlaylist()')
  await selectedTrack(1)
  console.log('PASS asynchronous playlist scope switches from suggestions to one track')

  // A selected suggestion must also reset when Escape dismisses a command list.
  await selectArtist(1)
  await input('/')
  for (let index = 0; index < 5; index++) await key('ArrowDown')
  await key('Escape')
  await until("!document.querySelector('.ql-suggestion-group')", 'command list dismissed')
  await input('')
  await selectedTrack(1)

  for (const [failure, dismissal] of [['render', 'button'], ['effect', 'escape'], ['render', 'backdrop']]) {
    await open()
    await query(`fixture.useUIStore.setState({ failure: ${JSON.stringify(failure)} })`)
    await until("document.getElementById('quick-launch-failure')", 'local recovery fallback')
    assert.equal(await query("document.getElementById('quick-launch-failure').textContent"), 'Quick Search couldn’t open. Close it and try again.')
    assert.equal(await query('document.activeElement.textContent'), 'Close')
    assert.ok(await query("boundaryErrors.some(message => message.includes('Injected Quick Search'))"))
    assert.deepEqual(await query('rendererErrors'), [], 'the boundary contains the failure')
    await query("document.getElementById('app-control').click()")
    assert.match(await query("document.getElementById('app-control').textContent"), /App clicks: [1-9]/)
    await query('fixture.useUIStore.setState({ failure: null })')
    if (dismissal === 'button') await click('.quick-launch-panel button')
    else if (dismissal === 'escape') await key('Escape')
    else await query("document.querySelector('.quick-launch-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
    await until("!document.querySelector('.quick-launch-overlay')", 'fallback dismissed')
    assert.equal(await query('fixture.useUIStore.getState().isQuickLaunchOpen'), false)
    await query('boundaryErrors.length = 0')
    await selectArtist(1)
  }
  assert.equal(await query("document.getElementById('app-control').textContent"), 'App clicks: 3', 'surrounding app never remounted')
  console.log('PASS render/effect containment, all dismissals, focus, recovery, and surrounding app state')
}

app.whenReady().then(async () => {
  await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {SurroundingApp} from './scripts/research/quick-search.fixture.jsx';
        import QuickLaunchPalette from './src/renderer/components/layout/QuickLaunchPalette';
        window.rendererErrors = []; window.addEventListener('error', event => window.rendererErrors.push(event.message));
        window.boundaryErrors = []; const reportError = console.error;
        console.error = (...args) => { if (args[0] === 'Quick Search failed:') boundaryErrors.push(String(args[1])); reportError(...args); };
        createRoot(document.getElementById('root')).render(<React.StrictMode><SurroundingApp><QuickLaunchPalette/></SurroundingApp></React.StrictMode>);`,
      resolveDir: root, loader: 'tsx'
    },
    bundle: true, platform: 'browser', outfile: join(output, 'renderer.js'),
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
    plugins: [{ name: 'synthetic-stores', setup(builder) {
      builder.onResolve({ filter: /\/(?:stores\/(?:ui|library|graph|listeningStats|player|playlist)Store|hooks\/useInputActionDispatcher)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `export * from ${JSON.stringify(join(__dirname, 'quick-search.fixture.jsx'))}`,
        resolveDir: root
      }))
    } }]
  })
  writeFileSync(join(output, 'index.html'), `<!doctype html><html><head><style>
    body { margin: 0; font: 14px sans-serif; } button { font: inherit; }
    .quick-launch-overlay { position: fixed; inset: 0; padding: 50px; }
    .quick-launch-panel { width: 700px; background: white; }
    .quick-launch-result-row { display: flex; width: 100%; height: 40px; }
    .quick-launch-result-text { display: flex; flex-direction: column; }
    .quick-launch-input { width: 500px; }
    .ql-thumb { width: 20px; }
  </style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  win = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { backgroundThrottling: false, offscreen: true } })
  await win.loadFile(join(output, 'index.html'))
  if (visualCheck) {
    await open()
    await query("fixture.useUIStore.setState({ failure: 'render' })")
    await until("document.getElementById('quick-launch-failure')", 'recovery dialog')
    await query("document.querySelector('style').remove()")
    await win.webContents.insertCSS(readFileSync(join(root, 'src/renderer/styles/globals.css'), 'utf8'))
    for (const [width, height] of [[1000, 900], [400, 600]]) {
      win.setSize(width, height)
      await delay(100)
      const imagePath = join(output, `recovery-${width}.png`)
      writeFileSync(imagePath, (await win.webContents.capturePage()).toPNG())
      console.log(`Recovery screenshot: ${imagePath}`)
      assert.equal(await query('document.documentElement.scrollWidth <= innerWidth'), true)
    }
    app.exit(0)
    return
  }
  await artistEditor()
  await click('.ql-suggestion-group button', 1)
  await until("document.querySelector('.ql-structured-track-list .selected')", 'selected track')
  assert.deepEqual(await query('rendererErrors'), [])
  console.log('PASS selecting the second artist with one track')
  await regressions()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
setTimeout(() => { console.error('Quick Search regression timed out'); app.exit(1) }, 120000).unref()
