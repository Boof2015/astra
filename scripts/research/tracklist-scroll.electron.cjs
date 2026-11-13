// Real TrackList, real globals.css, native wheel input, a shown GPU-composited window; synthetic library.
// Reports where frame time goes while scrolling, per CSS/compositing variant.
// npm run test:tracklist-scroll [-- --variant=all --profile=both --dpr=1 --ui-scale=100 --tracks=20000 --extra-dom=0 --columns=title,artist --dev --frame-load-ms=0 --keep-traces]
const electron = require('electron')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const root = join(__dirname, '../..')
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value = 'true'] = arg.slice(2).split('=')
  return [key, value]
}))

// CSS variants are injected after load; switch variants need their own process.
const VARIANTS = {
  baseline: {},
  // The rule globals.css used to carry: with it, every row mount/unmount restyles the whole document.
  'old-drag-has': { css: 'body:has(.track-drag-overlay), body:has(.track-drag-overlay) * { cursor: grabbing !important; }' },
  // Rows pass under a stationary cursor while scrolling, so hover styling and its transitions restart constantly.
  'no-row-transitions': { css: '.track-row, .track-actions, .track-action-btn { transition: none !important; }' },
  'no-hover': { css: '.track-list-item { pointer-events: none !important; }' },
  'opaque-scroller': { css: '.track-list-virtualized { background: var(--bg-primary); }' },
  'no-blur': { css: '.titlebar, .transport-bar { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' },
  // Forces the low-DPI Windows/Linux rule (keep LCD text, only promote opaque scrollers) on any machine.
  'lcd-on': { switches: ['disable-prefer-compositing-to-lcd-text'] },
  'lcd-on+opaque-scroller': {
    switches: ['disable-prefer-compositing-to-lcd-text'],
    css: '.track-list-virtualized { background: var(--bg-primary); }'
  },
  'lcd-off': { switches: ['enable-prefer-compositing-to-lcd-text'] }
}
const PROFILES = {
  steady: { intervalMs: 50, durationMs: 5000 },
  fling: { intervalMs: 16, durationMs: 3000 }
}
const WHEEL_NOTCH_PX = 120
const TRACE_CATEGORIES = [
  'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'benchmark', 'cc', 'viz', 'gpu', 'input', 'toplevel', 'v8'
]
const MAIN_THREAD_BUCKETS = {
  scripting: ['FunctionCall', 'EvaluateScript', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'FireIdleCallback',
    'RunMicrotasks', 'MinorGC', 'MajorGC', 'v8.compile', 'v8.run', 'v8.callFunction', 'V8.GC_SCAVENGER',
    'V8.GC_MARK_COMPACTOR', 'V8.GC_MINOR_MS'],
  style: ['UpdateLayoutTree', 'ParseAuthorStyleSheet', 'RecalculateStyles'],
  layout: ['Layout', 'UpdateLayer', 'IntersectionObserverController::computeIntersections'],
  paint: ['PrePaint', 'Paint', 'PaintImage', 'Layerize', 'UpdateLayerTree', 'CompositeLayers', 'Commit']
}
const BUCKET_BY_EVENT = new Map(Object.entries(MAIN_THREAD_BUCKETS).flatMap(([bucket, names]) => names.map(name => [name, bucket])))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = (value, digits = 1) => Number(value.toFixed(digits))
const percentile = (sorted, fraction) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]

function completeEvents(events) {
  return events.filter(event => event.ph === 'X' && typeof event.dur === 'number').sort((a, b) => a.ts - b.ts || b.dur - a.dur)
}

// Union of every duration event on a thread: independent of which event names a Chromium version emits.
function busyMs(events) {
  let total = 0
  let end = -Infinity
  for (const event of completeEvents(events)) {
    const eventEnd = event.ts + event.dur
    if (event.ts >= end) total += event.dur
    else if (eventEnd > end) total += eventEnd - end
    end = Math.max(end, eventEnd)
  }
  return total / 1000
}

