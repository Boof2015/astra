export interface SourceChannel {
  id: string
  label: string
}

export function getSourceChannelId(index: number): string {
  return `SRC${index + 1}`
}

export function getSourceChannelLabel(index: number): string {
  return `Decoded Channel ${index + 1}`
}

export function buildSourceLayout(channelCount: number): SourceChannel[] {
  return Array.from({ length: channelCount }, (_, index) => ({
    id: getSourceChannelId(index),
    label: getSourceChannelLabel(index),
  }))
}
