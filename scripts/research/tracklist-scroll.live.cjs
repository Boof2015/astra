// Traces the real running app while you scroll by hand: real music, real scopes, real input device.
// 1. npm run dev -- --remoteDebuggingPort 9333
// 2. Start playback and open the tracklist you want to test.
// 3. npm run trace:tracklist-scroll [-- --seconds=6 --idle-seconds=3 --hz=175 --try=opaque-scroller --auto --keep-trace]
// It records a few idle seconds, then asks you to scroll, and prints both side by side.
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
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    }),
    once: method => new Promise(resolve => listeners.set(method, [resolve])),
    close: () => socket.close()
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function record(browser, output, name, during) {
  const complete = browser.once('Tracing.tracingComplete')
  await browser.send('Tracing.start', { traceConfig: { includedCategories: TRACE_CATEGORIES }, transferMode: 'ReturnAsStream' })
  await during()
  await browser.send('Tracing.end')
  const { stream } = await complete
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

function printComparison(idle, scroll, budgetMs) {
  const percent = (ms, summary) => summary.durationMs > 0 ? `${Math.round(ms / summary.durationMs * 100)}%` : '-'
  const rows = [
    ['rAF fps (titlebar counter)', summary => summary.rafFps],
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
  ].map(([title, read]) => [title, String(read(idle)), String(read(scroll))])
  const table = [['', 'idle', 'scrolling'], ...rows]
  const widths = [0, 1, 2].map(index => Math.max(...table.map(row => row[index].length)))
  for (const row of table) console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
}

function printHot(title, idle, scroll, limit = 14) {
  const idleByLabel = new Map(idle ?? [])
  console.log(`\n${title} (self ms while scrolling, idle in brackets)`)
  for (const [label, ms] of (scroll ?? []).slice(0, limit)) console.log(`  ${String(ms).padStart(8)}  [${String(idleByLabel.get(label) ?? 0).padStart(7)}]  ${label}`)
}

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
  try { gpu = (await browser.send('SystemInfo.getInfo')).gpu } catch { /* not exposed on every build */ }

  const output = mkdtempSync(join(tmpdir(), 'astra-tracklist-live-'))
  console.log(`Recording ${idleSeconds} s idle. Keep the music playing and do not scroll...`)
  const idleTrace = await record(browser, output, 'idle', () => delay(idleSeconds * 1000))
  console.log(args.auto
    ? `Recording ${scrollSeconds} s of synthetic wheel scrolling...`
    : `>>> SCROLL THE TRACKLIST NOW, the way that stutters, for ${scrollSeconds} s <<<`)
  const scrollTrace = await record(browser, output, 'scroll', async () => {
    if (!args.auto) return delay(scrollSeconds * 1000)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y })
    const startedAt = performance.now()
    for (let notch = 0; performance.now() - startedAt < scrollSeconds * 1000; notch++) {
      page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: info.x, y: info.y, deltaX: 0, deltaY: 120 }).catch(() => {})
      await delay(Math.max(0, startedAt + (notch + 1) * 16 - performance.now()))
    }
  })
  console.log('Done. Analysing...\n')

  const idle = summarizeTrace(idleTrace, refreshHz, { detail: true })
  const scroll = summarizeTrace(scrollTrace, refreshHz, { detail: true })
  const device = gpu?.devices?.[0]
  console.log(`${process.platform} ${process.arch} | ${refreshHz} Hz | dpr ${info.dpr} | ${info.viewport} | ui ${info.uiScale}${args.try ? ` | try=${args.try}` : ''}${args.auto ? ' | synthetic scroll' : ''}`)
  console.log(info.userAgent)
  if (device) console.log(`GPU: ${device.vendorString} ${device.deviceString} | driver ${device.driverVersion}`)
  if (gpu?.featureStatus) console.log(`GPU features: ${JSON.stringify(gpu.featureStatus)}`)
  console.log(`scroller .${info.scroller} background ${info.scrollerBackground} | ${info.documentElements} elements, ${info.rows} rows x ${info.elementsPerRow}`)
  console.log(`canvases: ${info.canvases.join(', ') || 'none'}\n`)
  printComparison(idle, scroll, 1000 / refreshHz)
  printHot('Renderer main thread', idle.hot.rendererMain, scroll.hot.rendererMain)
  printHot('GPU main thread', idle.hot.gpuMain, scroll.hot.gpuMain)
  printHot('Viz compositor thread', idle.hot.vizCompositor, scroll.hot.vizCompositor, 8)
  printHot('Renderer compositor thread', idle.hot.rendererCompositor, scroll.hot.rendererCompositor, 8)
  printHot('Browser main thread', idle.hot.browserMain, scroll.hot.browserMain, 6)

  if (args['keep-trace']) console.log(`\nTraces (open in DevTools Performance): ${output}`)
  else rmSync(output, { recursive: true, force: true })
  page.close()
  browser.close()
}

run().catch(error => { console.error(error.message); process.exit(1) })