// Self time per bucket. Unnamed children inherit their nearest bucketed ancestor,
// so cc/viz/v8 detail events nested in a Layout still count as layout.
function mainThreadBuckets(events) {
  const totals = { scripting: 0, style: 0, layout: 0, paint: 0, other: 0 }
  const stack = []
  const close = entry => { totals[entry.bucket] += Math.max(0, entry.dur - entry.children) }
  for (const event of completeEvents(events)) {
    while (stack.length > 0 && stack[stack.length - 1].end <= event.ts) close(stack.pop())
    const parent = stack[stack.length - 1]
    const dur = parent ? Math.min(event.dur, parent.end - event.ts) : event.dur
    if (parent) parent.children += dur
    stack.push({ end: event.ts + dur, dur, children: 0, bucket: BUCKET_BY_EVENT.get(event.name) ?? parent?.bucket ?? 'other' })
  }
  while (stack.length > 0) close(stack.pop())
  return Object.fromEntries(Object.entries(totals).map(([bucket, micros]) => [bucket, round(micros / 1000)]))
}

// Names the JS entry point where the trace records one, so scripting time can be told apart by caller.
function eventLabel(event) {
  const data = event.args?.data
  if (event.name === 'FunctionCall' && data) {
    const file = String(data.url ?? '').split('/').pop().split('?')[0]
    return `FunctionCall ${data.functionName || '(anonymous)'} ${file}:${data.lineNumber ?? '?'}`
  }
  if (event.name === 'EventDispatch' && data?.type) return `EventDispatch ${data.type}`
  return event.name
}

function topSelfTimes(events, limit) {
  const totals = new Map()
  const stack = []
  const close = entry => totals.set(entry.label, (totals.get(entry.label) ?? 0) + Math.max(0, entry.dur - entry.children))
  for (const event of completeEvents(events)) {
    while (stack.length > 0 && stack[stack.length - 1].end <= event.ts) close(stack.pop())
    const parent = stack[stack.length - 1]
    const dur = parent ? Math.min(event.dur, parent.end - event.ts) : event.dur
    if (parent) parent.children += dur
    stack.push({ end: event.ts + dur, dur, children: 0, label: eventLabel(event) })
  }
  while (stack.length > 0) close(stack.pop())
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, micros]) => [label, round(micros / 1000)])
}

