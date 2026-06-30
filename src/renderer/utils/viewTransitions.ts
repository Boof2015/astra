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

type ViewTransitionScope = string | string[] | undefined

export type AppViewTransitionDirection = 'up' | 'down' | null

function canAnimateViewTransition(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false
  if (typeof (document as ViewTransitionDocument).startViewTransition !== 'function') return false
  return typeof window.matchMedia !== 'function'
    || !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function normalizeScopeClassNames(scopeClassName: ViewTransitionScope): string[] {
  if (!scopeClassName) return []
  const scopeClassNames = Array.isArray(scopeClassName) ? scopeClassName : [scopeClassName]
  return [...new Set(scopeClassNames.map((name) => name.trim()).filter(Boolean))]
}

export async function runViewTransition(
  update: () => void | Promise<void>,
  scopeClassName?: ViewTransitionScope
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

  const scopeClassNames = normalizeScopeClassNames(scopeClassName)

  if (scopeClassNames.length > 0) {
    for (const className of scopeClassNames) {
      activeScopedTransitions.get(className)?.skipTransition()
    }
    document.documentElement.classList.add(...scopeClassNames)
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
    if (scopeClassNames.length > 0) document.documentElement.classList.remove(...scopeClassNames)
    await update()
    return
  }

  if (scopeClassNames.length > 0) {
    for (const className of scopeClassNames) {
      activeScopedTransitions.set(className, transition)
    }
    void transition.finished.finally(() => {
      const completedClassNames = scopeClassNames.filter((className) => activeScopedTransitions.get(className) === transition)
      for (const className of completedClassNames) {
        activeScopedTransitions.delete(className)
      }
      if (completedClassNames.length > 0) {
        document.documentElement.classList.remove(...completedClassNames)
      }
    })
  }

  await transition.updateCallbackDone
}

export function runAppViewTransition(update: () => void, direction: AppViewTransitionDirection = null): void {
  const scopeClassNames = ['app-view-transition-active']
  if (direction) {
    scopeClassNames.push(`app-view-transition-${direction}`)
  }
  void runViewTransition(update, scopeClassNames)
}
