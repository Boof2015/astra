// Exercise real AppKit focus release and record the composited screen. Renderer
// capturePage alone cannot see a WindowServer fade of the backing panel.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = async ({ controller, main, output }) => {
  const deadline = Date.now() + 4000
  while (!controller.state.attached && Date.now() < deadline) await delay(20)
  assert.equal(controller.state.attached, true)
  const window = controller.window
  const query = code => window.webContents.executeJavaScript(code)
  await delay(400)
  assert.equal(controller.addon.getDiagnostics().animationDisabled, true)
  assert.equal(window.isFocused(), false, 'initial preview must not take focus')
  const bounds = window.getBounds()
  const video = join(output, 'native-collapse.mov')
  const recorder = spawn('/usr/sbin/screencapture', ['-x', '-T', '0', '-v', '-V', '6', '-R', `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, video])
  let captureError = ''
  recorder.stderr.on('data', value => { captureError += value })
  const recorded = new Promise((resolve, reject) => {
    recorder.on('error', reject)
    recorder.on('exit', code => code === 0 ? resolve() : reject(new Error(`Screen recording failed: ${captureError}`)))
  })
  // Observe a rejection immediately even if it precedes the end of the actions.
  recorded.catch(() => {})
  const traces = {}
  try {
    await delay(1000)
    for (const action of ['collapse', 'escape', 'openAstra']) {
      await query('electronAPI.notch.expand()')
      await delay(400)
      assert.equal(window.isFocused(), true, `${action}: deliberate expansion focuses the panel`)
      await query(`window.nativeMotionFrames = []; window.nativeMotionObserver = new MutationObserver(() => {
        const surface = document.querySelector('.notch-surface'), style = getComputedStyle(surface);
        nativeMotionFrames.push({ time: performance.now(), height: +style.getPropertyValue('--notch-surface-height'),
          opacity: +style.opacity, player: +getComputedStyle(document.querySelector('.notch-player')).opacity });
      }); nativeMotionObserver.observe(document.querySelector('.notch-surface'), { attributes: true, attributeFilter: ['style'] }); void 0;`)
      if (action === 'escape') {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      } else {
        await query(`document.querySelector('[aria-label="${action === 'collapse' ? 'Collapse player' : 'Astra notch player'}"]${action === 'openAstra' ? ' .notch-open' : ''}').click()`)
      }
      await delay(350)
      const frames = traces[action] = await query('nativeMotionObserver.disconnect(); nativeMotionFrames')
      assert.equal(window.isFocused(), false, `${action}: focus returns immediately`)
      assert.equal(window.isVisible(), true, `${action}: backing window remains available`)
      assert.equal(controller.addon.getDiagnostics().alpha, 1)
      assert.equal(controller.state.view, 'hidden')
      assert.ok(frames.filter(frame => frame.height > 80 && frame.height < 200 && frame.opacity === 1 && frame.player === 1).length >= 3,
        `${action}: content survives a real native focus release while geometry retracts`)
      assert.equal(frames.at(-1).opacity, 0)
      if (action === 'openAstra') assert.equal(main.isFocused(), true)
      console.log(`PASS native ${action}: focus released, panel retained, renderer retracts`)
    }
  } finally {
    // Retain the screen evidence even when an assertion fails.
    writeFileSync(join(output, 'native-collapse-traces.json'), JSON.stringify(traces, null, 2))
    try { await recorded; console.log('NATIVE_MOTION_VIDEO', video) }
    finally { if (recorder.exitCode === null) recorder.kill('SIGINT') }
  }
}
