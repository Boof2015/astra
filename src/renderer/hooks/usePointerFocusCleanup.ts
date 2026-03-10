import { useEffect } from 'react'

type InputModality = 'keyboard' | 'pointer'

const BUTTON_LIKE_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

const POINTER_BLUR_ROLES = new Set([
  'button',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'switch',
  'tab',
])

const isTextEntryElement = (element: HTMLElement): boolean => {
  if (element.isContentEditable) return true
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLSelectElement) return true

  if (element instanceof HTMLInputElement) {
    return !BUTTON_LIKE_INPUT_TYPES.has(element.type)
  }

  return false
}

const isPointerBlurCandidate = (element: HTMLElement): boolean => {
  if (isTextEntryElement(element)) return false

  if (element instanceof HTMLButtonElement) return true
  if (element instanceof HTMLInputElement) {
    return BUTTON_LIKE_INPUT_TYPES.has(element.type)
  }

  const role = element.getAttribute('role')
  return role !== null && POINTER_BLUR_ROLES.has(role)
}

const isRelatedPointerTarget = (pointerTarget: EventTarget | null, focusedElement: HTMLElement): boolean => {
  if (!(pointerTarget instanceof Node)) return false
  return (
    pointerTarget === focusedElement ||
    focusedElement.contains(pointerTarget) ||
    (pointerTarget instanceof HTMLElement && pointerTarget.contains(focusedElement))
  )
}

export function usePointerFocusCleanup(): void {
  useEffect(() => {
    const lastInputModalityRef: { current: InputModality | null } = { current: null }
    const pointerTargetRef: { current: EventTarget | null } = { current: null }
    let blurFrame: number | null = null

    const handlePointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      lastInputModalityRef.current = 'pointer'
      pointerTargetRef.current = event.target
    }

    const handleKeyDown = (): void => {
      lastInputModalityRef.current = 'keyboard'
      pointerTargetRef.current = null
    }

    const handleFocusIn = (event: FocusEvent): void => {
      if (lastInputModalityRef.current !== 'pointer') return

      const focusedElement = event.target
      const pointerTarget = pointerTargetRef.current
      pointerTargetRef.current = null

      if (!(focusedElement instanceof HTMLElement)) return
      if (!isRelatedPointerTarget(pointerTarget, focusedElement)) return
      if (!isPointerBlurCandidate(focusedElement)) return

      if (blurFrame !== null) {
        window.cancelAnimationFrame(blurFrame)
      }

      blurFrame = window.requestAnimationFrame(() => {
        blurFrame = null
        if (lastInputModalityRef.current !== 'pointer') return
        if (document.activeElement !== focusedElement) return
        focusedElement.blur()
      })
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('focusin', handleFocusIn, true)

    return () => {
      if (blurFrame !== null) {
        window.cancelAnimationFrame(blurFrame)
      }

      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('focusin', handleFocusIn, true)
    }
  }, [])
}
