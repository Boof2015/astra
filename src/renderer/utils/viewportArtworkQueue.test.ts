import assert from 'node:assert/strict'
import test from 'node:test'
import { ViewportArtworkQueue } from './viewportArtworkQueue.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('scrolling, unmounting, and recycling rows discard stale work before the next download slot opens', async t => {
  let intersect!: (elements: Element[], visible: boolean) => void
  let observers = 0
  class Observer {
    constructor(notify: (entries: object[]) => void) {
      observers++
      intersect = (elements, visible) => notify(elements.map(target => ({ target, isIntersecting: visible })))
    }
    observe() {}
    unobserve() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: Observer })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original)
    else Reflect.deleteProperty(globalThis, 'IntersectionObserver')
  })

  const started: string[] = [], completed: string[] = []
  const pending = new Map<string, { resolve: () => void; reject: () => void }>()
  const queue = new ViewportArtworkQueue(url => new Promise<void>((resolve, reject) => {
    started.push(url)
    pending.set(url, { resolve, reject })
  }), 1)
  const row = (name: string, url = name, element = {} as Element) => ({
    element,
    remove: queue.watch(element, url, ok => completed.push(`${name}:${ok}`))
  })
  const first = row('first')
  const skipped = Array.from({ length: 40 }, (_, i) => row(`skipped-${i}`))
  const unmounted = row('unmounted')
  const stale = [first, ...skipped, unmounted].map(r => r.element)
  intersect(stale, true)
  assert.deepEqual(started, ['first'])
  first.remove()
  unmounted.remove()
  intersect(skipped.map(r => r.element), false)
  const now = row('now', 'now', first.element)
  const sameAlbum = row('same-album', 'now')
  const after = row('after')
  intersect([now.element, sameAlbum.element, after.element], true)
  pending.get('first')!.resolve()
  await tick()
  assert.deepEqual(started, ['first', 'now'])
  assert.deepEqual(completed, [], 'the recycled row did not receive its old image')
  sameAlbum.remove()
  pending.get('now')!.reject()
  await tick()
  assert.deepEqual(started, ['first', 'now', 'after'])
  assert.deepEqual(completed, ['now:false'])
  pending.get('after')!.resolve()
  await tick()
  assert.deepEqual(completed, ['now:false', 'after:true'])
  intersect([skipped[0].element], true)
  assert.equal(started.at(-1), 'skipped-0', 'scrolling back makes a skipped cover eligible again')
  pending.get('skipped-0')!.resolve()
  await tick()
  assert.equal(observers, 1)
})
