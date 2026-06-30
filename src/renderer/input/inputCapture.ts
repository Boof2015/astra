import type { RawBindingInput } from '../../types/inputBindings'

type InputCaptureListener = (input: RawBindingInput) => void

let activeListener: InputCaptureListener | null = null

export function beginInputCapture(listener: InputCaptureListener): () => void {
  activeListener = listener
  return () => {
    if (activeListener === listener) activeListener = null
  }
}

export function dispatchInputCapture(input: RawBindingInput): boolean {
  if (!activeListener) return false
  activeListener(input)
  return true
}

export function isInputCaptureActive(): boolean {
  return activeListener !== null
}
