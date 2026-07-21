import { createElement, type ReactElement } from 'react'

interface ParallaxPairingPromptProps {
  sinkName: string
  submitting: boolean
}

export function ParallaxPairingPrompt({
  sinkName,
  submitting
}: ParallaxPairingPromptProps): ReactElement {
  if (submitting) {
    return createElement(
      'span',
      null,
      'Code matched. Approve on the Parallax display, or open ',
      createElement('strong', null, 'http://parallax.local/'),
      ' on another device. CEC is optional.'
    )
  }

  return createElement(
    'span',
    null,
    'Enter the 6-digit security code shown on ',
    createElement('strong', null, sinkName),
    '.'
  )
}