function summarizeTrace(tracePath, refreshHz, { detail = false } = {}) {
  const parsed = JSON.parse(readFileSync(tracePath, 'utf8'))
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents
  const threadNames = new Map()
  const processNames = new Map()
  for (const event of events) {
    if (event.ph !== 'M') continue
    if (event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args.name)
    if (event.name === 'process_name') processNames.set(event.pid, event.args.name)
  }
  const byThread = new Map()
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`
    if (!byThread.has(key)) byThread.set(key, [])
    byThread.get(key).push(event)
  }
  const threads = [...byThread].map(([key, list]) => ({
    key, events: list, pid: Number(key.split(':')[0]), name: threadNames.get(key) ?? ''
  }))
  // A spare renderer may exist; the one hosting the page is the busiest.
  const rendererMain = threads.filter(thread => thread.name === 'CrRendererMain').sort((a, b) => b.events.length - a.events.length)[0]
  const inRenderer = thread => rendererMain && thread.pid === rendererMain.pid
  const sumBusy = list => round(list.reduce((total, thread) => total + busyMs(thread.events), 0))
  const named = (list, name) => list.flatMap(thread => thread.events).filter(event => event.name === name)

  const droppedFrames = events.filter(event => event.name === 'PipelineReporter' && event.ph === 'b'
    && event.args?.frame_reporter?.state === 'STATE_DROPPED').length
  // elementCount is how many elements one recalc restyled; a row is ~70, so thousands means document-wide invalidation.
  const recalcs = rendererMain ? rendererMain.events.filter(event => event.name === 'UpdateLayoutTree' && event.ph === 'X') : []
  const restyled = recalcs.map(event => event.args?.elementCount ?? 0)
  const rasterTasks = named(threads.filter(inRenderer), 'RasterTask').filter(event => event.ph === 'X')
  // One BeginMainFrame is one main-thread frame: style, layout, paint and commit for whatever scripting dirtied.
  const mainFrameMs = (rendererMain ? rendererMain.events : [])
    .filter(event => event.name === 'ProxyMain::BeginMainFrame' && event.ph === 'X')
    .map(event => event.dur / 1000).sort((a, b) => a - b)
  const swaps = events
    .filter(event => event.name === 'Display::DrawAndSwap' && (event.ph === 'X' || event.ph === 'B'))
    .map(event => event.ts).sort((a, b) => a - b)
  const intervals = swaps.slice(1).map((ts, index) => (ts - swaps[index]) / 1000).sort((a, b) => a - b)
  const frameBudgetMs = 1000 / refreshHz
  const spanMs = swaps.length > 1 ? (swaps[swaps.length - 1] - swaps[0]) / 1000 : 0
  const stamps = events.filter(event => event.ph === 'X' && typeof event.ts === 'number').map(event => event.ts)
  const durationMs = stamps.length > 0 ? (stamps.reduce((a, b) => Math.max(a, b)) - stamps.reduce((a, b) => Math.min(a, b))) / 1000 : 0
  // Several loops call requestAnimationFrame; callbacks of one frame run back to back, so a gap starts a new frame.
  let animationFrames = 0
  let lastCallbackEnd = -Infinity
  for (const event of completeEvents(rendererMain ? rendererMain.events.filter(entry => entry.name === 'FireAnimationFrame') : [])) {
    if (event.ts - lastCallbackEnd > 1000) animationFrames++
    lastCallbackEnd = event.ts + event.dur
  }
  const threadNamed = name => threads.filter(thread => thread.name === name).sort((a, b) => b.events.length - a.events.length)[0]
  const top = thread => thread ? topSelfTimes(thread.events, 14) : []

  return {
    durationMs: round(durationMs),
    // Frames in which requestAnimationFrame callbacks ran, per second: what an in-page FPS counter reports.
    rafFps: durationMs > 0 ? round(animationFrames / (durationMs / 1000)) : 0,
    browserMainBusyMs: sumBusy([threadNamed('CrBrowserMain')].filter(Boolean)),
    ...(detail ? { hot: {
      rendererMain: top(rendererMain),
      rendererCompositor: top(threads.find(thread => inRenderer(thread) && thread.name === 'Compositor')),
      gpuMain: top(threadNamed('CrGpuMain')),
      vizCompositor: top(threadNamed('VizCompositorThread')),
      browserMain: top(threadNamed('CrBrowserMain'))
    } } : {}),
    frames: {
      swaps: swaps.length,
      fps: spanMs > 0 ? round((swaps.length - 1) / (spanMs / 1000)) : 0,
      p50Ms: round(percentile(intervals, 0.5)),
      p95Ms: round(percentile(intervals, 0.95)),
      worstMs: round(intervals[intervals.length - 1] ?? 0),
      // An interval over 1.5 budgets means at least one vsync passed with no new frame.
      slowIntervals: intervals.filter(interval => interval > frameBudgetMs * 1.5).length,
      dropped: droppedFrames
    },
    mainFrames: {
      count: mainFrameMs.length,
      p50Ms: round(percentile(mainFrameMs, 0.5)),
      p95Ms: round(percentile(mainFrameMs, 0.95)),
      worstMs: round(mainFrameMs[mainFrameMs.length - 1] ?? 0),
      overBudget: mainFrameMs.filter(ms => ms > frameBudgetMs).length
    },
    styleRecalcs: {
      count: recalcs.length,
      elementsPerRecalc: recalcs.length > 0 ? Math.round(restyled.reduce((total, count) => total + count, 0) / recalcs.length) : 0,
      largest: Math.max(0, ...restyled)
    },
    mainThread: rendererMain ? mainThreadBuckets(rendererMain.events) : null,
    mainBusyMs: rendererMain ? round(busyMs(rendererMain.events)) : 0,
    compositorBusyMs: sumBusy(threads.filter(thread => inRenderer(thread) && thread.name === 'Compositor')),
    // Renderer-side raster only records and serializes; with GPU raster the pixels are produced on CrGpuMain.
    rasterMs: round(rasterTasks.reduce((total, event) => total + event.dur, 0) / 1000),
    rasterTasks: rasterTasks.length,
    vizBusyMs: sumBusy(threads.filter(thread => thread.name === 'VizCompositorThread')),
    gpuMainBusyMs: sumBusy(threads.filter(thread => thread.name === 'CrGpuMain')),
    processes: [...new Set(processNames.values())]
  }
}

async function buildFixture(output) {
  const { build } = require('esbuild')
  await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import '@fontsource/inter/400.css'; import '@fontsource/inter/500.css'; import '@fontsource/inter/600.css';
      import '@fontsource/inter/700.css'; import '@fontsource/jetbrains-mono/400.css'; import '@fontsource/jetbrains-mono/500.css';
      import './src/renderer/styles/globals.css';
      import {FixtureApp} from './scripts/research/tracklist-scroll.fixture.jsx';
      window.rendererErrors = []; window.addEventListener('error', e => rendererErrors.push(e.message));
      createRoot(document.getElementById('root')).render(${args.dev ? '<React.StrictMode><FixtureApp/></React.StrictMode>' : '<FixtureApp/>'});`, resolveDir: root, loader: 'tsx' },
    bundle: true, platform: 'browser', outfile: join(output, 'renderer.js'),
    // Production React by default; --dev matches npm run dev (development React under StrictMode).
    define: { 'process.env.NODE_ENV': args.dev ? '"development"' : '"production"' },
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
    logLevel: 'error',
    plugins: [{ name: 'tracklist-scroll-fixtures', setup(builder) {
      builder.onResolve({ filter: /\/(?:stores\/[A-Za-z]+Store|hooks\/useOpen(?:Artist|Album)InLibrary)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export * from ${JSON.stringify(join(__dirname, 'tracklist-scroll.fixture.jsx'))}`, resolveDir: root }))
      builder.onResolve({ filter: /\/(?:CreatePlaylistModal|RatingCalibrationLadder)$/ }, () => ({ path: 'unused', namespace: 'unused-component' }))
      builder.onLoad({ filter: /.*/, namespace: 'unused-component' }, () => ({ contents: 'export default () => null' }))
    } }]
  })
  writeFileSync(join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>')
}

function printTable(results) {
  const columns = [
    ['variant', result => result.variant], ['profile', result => result.profile],
    ['raf fps', result => result.rafFps], ['fps', result => result.frames.fps], ['p50', result => result.frames.p50Ms], ['p95', result => result.frames.p95Ms],
    ['worst', result => result.frames.worstMs], ['slow', result => result.frames.slowIntervals], ['drop', result => result.frames.dropped],
    ['mframes', result => result.mainFrames.count], ['mf p50', result => result.mainFrames.p50Ms],
    ['mf p95', result => result.mainFrames.p95Ms], ['mf>budget', result => result.mainFrames.overBudget],
    ['script', result => result.mainThread?.scripting], ['style', result => result.mainThread?.style],
    ['recalcs', result => result.styleRecalcs.count], ['el/recalc', result => result.styleRecalcs.elementsPerRecalc],
    ['layout', result => result.mainThread?.layout], ['paint', result => result.mainThread?.paint],
    ['main', result => result.mainBusyMs], ['raster', result => result.rasterMs],
    ['viz', result => result.vizBusyMs], ['gpu', result => result.gpuMainBusyMs], ['scrolled', result => result.scrolledPx]
  ]
  const rows = [columns.map(([title]) => title), ...results.map(result => columns.map(([, read]) => String(read(result) ?? '-')))]
  const widths = columns.map((_, index) => Math.max(...rows.map(row => row[index].length)))
  for (const row of rows) console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
}

async function orchestrate() {
  const output = mkdtempSync(join(tmpdir(), 'astra-tracklist-scroll-'))
  await buildFixture(output)
  const variants = !args.variant || args.variant === 'all' ? Object.keys(VARIANTS) : args.variant.split(',')
  const profiles = !args.profile || args.profile === 'both' ? Object.keys(PROFILES) : args.profile.split(',')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const results = []
  for (const variant of variants) {
    if (!VARIANTS[variant]) throw new Error(`Unknown variant ${variant}; expected ${Object.keys(VARIANTS).join(', ')}`)
    for (const profile of profiles) {
      if (!PROFILES[profile]) throw new Error(`Unknown profile ${profile}; expected ${Object.keys(PROFILES).join(', ')}`)
      const forwarded = ['dpr', 'ui-scale', 'tracks', 'extra-dom', 'columns', 'frame-load-ms', 'strip-rules', 'keep-traces'].filter(key => args[key]).map(key => `--${key}=${args[key]}`)
      const child = spawnSync(electron, [__filename, '--child', `--out=${output}`, `--variant=${variant}`, `--profile=${profile}`, ...forwarded],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, timeout: 150000 })
      const line = child.stdout?.split('\n').find(text => text.startsWith('RESULT '))
      if (child.status !== 0 || !line) throw new Error(`${variant}/${profile} failed (exit ${child.status})\n${child.stdout ?? ''}`)
      results.push(JSON.parse(line.slice('RESULT '.length)))
      console.error(`done ${variant}/${profile}`)
    }
  }
  const first = results[0]
  console.log(`\n${process.platform} ${process.arch} | ${args.dev ? 'development' : 'production'} React | electron ${first.electron} | ${first.refreshHz} Hz | dpr ${first.dpr} | ui scale ${first.uiScale}% | ${first.tracks} tracks | ${first.mountedRows} rows mounted, ${first.nodesPerRow} elements per row, ${first.documentElements} in the document`)
  console.log('Times are ms summed over the run. slow = frame intervals over 1.5 refresh periods. mf = main-thread frames. raf fps needs --frame-load-ms. Tracing adds overhead, so compare rows, not absolutes.\n')
  printTable(results)
  writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2))
  // Each trace is ~100 MB, so they are only kept on request.
  console.log(`\n${args['keep-traces'] ? 'Traces (open in DevTools Performance) and results.json' : 'results.json (add --keep-traces to keep the traces)'}: ${output}`)
}

async function runChild() {
  const { app, BrowserWindow, contentTracing, nativeImage, protocol, screen } = electron
  const variant = VARIANTS[args.variant]
  const profile = PROFILES[args.profile]
  const runName = `${args.variant}-${args.profile}`
  for (const name of variant.switches ?? []) app.commandLine.appendSwitch(name)
  if (args.dpr) app.commandLine.appendSwitch('force-device-scale-factor', args.dpr)
  app.setPath('userData', join(args.out, `profile-${runName}`))
  // Same privileges as the app's own registration, so image loads take the same path.
  protocol.registerSchemesAsPrivileged([{ scheme: 'astra-artwork',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])
  setTimeout(() => { console.error(`Tracklist scroll run ${runName} timed out`); app.exit(1) }, 120000).unref()

  await app.whenReady()
  const artwork = new Map()
  protocol.handle('astra-artwork', request => {
    const hash = decodeURIComponent(new URL(request.url).pathname.split('/').pop())
    if (!artwork.has(hash)) {
      // 96px JPEG like the real tracklist thumbnail; a per-hash gradient keeps decode work non-trivial.
      const size = 96
      const shade = [...hash].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7)
      const pixels = Buffer.alloc(size * size * 4)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = (y * size + x) * 4
          pixels[offset] = (shade + x * 2) & 255
          pixels[offset + 1] = ((shade >> 8) + y * 2) & 255
          pixels[offset + 2] = ((shade >> 16) + x + y) & 255
          pixels[offset + 3] = 255
        }
      }
      artwork.set(hash, nativeImage.createFromBitmap(pixels, { width: size, height: size }).toJPEG(78))
    }
    return new Response(new Uint8Array(artwork.get(hash)), { headers: {
      'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*'
    } })
  })

  // Shown and not offscreen: the point is the real GPU compositing path.
  const win = new BrowserWindow({ show: true, width: 1400, height: 900, backgroundColor: '#05070c', webPreferences: { backgroundThrottling: false } })
  const query = code => win.webContents.executeJavaScript(code)
  await win.loadFile(join(args.out, 'index.html'), { query: { tracks: args.tracks ?? '20000', uiScale: args['ui-scale'] ?? '100', extraDom: args['extra-dom'] ?? '0', columns: args.columns ?? '', frameLoadMs: args['frame-load-ms'] ?? '0' } })
  for (let attempt = 0; attempt < 100 && !(await query('document.querySelectorAll(".track-row").length > 0')); attempt++) await delay(50)
  await query('document.fonts.ready.then(() => true)')
  // macOS ignores force-device-scale-factor for a shown window, so say so rather than mislabel the run.
  if (args.dpr && Number(args.dpr) !== await query('devicePixelRatio')) console.error(`--dpr=${args.dpr} was not applied on this platform`)
  if (variant.css) await win.webContents.insertCSS(variant.css)
  // --strip-rules=<regex> is a bisect aid: delete every style rule whose selector matches, e.g. ':has\\('
  const stripRules = [variant.stripRules, args['strip-rules']].filter(Boolean)
  for (const source of stripRules) {
    const stripped = await query(`(() => {
      const pattern = new RegExp(${JSON.stringify(source)})
      let count = 0
      const visit = owner => {
        for (let index = owner.cssRules.length - 1; index >= 0; index--) {
          const rule = owner.cssRules[index]
          if (rule.selectorText && pattern.test(rule.selectorText)) { owner.deleteRule(index); count++ }
          else if (rule.cssRules) visit(rule)
        }
      }
      for (const sheet of document.styleSheets) visit(sheet)
      return count
    })()`)
    if (stripped === 0) throw new Error(`No style rule matches ${source}`)
    console.error(`stripped ${stripped} rules matching ${source}`)
  }
  win.focus()
  await delay(800)

  const page = await query(`(() => {
    const scroller = document.querySelector('.track-list-virtualized')
    const rect = scroller.getBoundingClientRect()
    const rows = document.querySelectorAll('.track-list-item')
    return {
      x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2),
      dpr: devicePixelRatio, mountedRows: rows.length,
      nodesPerRow: Math.round([...rows].reduce((total, row) => total + row.querySelectorAll('*').length + 1, 0) / rows.length),
      documentElements: document.querySelectorAll('*').length,
      tracks: Number(new URLSearchParams(location.search).get('tracks'))
    }
  })()`)
  const wheel = () => win.webContents.sendInputEvent({ type: 'mouseWheel', x: page.x, y: page.y, deltaX: 0, deltaY: -WHEEL_NOTCH_PX, canScroll: true })
  // Park the cursor over the list so hover styling is part of the run, then warm up outside the trace.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: page.x, y: page.y })
  for (let notch = 0; notch < 5; notch++) { wheel(); await delay(60) }
  await delay(700)
  const startTop = await query('document.querySelector(".track-list-virtualized").scrollTop')

  await query('window.fixtureFrames && (window.fixtureFrames.length = 0)')
  await contentTracing.startRecording({ included_categories: TRACE_CATEGORIES })
  const startedAt = performance.now()
  const notches = Math.round(profile.durationMs / profile.intervalMs)
  for (let notch = 0; notch < notches; notch++) {
    wheel()
    await delay(Math.max(0, startedAt + (notch + 1) * profile.intervalMs - performance.now()))
  }
  // What a requestAnimationFrame counter such as the titlebar FPS readout would show during the scroll.
  const rafFps = await query(`window.fixtureFrames && window.fixtureFrames.length > 1
    ? Math.round((window.fixtureFrames.length - 1) * 1000 / (window.fixtureFrames.at(-1) - window.fixtureFrames[0])) : null`)
  await delay(400)
  const tracePath = await contentTracing.stopRecording(join(args.out, `trace-${runName}.json`))

  const scrolledPx = Math.round(await query('document.querySelector(".track-list-virtualized").scrollTop') - startTop)
  const errors = await query('rendererErrors')
  if (errors.length > 0) throw new Error(`Renderer errors: ${errors.join('; ')}`)
  const refreshHz = Math.round(screen.getPrimaryDisplay().displayFrequency || 60)
  const summary = summarizeTrace(tracePath, refreshHz)
  if (!args['keep-traces']) rmSync(tracePath, { force: true })
  console.log(`RESULT ${JSON.stringify({
    variant: args.variant, profile: args.profile, electron: process.versions.electron, refreshHz,
    dpr: page.dpr, uiScale: Number(args['ui-scale'] ?? 100), tracks: page.tracks,
    mountedRows: page.mountedRows, nodesPerRow: page.nodesPerRow, documentElements: page.documentElements,
    scrolledPx, rafFps, tracePath: args['keep-traces'] ? tracePath : null,
    ...summary
  })}`)
  app.exit(0)
}

// Exported so a trace captured some other way (e.g. from the real app over CDP) gets the same summary.
module.exports = { summarizeTrace, printTable, TRACE_CATEGORIES }

// Under Electron this file is always the app entry; under node it is either the CLI or a library.
if (typeof electron !== 'string') {
  if (args.child) runChild().catch(error => { console.error(error); electron.app.exit(1) })
  else { console.error('Run with node (npm run test:tracklist-scroll), not electron directly.'); electron.app.exit(1) }
} else if (require.main === module) {
  orchestrate().catch(error => { console.error(error); process.exit(1) })
}
