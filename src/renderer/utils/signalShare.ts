import {
  encodeSignal,
  encodeSignalLink,
  type SignalInput,
  type SignalLayout
} from '@boof2015/astra-signal'

export const SIGNAL_WEB_URL = 'https://astramusic.dev/signal/'

export interface SignalShareTarget {
  artist: string
  title: string
  duration: number
}

export interface SignalShareModel {
  input: SignalInput
  layout: SignalLayout
  nativeLink: string
  webUrl: string
  metadataWasShortened: boolean
  suggestedFileName: string
}

export function signalInputFromTarget(target: SignalShareTarget): SignalInput {
  return {
    artist: target.artist,
    title: target.title,
    durationSec: Number.isFinite(target.duration) ? Math.round(target.duration) : 0
  }
}

export function createSignalShareSuggestedFileName(target: SignalShareTarget): string {
  return `astra-signal-${target.artist}-${target.title}.png`
}

export function buildSignalShareModel(target: SignalShareTarget): SignalShareModel {
  const input = signalInputFromTarget(target)
  const layout = encodeSignal(input)
  const nativeLink = encodeSignalLink(layout.payload)

  return {
    input,
    layout,
    nativeLink,
    webUrl: `${SIGNAL_WEB_URL}#${nativeLink}`,
    metadataWasShortened:
      layout.payload.artist !== input.artist || layout.payload.title !== input.title,
    suggestedFileName: createSignalShareSuggestedFileName(target)
  }
}
