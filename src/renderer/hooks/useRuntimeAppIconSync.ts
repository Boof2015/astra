import { useEffect, useRef } from 'react'
import {
  ASTRA_APP_ICON_SQUIRCLE_INSET_RATIO,
  ASTRA_APP_ICON_SQUIRCLE_RADIUS_RATIO,
  ASTRA_APP_ICON_SYMBOL_SCALE,
  renderAstraLogoPngDataUrl,
} from '../components/icons/astraLogoShared'
import { deriveAccentHue, useThemeStore } from '../stores/themeStore'

const ICON_SYNC_DEBOUNCE_MS = 140
const ICON_RENDER_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024] as const

interface RuntimeIconImageSetPayload {
  images: Array<{
    size: number
    dataUrl: string
  }>
}

async function renderRuntimeIconImageSet(hue: number): Promise<RuntimeIconImageSetPayload | null> {
  const images = await Promise.all(ICON_RENDER_SIZES.map(async (size) => {
    const dataUrl = await renderAstraLogoPngDataUrl({
      includeBackground: false,
      backgroundMode: 'squircle',
      symbolScale: ASTRA_APP_ICON_SYMBOL_SCALE,
      squircleInsetRatio: ASTRA_APP_ICON_SQUIRCLE_INSET_RATIO,
      squircleRadiusRatio: ASTRA_APP_ICON_SQUIRCLE_RADIUS_RATIO,
      mainFill: `hsl(${hue} 100% 50%)`,
      shadowFill: `hsl(${hue} 40% 14%)`,
    }, size)
    return dataUrl ? { size, dataUrl } : null
  }))

  if (images.some((image) => image === null)) return null
  return { images: images as RuntimeIconImageSetPayload['images'] }
}

function createRuntimeIconImageSetKey(payload: RuntimeIconImageSetPayload): string {
  return payload.images
    .map((image) => `${image.size}:${image.dataUrl}`)
    .join('|')
}

export function useRuntimeAppIconSync(): void {
  const accent = useThemeStore((state) => state.resolvedTokens.accent)
  const timeoutRef = useRef<number | null>(null)
  const lastPayloadKeyRef = useRef<string | null>(null)
  const requestTokenRef = useRef(0)

  useEffect(() => {
    requestTokenRef.current += 1
    const requestToken = requestTokenRef.current
    const syncRuntimeIcon = window.electronAPI?.theme?.setRuntimeIconDataUrl
    if (typeof syncRuntimeIcon !== 'function') return

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null
      void (async () => {
        const hue = deriveAccentHue(accent)
        const payload = await renderRuntimeIconImageSet(hue)
        if (!payload) return
        if (requestTokenRef.current !== requestToken) return

        const payloadKey = createRuntimeIconImageSetKey(payload)
        if (lastPayloadKeyRef.current === payloadKey) return
        lastPayloadKeyRef.current = payloadKey

        try {
          syncRuntimeIcon(payload)
        } catch {
          // Ignore runtime icon sync failures and keep renderer responsive.
        }
      })()
    }, ICON_SYNC_DEBOUNCE_MS)

    return () => {
      requestTokenRef.current += 1
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [accent])
}
