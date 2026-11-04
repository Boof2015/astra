// Isolated UI smoke test: real sync controls/modal/store, mocked IPC and no server access.
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
const output = mkdtempSync(join(require('node:os').tmpdir(), 'astra-provider-sync-ui-'))
app.setPath('userData', join(output, 'profile'))
app.whenReady().then(async () => {
  await build({ stdin: { resolveDir: root, sourcefile: 'provider-sync-fixture.tsx', loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import Controls from './src/renderer/components/settings/ProviderSyncControls';
    import Modal from './src/renderer/components/sync/ProviderSyncReviewModal';
    import Notice from './src/renderer/components/layout/ProviderSyncNotice';
    import StarRating from './src/renderer/components/ratings/StarRating';
    import { useProviderSyncStore as store } from './src/renderer/stores/providerSyncStore';
    const ref = {provider:'subsonic', sourceId:1};
    const rows = [
      {key:'favorite-a', path:'a', id:'a', title:'BALALAIKA', artist:'9Lana', field:'favorite', local:false, server:true, reason:'initial'},
      {key:'rating-a', path:'a', id:'a', title:'BALALAIKA', artist:'9Lana', field:'rating', local:4.5, server:3, reason:'precision'},
      {key:'rating-b', path:'b', id:'b', title:'Second track', artist:'Another Artist', field:'rating', local:0.5, server:null, reason:'precision'}
    ];
    window.calls = []; window.starValue = null;
    window.electronAPI = {providerSync: {
      status:async()=>[{...ref,enabled:false,busy:false,conflicts:0,error:null,lastSyncAt:null}],
      review:async()=>({token:'review',ref,differences:rows,matchedTracks:8,missingTracks:1,enabling:true}),
      apply:async(token,choices)=>{window.calls.push({token,choices})},
      disable:async()=>{}, refresh:async()=>{}, onChanged:()=>()=>{}
    }};
    window.fixtureStore = store;
    store.getState().refreshStatus();
    createRoot(document.getElementById('root')).render(<div style={{padding:40}}>
      <div className="remote-source-card" style={{maxWidth:650}}><h2>My Navidrome</h2><Controls {...ref} connected /></div>
      <div id="whole" style={{marginTop:30}}><StarRating value={3.5} step={1} onCommit={value=>{window.starValue=value}} /></div>
      <Modal/><Notice/>
    </div>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: join(output, 'renderer.js'),
    plugins: [{name:'source-store-fixtures', setup(builder) {
      builder.onResolve({filter:/\/stores\/(subsonicSettingsStore|jellyfinSettingsStore)$/}, args=>({path:args.path,namespace:'fixture'}))
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const useSubsonicSettingsStore = selector => selector({sources:[{id:1,name:'My Navidrome'}]}); export const useJellyfinSettingsStore = selector => selector({sources:[]});`}))
    }}]
  })
  writeFileSync(join(output,'globals.css'),readFileSync(join(root,'src/renderer/styles/globals.css')))
  writeFileSync(join(output,'index.html'),'<!doctype html><html><head><link rel="stylesheet" href="globals.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
  const win = new BrowserWindow({show:false,width:1200,height:900,webPreferences:{backgroundThrottling:false,offscreen:true}})
  const errors=[]
  win.webContents.on('console-message',details=>{if(details.level==='error') errors.push(details.message)})
  await win.loadFile(join(output,'index.html'))
  const query = code => win.webContents.executeJavaScript(code)
  const settle = () => query('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const click = async text => {await query(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);await settle()}
  const screenshot = async name => {writeFileSync(join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())}
  await settle()
  assert.equal(await query('document.querySelector("[role=switch]").getAttribute("aria-checked")'),'false')
  await screenshot('disabled')
  await query('document.querySelector("#whole [role=slider]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true}))')
  assert.equal(await query('window.starValue'),4)
  await click('Disabled')
  assert.equal(await query('document.querySelector("[role=dialog]") !== null'),true)
  assert.equal(await query('window.calls.length'),0)
  assert.equal(await query('document.querySelector("[role=switch]").getAttribute("aria-checked")'),'false')
  await click('Keep Astra')
  assert.equal(await query('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Preview changes").disabled'),true)
  await click('Round up')
  await screenshot('comparison')
  await click('Preview changes')
  assert.equal(await query('window.calls.length'),0)
  assert.deepEqual(await query('Array.from(document.querySelectorAll("tbody tr")).map(r=>r.lastElementChild.textContent)'),['Not favorite','5 ★','1 ★'])
  await screenshot('preview')
  await click('Confirm and enable sync')
  assert.equal(await query('window.calls.length'),1)
  assert.equal(await query('document.querySelector("[role=dialog]") === null'),true)
  assert.equal(await query('getComputedStyle(document.querySelector(".provider-sync-notice")).pointerEvents'),'auto')
  await click('Dismiss')
  assert.equal(await query('document.querySelector(".provider-sync-notice") === null'),true)
  await query(`
    let cancelReview; let busy = false;
    window.electronAPI.providerSync.review = () => {busy = true; return new Promise((resolve, reject) => {cancelReview = reject})};
    window.electronAPI.providerSync.status = async () => [{provider:'subsonic',sourceId:1,enabled:false,busy,conflicts:0,error:null,lastSyncAt:null}];
    window.electronAPI.providerSync.disable = async () => {busy = false; cancelReview(new Error('The operation was aborted'))};
    void 0;
  `)
  await click('Disabled')
  await query('window.fixtureStore.getState().refreshStatus()')
  await settle()
  await click('Cancel comparison')
  assert.equal(await query('window.fixtureStore.getState().working'),false)
  assert.equal(await query('document.querySelector("[role=dialog]") === null'),true)
  assert.equal(await query('document.querySelector("[role=switch]").getAttribute("aria-checked")'),'false')
  assert.equal(await query('window.calls.length'),1)
  await click('Dismiss')
  await query(`
    let enabled = false;
    window.electronAPI.providerSync.review = async () => ({token:'agreed',ref:{provider:'subsonic',sourceId:1},differences:[],matchedTracks:214,missingTracks:186,enabling:!enabled});
    window.electronAPI.providerSync.status = async () => [{provider:'subsonic',sourceId:1,enabled,busy:false,conflicts:0,error:null,lastSyncAt:null}];
    window.electronAPI.providerSync.apply = async (token,choices) => {window.calls.push({token,choices}); enabled = true};
    window.dialogShown = false;
    window.dialogObserver = new MutationObserver(() => {if(document.querySelector('[role=dialog]')) window.dialogShown = true});
    window.dialogObserver.observe(document.body,{childList:true,subtree:true});
    void 0;
  `)
  await click('Disabled')
  assert.equal(await query('document.querySelector("[role=switch]").getAttribute("aria-checked")'),'true')
  assert.equal(await query('window.dialogShown'),false)
  assert.deepEqual(await query('window.calls.at(-1)'),{token:'agreed',choices:{}})
  assert.equal(await query('document.querySelector(".provider-sync-notice") === null'),true)
  await click('Review values')
  assert.equal(await query('window.dialogShown'),false)
  assert.equal(await query('window.calls.length'),3)
  assert.deepEqual(errors,[])
  console.log('UI checks passed. Screenshots:',output)
  win.destroy();app.quit()
}).catch(error=>{console.error(error);app.exit(1)})
