const assert = require('node:assert/strict')
const test = require('node:test')
const { buildSync } = require('esbuild')
const { runInNewContext } = require('node:vm')
const { join } = require('node:path')

const source = buildSync({ entryPoints: [join(__dirname, 'useNotchSeek.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['react'], write: false }).outputFiles[0].text

function setup() {
  const slots = [], effects = [], timers = new Map(), commands = []
  let cursor = 0, dirty = false, now = 0, timerId = 0, result
  let snapshot = { currentTime: 8, duration: 100, currentTrack: { path: 'a' } }, expanded = true
  const effect = (fn, deps) => {
    const index = cursor++, previous = slots[index]
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: fn() } })
  }
  const react = {
    useState: initial => {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: initial }
      return [slots[index].value, update => {
        const value = typeof update === 'function' ? update(slots[index].value) : update
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true }
      }]
    },
    useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial } },
    useEffect: effect, useLayoutEffect: effect,
  }
  const module = { exports: {} }
  runInNewContext(source, { module, exports: module.exports, require: () => react,
    window: { setTimeout: (fn, ms) => { timers.set(++timerId, { fn, at: now + ms }); return timerId }, clearTimeout: id => timers.delete(id) } })
  const render = () => {
    do {
      cursor = 0; dirty = false
      result = module.exports.useNotchSeek(snapshot, expanded, time => commands.push(time))
      effects.splice(0).forEach(fn => fn())
    } while (dirty)
    return result
  }
  const event = value => ({ button: 0, pointerId: 1, currentTarget: { value: String(value), setPointerCapture() {} } })
  render()
  return {
    commands, timers, render, event, get input() { return result.input }, get progress() { return render().progress },
    snapshot: value => { snapshot = { ...snapshot, ...value }; render() },
    expand: value => { expanded = value; render() },
    pointerEdit: value => { result.input.onPointerDown(event(value)); result.input.onChange(event(value)); render() },
    release: () => { result.input.onPointerUp(event(8)); render() },
    tick: ms => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn() }; render() },
    dispose: () => slots.forEach(slot => slot?.cleanup?.()),
  }
}

test('seek holds its target through old snapshots, blur, collapse and reopening until acknowledged', () => {
  const qa = setup()
  qa.pointerEdit(30); qa.release()
  qa.input.onBlur(qa.event(8))
  qa.input.onLostPointerCapture(qa.event(8))
  qa.snapshot({ currentTime: 8.2 })
  assert.equal(qa.progress, 30)
  qa.expand(false); qa.expand(true)
  assert.equal(qa.progress, 30)
  assert.deepEqual(qa.commands, [30])
  qa.snapshot({ currentTime: 30.1 })
  assert.equal(qa.progress, 30.1)
  assert.equal(qa.timers.size, 0)
  qa.dispose()
})

test('blur commits the stored edit once even if the range DOM has reverted', () => {
  const qa = setup()
  qa.pointerEdit(30)
  qa.input.onBlur(qa.event(8))
  qa.input.onPointerUp(qa.event(8))
  qa.input.onBlur(qa.event(8))
  assert.deepEqual(qa.commands, [30])
  assert.equal(qa.progress, 30)
  qa.dispose()
})

test('rapid seeks ignore the earlier acknowledgement; timeout never emits another seek', () => {
  const qa = setup()
  qa.pointerEdit(30); qa.release(); qa.tick(100)
  qa.pointerEdit(50); qa.release()
  qa.snapshot({ currentTime: 30 })
  assert.equal(qa.progress, 50)
  qa.tick(1950)
  assert.equal(qa.progress, 50)
  qa.tick(100)
  assert.equal(qa.progress, 30)
  assert.deepEqual(qa.commands, [30, 50])
  qa.dispose()
})

test('canceled gestures and a track change cannot commit a stale edit', () => {
  const qa = setup()
  qa.pointerEdit(30); qa.input.onPointerCancel(qa.event(30)); qa.release()
  assert.deepEqual(qa.commands, [])
  qa.pointerEdit(50)
  qa.snapshot({ currentTime: 0, currentTrack: { path: 'b' } })
  qa.input.onBlur(qa.event(50)); qa.release()
  assert.deepEqual(qa.commands, [])
  assert.equal(qa.progress, 0)
  qa.dispose()
})

test('keyboard seeks, accessibility edits and Escape respect edit boundaries', () => {
  const qa = setup()
  qa.input.onKeyDown({ key: 'ArrowRight' })
  qa.input.onChange(qa.event(8.1))
  qa.input.onKeyUp({ key: 'ArrowRight' })
  qa.input.onBlur(qa.event(8))
  assert.deepEqual(qa.commands, [8.1])
  assert.equal(qa.progress, 8.1, 'the pre-seek snapshot cannot acknowledge a small keyboard seek')
  qa.input.onChange(qa.event(45)) // Accessibility range action has no pointer/key events.
  qa.render()
  qa.input.onKeyUp({ key: 'Tab' })
  assert.deepEqual(qa.commands, [8.1, 45])
  qa.input.onKeyDown({ key: 'ArrowRight' })
  qa.input.onChange(qa.event(60))
  qa.input.onKeyDown({ key: 'Escape' })
  qa.input.onBlur(qa.event(60))
  assert.deepEqual(qa.commands, [8.1, 45])
  qa.dispose()
  assert.equal(qa.timers.size, 0)
})
