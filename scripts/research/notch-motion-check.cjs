// Frame-level checks against the real renderer and Chromium's computed styles.
// Run through notch-seek.electron.cjs --motion-check (silent, hidden fixture).
const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = async ({ win, output, setView }) => {
  const query = code => win.webContents.executeJavaScript(code)
  await query(`window.motionFrames = []; window.readMotion = () => {
    const surface = document.querySelector('.notch-surface');
    const style = getComputedStyle(surface);
    const player = document.querySelector('.notch-player');
    const preview = document.querySelector('.notch-preview');
    return { time: performance.now(), height: +style.getPropertyValue('--notch-surface-height'),
      width: +style.getPropertyValue('--notch-top-width'), surface: +style.opacity,
      player: +getComputedStyle(player).opacity, preview: +getComputedStyle(preview).opacity,
      inert: player.inert, ariaHidden: player.getAttribute('aria-hidden'),
      playerWidth: player.getBoundingClientRect().width,
      fontSize: getComputedStyle(document.querySelector('.notch-title')).fontSize };
  }; window.motionObserver = new MutationObserver(() => motionFrames.push(readMotion())); void 0;`)
  const read = () => query('readMotion()')
  // Observe each painted style update, including the synchronous first frame of
  // a retarget, rather than sampling on either side of a different RAF callback.
  const start = () => query(`motionFrames = [readMotion()]; motionObserver.observe(document.querySelector('.notch-surface'), { attributes: true, subtree: true, attributeFilter: ['style', 'inert', 'aria-hidden'] })`)
  const stop = () => query('motionObserver.disconnect(); motionFrames')
  const traces = {}
  for (const view of ['hidden', 'metadata', 'oscilloscope', 'spectrum']) {
    setView('expanded'); await delay(350)
    const full = await read()
    assert.equal(full.player, 1)
    assert.equal(full.height, 206)
    await start()
    setView(view)
    await delay(120)
    if (view === 'hidden') writeFileSync(join(output, 'collapse-midpoint.png'), (await win.webContents.capturePage()).toPNG())
    await delay(230)
    const frames = traces[view] = await stop()
    const closing = frames.filter(frame => frame.inert && frame.height > 80 && frame.height < 200)
    assert.ok(closing.length >= 3, `${view}: sample the collapsing player, not just its endpoints`)
    for (const frame of closing) {
      assert.equal(frame.surface, 1, `${view}: the silhouette must stay solid while retracting`)
      assert.equal(frame.player, 1, `${view}: player content must survive until the contour is near strip size`)
      assert.equal(frame.preview, 0, `${view}: preview must not overlap the full player`)
      assert.equal(frame.ariaHidden, 'true', `${view}: departing controls leave the accessibility tree immediately`)
      assert.equal(frame.playerWidth, full.playerWidth, `${view}: content must clip without scaling`)
      assert.equal(frame.fontSize, full.fontSize)
    }
    const last = frames.at(-1)
    assert.equal(last.player, 0)
    assert.equal(last.surface, view === 'hidden' ? 0 : 1)
    assert.equal(last.preview, view === 'hidden' ? 0 : 1)
    console.log(`PASS ${view}: content retained through retraction, late preview handoff, controls inert`)
  }

  // Reverse within the narrow handoff region, where an opacity reset is visible.
  setView('expanded'); await delay(350)
  await start(); setView('metadata')
  const deadline = Date.now() + 1000
  let interrupted
  do { await delay(4); interrupted = await read() } while (interrupted.height > 70 && Date.now() < deadline)
  assert.ok(interrupted.height > 56 && interrupted.height <= 70, 'interrupt before retraction finishes')
  setView('expanded'); await delay(350)
  const reversed = traces.reversed = await stop()
  const index = reversed.findIndex((frame, i) => i > 0 && !frame.inert && reversed[i - 1].inert)
  assert.ok(index > 0, 'sample the reversal boundary')
  assert.ok(Math.abs(reversed[index].height - reversed[index - 1].height) < 1, 'reopening preserves the current geometry')
  assert.ok(Math.abs(reversed[index].player - reversed[index - 1].player) < 0.02, 'reopening preserves the current content opacity')
  assert.equal(reversed.at(-1).player, 1)
  assert.equal(reversed.at(-1).height, 206)
  console.log('PASS interrupted collapse: continuous geometry and content')

  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await delay(150)
  assert.equal(await query(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true)
  await start(); setView('hidden'); await delay(160)
  const reduced = traces.reduced = await stop()
  const fading = reduced.filter(frame => frame.inert && frame.surface > 0 && frame.surface < 1)
  assert.ok(fading.length >= 2, 'reduced motion crossfades')
  assert.ok(fading.every(frame => frame.height === 206), 'reduced motion does not animate geometry')
  assert.equal(reduced.at(-1).surface, 0)
  assert.equal(reduced.at(-1).player, 0)
  setView('expanded'); await delay(150)
  assert.equal((await read()).player, 1)
  win.webContents.debugger.detach()
  console.log('PASS reduced motion: short crossfade without retraction')
  writeFileSync(join(output, 'motion-traces.json'), JSON.stringify(traces, null, 2))
  console.log('MOTION_ARTIFACTS', output)
}
