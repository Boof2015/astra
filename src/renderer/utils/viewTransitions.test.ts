import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runViewTransition,
  VIEW_TRANSITION_ROOT_OPT_OUT_CLASS,
  type AstraViewTransition
} from './viewTransitions.ts'

interface ControlledTransition extends AstraViewTransition {
  finish: () => void
  skipCount: number
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test('scoped transitions opt out the root and interrupt the previous scoped transition', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const classNames = new Set<string>()
  const transitions: ControlledTransition[] = []
  let rootWasOptedOutDuringUpdate = false

  const classList = {
    add: (...names: string[]) => names.forEach((name) => classNames.add(name)),
    remove: (...names: string[]) => names.forEach((name) => classNames.delete(name))
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) }
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { classList },
      startViewTransition: (update: () => void | Promise<void>) => {
        const finished = createDeferred()
        const transition: ControlledTransition = {
          finished: finished.promise,
          ready: Promise.resolve(),
          updateCallbackDone: Promise.resolve().then(update),
          skipCount: 0,
          skipTransition: () => {
            transition.skipCount += 1
            finished.resolve()
          },
          finish: finished.resolve
        }
        transitions.push(transition)
        return transition
      }
    }
  })

  try {
    await runViewTransition(() => {
      rootWasOptedOutDuringUpdate = classNames.has(VIEW_TRANSITION_ROOT_OPT_OUT_CLASS)
    }, 'library-context-forward')

    assert.equal(rootWasOptedOutDuringUpdate, true)
    assert.equal(classNames.has('library-context-forward'), true)
    assert.equal(classNames.has(VIEW_TRANSITION_ROOT_OPT_OUT_CLASS), true)

    await runViewTransition(() => undefined, 'library-context-backward')
    await Promise.resolve()

    assert.equal(transitions[0]?.skipCount, 1)
    assert.equal(classNames.has('library-context-forward'), false)
    assert.equal(classNames.has('library-context-backward'), true)
    assert.equal(classNames.has(VIEW_TRANSITION_ROOT_OPT_OUT_CLASS), true)

    transitions[1]?.finish()
    await transitions[1]?.finished
    await Promise.resolve()

    assert.equal(classNames.has('library-context-backward'), false)
    assert.equal(classNames.has(VIEW_TRANSITION_ROOT_OPT_OUT_CLASS), false)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
