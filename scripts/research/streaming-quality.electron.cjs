// Real settings controls in a temporary profile, with mocked IPC and no user servers.
const electron = require('electron')
if (typeof electron === 'string') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = electron
const { build } = require('esbuild')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const root = join(__dirname, '../..')
const output = mkdtempSync(join(require('node:os').tmpdir(), 'astra-quality-ui-'))
app.setPath('userData', join(output, 'profile'))
app.whenReady().then(async () => {
  await build({ stdin: { resolveDir: root, sourcefile: 'quality-fixture.tsx', loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import Quality from './src/renderer/components/settings/StreamingQualitySettings';
    let settings = {global:'original',overrides:{}}; const listeners = new Set();
    window.calls=[]; window.failWrite=false;
    window.electronAPI={
      getStreamingQuality:async()=>settings,
      setStreamingQuality:async(quality,source)=>{
        window.calls.push({quality,source}); if(window.failWrite) throw new Error('Disk full');
        settings=structuredClone(settings);
        if(source){ const key=source.provider+':'+source.sourceId;
          if(quality===null) delete settings.overrides[key]; else settings.overrides[key]=quality;
        } else settings.global=quality;
        for(const listener of listeners) listener(settings); return settings;
      }, onStreamingQualityChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)}
    };
    createRoot(document.getElementById('root')).render(<div style={{padding:32,maxWidth:1000,margin:'auto'}}>
      <div id="global"><Quality/></div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20,marginTop:20}}>
        <section id="navi" className="settings-card"><h4 className="settings-card-label">Navidrome</h4><Quality source={{provider:'subsonic',sourceId:1}}/></section>
        <section id="jelly" className="settings-card"><h4 className="settings-card-label">Jellyfin</h4><Quality source={{provider:'jellyfin',sourceId:1}}/></section>
      </div>
    </div>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: join(output, 'renderer.js') })
  writeFileSync(join(output, 'globals.css'), readFileSync(join(root, 'src/renderer/styles/globals.css')))
  writeFileSync(join(output, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="globals.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
  const win = new BrowserWindow({ show: false, width: 1100, height: 750, webPreferences: { backgroundThrottling: false, offscreen: true } })
  const errors = []
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  await win.loadFile(join(output, 'index.html'))
  const query = code => win.webContents.executeJavaScript(code)
  const settle = () => query('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const choose = async (id, value) => {
    await query(`{const select=document.querySelector('#${id} select'); select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true}));}`)
    await settle()
  }
  const selected = id => query(`document.querySelector('#${id} select').value`)
  await settle()
  assert.equal(await selected('global'), 'original')
  assert.equal(await selected('navi'), 'global')
  assert.equal(await selected('jelly'), 'global')
  assert.deepEqual(await query("Array.from(document.querySelector('#global select').options).map(o=>o.value)"), ['automatic', 'automatic-original', 'original', '64', '128', '192', '256', '320'])
  await choose('global', 'automatic')
  assert.match(await query("document.querySelector('#navi select').selectedOptions[0].text"), /Automatic/)
  await choose('jelly', 'automatic-original')
  await choose('global', 'automatic-original')
  assert.equal(await selected('jelly'), 'automatic-original')
  await choose('jelly', 'global')
  assert.match(await query("document.querySelector('#jelly select').selectedOptions[0].text"), /Automatic \(prioritize original\)/)
  writeFileSync(join(output, 'automatic.png'), (await win.webContents.capturePage()).toPNG())
  await choose('global', '128')
  assert.match(await query("document.querySelector('#navi select').selectedOptions[0].text"), /128 kbps/)
  await choose('navi', '320')
  await choose('jelly', 'original')
  await choose('global', '64')
  assert.equal(await selected('navi'), '320')
  assert.equal(await selected('jelly'), 'original')
  writeFileSync(join(output, 'overrides.png'), (await win.webContents.capturePage()).toPNG())
  await choose('navi', 'global')
  assert.match(await query("document.querySelector('#navi select').selectedOptions[0].text"), /64 kbps/)
  await query('window.failWrite=true')
  await choose('global', '256')
  assert.equal(await selected('global'), '64')
  assert.match(await query("document.querySelector('#global [role=alert]').textContent"), /Could not save/)
  assert.equal(await query("document.querySelector('#global select').disabled"), false)
  assert.equal(await query('window.calls.length'), 10)
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ passed: true, screenshots: output, checks: ['defaults', 'automatic modes', 'presets', 'inheritance', 'overrides', 'write failure'] }))
  win.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
