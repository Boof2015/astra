// Measures the real running app while you scroll by hand: real music, real scopes, real input device.
// 1. npm run dev -- --remoteDebuggingPort 9333
// 2. Start playback and open the tracklist you want to test.
// 3. npm run trace:tracklist-scroll [-- --seconds=6 --idle-seconds=3 --hz=175 --try=opaque-scroller --auto --trace]
// It samples a few idle seconds, then asks you to scroll, and prints both side by side.
// Default mode uses the page's CPU profiler and counters, which only need the renderer to answer.
// --trace records a full Chromium trace instead (per-thread GPU detail), but stopping it can hang on some machines.
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { summarizeTrace } = require('./tracklist-scroll.electron.cjs')

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value = 'true'] = arg.slice(2).split('=')
  return [key, value]
}))
const port = Number(args.port ?? 9333)
const scrollSeconds = Number(args.seconds ?? 6)
const idleSeconds = Number(args['idle-seconds'] ?? 3)
const STEP_TIMEOUT_MS = 30000
// Leaner than the fixture harness: these runs are longer and the scopes add a lot of events.
const TRACE_CATEGORIES = [
  'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'benchmark', 'viz', 'gpu', 'toplevel'
]
// Applied to the live page only; reload the app to undo.
const EXPERIMENTS = {
  'opaque-scroller': { css: '.track-list-virtualized, .library-artist-detail, .library-year-detail { background: var(--bg-primary); }' },
  'no-blur': { css: '.titlebar, .transport-bar { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' },
  'no-rating-has': { stripRules: '\\.track-list-(body|item):has' },
  'no-has': { stripRules: ':has\\(' }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = (value, digits = 1) => Number(value.toFixed(digits))
const percentile = (sorted, fraction) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`Cannot connect to ${url}`)) })
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  socket.onmessage = message => {
    const data = JSON.parse(message.data)
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) reject(new Error(`${data.error.message}`))
      else resolve(data.result)
    } else if (data.method) {
      for (const listener of listeners.get(data.method) ?? []) listener(data.params)
    }
  }
  // Every call names itself on timeout, so a hang says which step never answered.
  const timed = (label, promise, timeoutMs = STEP_TIMEOUT_MS) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs / 1000} s`)), timeoutMs).unref())
  ])
  return {
    send: (method, params = {}, timeoutMs) => timed(method, new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    }), timeoutMs),
    once: (method, timeoutMs) => timed(method, new Promise(resolve => listeners.set(method, [resolve])), timeoutMs),
    close: () => socket.close()
  }
}

async function evaluate(client, expression, timeoutMs) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

function printTable(rows) {
  const table = [['', 'idle', 'scrolling'], ...rows]
  const widths = [0, 1, 2].map(index => Math.max(...table.map(row => row[index].length)))
  for (const row of table) console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
}

function printRanked(title, idle, scroll, limit) {
  const idleByLabel = new Map(idle ?? [])
  console.log(`\n${title} (ms while scrolling, idle in brackets)`)
  for (const [label, ms] of (scroll ?? []).slice(0, limit)) console.log(`  ${String(ms).padStart(8)}  [${String(idleByLabel.get(label) ?? 0).padStart(7)}]  ${label}`)
}

// ---- Default mode: CPU profile + counters -------------------------------------------------------------

const fileOf = url => String(url ?? '').split('?')[0].split('/').pop() || '(native)'
// The dev server serves app modules from its root, so "app code" is any served script outside node_modules.
const isAppCode = url => /^(https?|file):/.test(String(url ?? '')) && !/node_modules|\/@vite\/|\/@react-refresh/.test(url)

function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const selfByNode = new Map()
  profile.samples.forEach((id, index) => selfByNode.set(id, (selfByNode.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)))

  const byFunction = new Map()
  const byFile = new Map()
  const byEntry = new Map()
  const special = { idle: 0, program: 0, gc: 0 }
  let total = 0
  const add = (map, key, micros) => map.set(key, (map.get(key) ?? 0) + micros)
  for (const [id, micros] of selfByNode) {
    total += micros
    const frame = nodes.get(id).callFrame
    if (frame.functionName === '(idle)') { special.idle += micros; continue }
    if (frame.functionName === '(program)') special.program += micros
    if (frame.functionName === '(garbage collector)') special.gc += micros
    add(byFunction, `${frame.functionName || '(anonymous)'} ${fileOf(frame.url)}:${frame.lineNumber + 1}`, micros)
    add(byFile, fileOf(frame.url), micros)
    // The outermost app-source frame on the stack is what started this work: a scope's draw loop, a row render, ...
    let entry = null
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) {
      const candidate = nodes.get(cursor).callFrame
      if (isAppCode(candidate.url)) entry = candidate
    }
    add(byEntry, entry ? `${entry.functionName || '(anonymous)'} ${fileOf(entry.url)}:${entry.lineNumber + 1}` : `(no app frame) ${frame.functionName || fileOf(frame.url)}`, micros)
  }
  const ranked = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([label, micros]) => [label, round(micros / 1000)])
  return {
    totalMs: total / 1000, idleMs: special.idle / 1000, programMs: special.program / 1000, gcMs: special.gc / 1000,
    byFunction: ranked(byFunction), byFile: ranked(byFile), byEntry: ranked(byEntry)
  }
}

const PROBE_START = `(() => {
  const scroller = document.querySelector('.track-list-virtualized')
  const target = scroller?.closest('[data-track-list-scroll-container]') ?? scroller
  const probe = window.__astraScrollProbe = { stamps: [], scrolled: 0, last: target.scrollTop, stopped: false }
  probe.onScroll = () => { probe.scrolled += Math.abs(target.scrollTop - probe.last); probe.last = target.scrollTop }
  probe.target = target
  target.addEventListener('scroll', probe.onScroll, { passive: true })
  const frame = timestamp => { if (probe.stopped) return; probe.stamps.push(timestamp); requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  return true
})()`
const PROBE_STOP = `(() => {
  const probe = window.__astraScrollProbe
  probe.stopped = true
  probe.target.removeEventListener('scroll', probe.onScroll)
  delete window.__astraScrollProbe
  return { stamps: probe.stamps, scrolled: Math.round(probe.scrolled) }
})()`

async function metricsSnapshot(page) {
  const { metrics } = await page.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
}

async function processSnapshot(browser) {
  try {
    const { processInfo } = await browser.send('SystemInfo.getProcessInfo', {}, 5000)
    const totals = {}
    for (const info of processInfo) totals[info.type] = (totals[info.type] ?? 0) + info.cpuTime
    return totals
  } catch { return null }
}

async function samplePhase(page, browser, seconds, during) {
  const metricsBefore = await metricsSnapshot(page)
  const processesBefore = await processSnapshot(browser)
  await evaluate(page, PROBE_START)
  await page.send('Profiler.start')
  const startedAt = performance.now()
  await during(seconds)
  const wallMs = performance.now() - startedAt
  const { profile } = await page.send('Profiler.stop')
  const probe = await evaluate(page, PROBE_STOP)
  const metricsAfter = await metricsSnapshot(page)
  const processesAfter = await processSnapshot(browser)
  const delta = name => (metricsAfter[name] ?? 0) - (metricsBefore[name] ?? 0)
  const intervals = probe.stamps.slice(1).map((stamp, index) => stamp - probe.stamps[index]).sort((a, b) => a - b)
  return {
    wallMs, scrolledPx: probe.scrolled, intervals,
    rafFps: probe.stamps.length > 1 ? (probe.stamps.length - 1) * 1000 / (probe.stamps.at(-1) - probe.stamps[0]) : 0,
    // Counter deltas are seconds of main-thread time.
    task: delta('TaskDuration'), script: delta('ScriptDuration'), style: delta('RecalcStyleDuration'), layout: delta('LayoutDuration'),
    styleCount: delta('RecalcStyleCount'), layoutCount: delta('LayoutCount'), rendererProcess: delta('ProcessTime'),
    processes: processesBefore && processesAfter
      ? Object.fromEntries(Object.keys(processesAfter).map(type => [type, processesAfter[type] - (processesBefore[type] ?? 0)]))
      : null,
    profile: summarizeProfile(profile)
  }
}

function printSampled(idle, scroll, refreshHz) {
  const budgetMs = 1000 / refreshHz
  const share = (seconds, phase) => `${Math.round(seconds * 1000 / phase.wallMs * 100)}%`
  const profileShare = (ms, phase) => `${Math.round(ms / phase.profile.totalMs * 100)}%`
  const rows = [
    ['rAF fps (what the titlebar shows)', phase => round(phase.rafFps)],
    ['frame gap p50 / p95 / worst ms', phase => `${round(percentile(phase.intervals, 0.5))} / ${round(percentile(phase.intervals, 0.95))} / ${round(phase.intervals.at(-1) ?? 0)}`],
    [`frames later than ${round(budgetMs * 1.5)} ms`, phase => `${phase.intervals.filter(gap => gap > budgetMs * 1.5).length} of ${phase.intervals.length}`],
    ['px scrolled', phase => phase.scrolledPx],
    ['main thread busy (all tasks)', phase => share(phase.task, phase)],
    ['  JavaScript', phase => share(phase.script, phase)],
    ['  style recalc', phase => share(phase.style, phase)],
    ['  layout', phase => share(phase.layout, phase)],
    ['  everything else (paint, commit, native)', phase => share(Math.max(0, phase.task - phase.script - phase.style - phase.layout), phase)],
    ['style recalcs / layouts per second', phase => `${Math.round(phase.styleCount * 1000 / phase.wallMs)} / ${Math.round(phase.layoutCount * 1000 / phase.wallMs)}`],
    ['style ms per recalc', phase => phase.styleCount > 0 ? round(phase.style * 1000 / phase.styleCount, 2) : '-'],
    ['profiler: main thread idle', phase => profileShare(phase.profile.idleMs, phase)],
    ['profiler: native, not JS (program)', phase => profileShare(phase.profile.programMs, phase)],
    ['profiler: garbage collection', phase => profileShare(phase.profile.gcMs, phase)],
    ...(scroll.processes
      ? Object.keys(scroll.processes).sort().map(type => [`${type} process CPU`, phase => phase.processes ? share(phase.processes[type] ?? 0, phase) : '-'])
      : [['renderer process CPU', phase => share(phase.rendererProcess, phase)]])
  ].map(([title, read]) => [title, String(read(idle)), String(read(scroll))])
  printTable(rows)
  console.log('\nCPU percentages are of one core; over 100% means several threads were busy.')
  printRanked('What started the work: outermost app function on the stack, inclusive', idle.profile.byEntry, scroll.profile.byEntry, 16)
  printRanked('Self time by function', idle.profile.byFunction, scroll.profile.byFunction, 18)
  printRanked('Self time by file', idle.profile.byFile, scroll.profile.byFile, 12)
}

// ---- --trace mode: full Chromium trace -----------------------------------------------------------------

async function record(browser, output, name, during) {
  const complete = browser.once('Tracing.tracingComplete', 120000)
  complete.catch(() => {})
  await browser.send('Tracing.start', { traceConfig: { includedCategories: TRACE_CATEGORIES }, transferMode: 'ReturnAsStream' })
  await during()
  console.log('  stopping trace...')
  await browser.send('Tracing.end')
  const { stream } = await complete
  console.log('  reading trace...')
  const chunks = []
  for (;;) {
    const part = await browser.send('IO.read', { handle: stream, size: 8 * 1024 * 1024 })
    chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data))
    if (part.eof) break
  }
  await browser.send('IO.close', { handle: stream })
  const tracePath = join(output, `${name}.json`)
  writeFileSync(tracePath, Buffer.concat(chunks))
  return tracePath
}

function printTraced(idle, scroll, refreshHz) {
  const budgetMs = 1000 / refreshHz
  const percent = (ms, summary) => summary.durationMs > 0 ? `${Math.round(ms / summary.durationMs * 100)}%` : '-'
  printTable([
    ['rAF fps (what the titlebar shows)', summary => summary.rafFps],
    ['presented fps', summary => summary.frames.fps],
    ['frame interval p95 / worst ms', summary => `${summary.frames.p95Ms} / ${summary.frames.worstMs}`],
    ['dropped frames', summary => summary.frames.dropped],
    [`main frames over ${budgetMs.toFixed(1)} ms`, summary => `${summary.mainFrames.overBudget} of ${summary.mainFrames.count}`],
    ['main frame p50 / p95 / worst ms', summary => `${summary.mainFrames.p50Ms} / ${summary.mainFrames.p95Ms} / ${summary.mainFrames.worstMs}`],
    ['renderer main thread busy', summary => percent(summary.mainBusyMs, summary)],
    ['  scripting', summary => percent(summary.mainThread.scripting, summary)],
    ['  style', summary => percent(summary.mainThread.style, summary)],
    ['  layout', summary => percent(summary.mainThread.layout, summary)],
    ['  paint', summary => percent(summary.mainThread.paint, summary)],
    ['  other', summary => percent(summary.mainThread.other, summary)],
    ['style recalcs: count, avg / largest elements', summary => `${summary.styleRecalcs.count}, ${summary.styleRecalcs.elementsPerRecalc} / ${summary.styleRecalcs.largest}`],
    ['renderer compositor thread busy', summary => percent(summary.compositorBusyMs, summary)],
    ['raster tasks: count, ms', summary => `${summary.rasterTasks}, ${summary.rasterMs}`],
    ['GPU main thread busy', summary => percent(summary.gpuMainBusyMs, summary)],
    ['viz compositor thread busy', summary => percent(summary.vizBusyMs, summary)],
    ['browser main thread busy', summary => percent(summary.browserMainBusyMs, summary)]
  ].map(([title, read]) => [title, String(read(idle)), String(read(scroll))]))
  printRanked('Renderer main thread, self time', idle.hot.rendererMain, scroll.hot.rendererMain, 14)
  printRanked('GPU main thread, self time', idle.hot.gpuMain, scroll.hot.gpuMain, 14)
  printRanked('Viz compositor thread, self time', idle.hot.vizCompositor, scroll.hot.vizCompositor, 8)
  printRanked('Renderer compositor thread, self time', idle.hot.rendererCompositor, scroll.hot.rendererCompositor, 8)
  printRanked('Browser main thread, self time', idle.hot.browserMain, scroll.hot.browserMain, 6)
}

// ---- Shared -------------------------------------------------------------------------------------------

async function run() {
  if (typeof WebSocket === 'undefined') throw new Error('Needs Node 22 or newer (global WebSocket).')
  if (args.try && !EXPERIMENTS[args.try]) throw new Error(`Unknown --try=${args.try}; expected ${Object.keys(EXPERIMENTS).join(', ')}`)
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch {
    throw new Error(`No app on port ${port}. Start it with: npm run dev -- --remoteDebuggingPort ${port}`)
  }
  const target = targets.find(entry => entry.type === 'page' && !/[?&]window=/.test(entry.url) && !entry.url.startsWith('devtools:'))
  if (!target) throw new Error(`No main window among: ${targets.map(entry => entry.url).join(', ')}`)
  const page = await connect(target.webSocketDebuggerUrl)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await connect(version.webSocketDebuggerUrl)

  const experiment = EXPERIMENTS[args.try]
  if (experiment?.css) await evaluate(page, `(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(experiment.css)}; document.head.appendChild(style) })()`)
  if (experiment?.stripRules) {
    const stripped = await evaluate(page, `(() => {
      const pattern = new RegExp(${JSON.stringify(experiment.stripRules)})
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
    console.log(`--try=${args.try}: removed ${stripped} style rules`)
  }

  const info = await evaluate(page, `new Promise(resolve => {
    const scroller = document.querySelector('.track-list-virtualized')
    const pageScroller = scroller?.closest('[data-track-list-scroll-container]')
    const active = pageScroller ?? scroller
    const rect = active?.getBoundingClientRect()
    const rows = document.querySelectorAll('.track-list-item')
    // A low-percentile frame gap, snapped to a common rate: the display's refresh even if some frames are already late.
    const stamps = []
    const sample = timestamp => {
      stamps.push(timestamp)
      if (stamps.length < 41) return requestAnimationFrame(sample)
      const gaps = stamps.slice(1).map((value, index) => value - stamps[index]).sort((a, b) => a - b)
      resolve({
        hasList: Boolean(active), x: rect ? Math.round(rect.x + rect.width / 2) : 0, y: rect ? Math.round(rect.y + rect.height / 2) : 0,
        scroller: active ? active.className : null, scrollerBackground: active ? getComputedStyle(active).backgroundColor : null,
        refreshHz: (() => {
          const measured = 1000 / gaps[Math.floor(gaps.length * 0.25)]
          const common = [60, 75, 90, 100, 120, 144, 165, 175, 180, 240].find(rate => Math.abs(rate - measured) / rate < 0.04)
          return common ?? Math.round(measured)
        })(),
        dpr: devicePixelRatio, viewport: innerWidth + 'x' + innerHeight,
        documentElements: document.querySelectorAll('*').length, rows: rows.length,
        elementsPerRow: rows.length ? Math.round([...rows].reduce((total, row) => total + row.querySelectorAll('*').length + 1, 0) / rows.length) : 0,
        canvases: [...document.querySelectorAll('canvas')].map(canvas => (canvas.className || 'canvas') + ' ' + canvas.width + 'x' + canvas.height),
        uiScale: getComputedStyle(document.querySelector('.app')).transform, userAgent: navigator.userAgent
      })
    }
    requestAnimationFrame(sample)
  })`)
  if (!info.hasList) throw new Error('No tracklist on screen. Open one in the app first.')
  const refreshHz = Number(args.hz ?? info.refreshHz)
  let gpu = null
  try { gpu = (await browser.send('SystemInfo.getInfo', {}, 5000)).gpu } catch { /* not exposed on every build */ }

  const scrollBy = async seconds => {
    if (!args.auto) return delay(seconds * 1000)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y })
    const startedAt = performance.now()
    for (let notch = 0; performance.now() - startedAt < seconds * 1000; notch++) {
      page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: info.x, y: info.y, deltaX: 0, deltaY: 120 }).catch(() => {})
      await delay(Math.max(0, startedAt + (notch + 1) * 16 - performance.now()))
    }
  }
  const idlePrompt = `Sampling ${idleSeconds} s idle. Keep the music playing and do not scroll...`
  const scrollPrompt = args.auto
    ? `Sampling ${scrollSeconds} s of synthetic wheel scrolling...`
    : `>>> SCROLL THE TRACKLIST NOW, the way that stutters, for ${scrollSeconds} s <<<`
  const printHeader = () => {
    const device = gpu?.devices?.[0]
    console.log(`\n${process.platform} ${process.arch} | ${refreshHz} Hz | dpr ${info.dpr} | ${info.viewport} | ui ${info.uiScale}${args.try ? ` | try=${args.try}` : ''}${args.auto ? ' | synthetic scroll' : ''}`)
    console.log(info.userAgent)
    if (device) console.log(`GPU: ${device.vendorString} ${device.deviceString} | driver ${device.driverVersion}`)
    if (gpu?.featureStatus) console.log(`GPU features: ${JSON.stringify(gpu.featureStatus)}`)
    console.log(`scroller .${info.scroller} background ${info.scrollerBackground} | ${info.documentElements} elements, ${info.rows} rows x ${info.elementsPerRow}`)
    console.log(`canvases: ${info.canvases.join(', ') || 'none'}\n`)
  }

  if (args.trace) {
    const output = mkdtempSync(join(tmpdir(), 'astra-tracklist-live-'))
    console.log(idlePrompt)
    const idleTrace = await record(browser, output, 'idle', () => delay(idleSeconds * 1000))
    console.log(scrollPrompt)
    const scrollTrace = await record(browser, output, 'scroll', () => scrollBy(scrollSeconds))
    console.log('Done. Analysing...')
    const idle = summarizeTrace(idleTrace, refreshHz, { detail: true })
    const scroll = summarizeTrace(scrollTrace, refreshHz, { detail: true })
    printHeader()
    printTraced(idle, scroll, refreshHz)
    if (args['keep-trace']) console.log(`\nTraces (open in DevTools Performance): ${output}`)
    else rmSync(output, { recursive: true, force: true })
  } else {
    await page.send('Performance.enable')
    await page.send('Profiler.enable')
    await page.send('Profiler.setSamplingInterval', { interval: 250 })
    console.log(idlePrompt)
    const idle = await samplePhase(page, browser, idleSeconds, seconds => delay(seconds * 1000))
    console.log(scrollPrompt)
    const scroll = await samplePhase(page, browser, scrollSeconds, scrollBy)
    console.log('Done.')
    printHeader()
    printSampled(idle, scroll, refreshHz)
  }
  page.close()
  browser.close()
}

run().then(() => process.exit(0), error => { console.error(`\nFailed: ${error.message}`); process.exit(1) })
