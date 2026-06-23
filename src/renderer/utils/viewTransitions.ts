export interface AstraViewTransition {
  finished: Promise<void>
  ready: Promise<void>
  updateCallbackDone: Promise<void>
  skipTransition: () => void
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => AstraViewTransition
}

const activeScopedTransitions = new Map<string, AstraViewTransition>()
let transitionUpdateDepth = 0

function canAnimateViewTransition(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false
  if (typeof (document as ViewTransitionDocument).startViewTransition !== 'function') return false
  return typeof window.matchMedia !== 'function'
    || !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export async function runViewTransition(
  update: () => void | Promise<void>,
  scopeClassName?: string
): Promise<void> {
  if (transitionUpdateDepth > 0) {
    await update()
    return
  }

  if (!canAnimateViewTransition()) {
    await update()
    return
  }

  const startViewTransition = (document as ViewTransitionDocument).startViewTransition
  if (!startViewTransition) {
    await update()
    return
  }

  if (scopeClassName) {
    activeScopedTransitions.get(scopeClassName)?.skipTransition()
    document.documentElement.classList.add(scopeClassName)
  }

  let transition: AstraViewTransition
  try {
    transition = startViewTransition.call(document, async () => {
      transitionUpdateDepth += 1
      try {
        await update()
      } finally {
        transitionUpdateDepth -= 1
      }
    })
  } catch {
    if (scopeClassName) document.documentElement.classList.remove(scopeClassName)
    await update()
    return
  }

  if (scopeClassName) {
    activeScopedTransitions.set(scopeClassName, transition)
    void transition.finished.finally(() => {
      if (activeScopedTransitions.get(scopeClassName) === transition) {
        activeScopedTransitions.delete(scopeClassName)
        document.documentElement.classList.remove(scopeClassName)
      }
    })
  }

  await transition.updateCallbackDone
}

export function runAppViewTransition(update: () => void): void {
  void runViewTransition(update, 'app-view-transition-active')
}
