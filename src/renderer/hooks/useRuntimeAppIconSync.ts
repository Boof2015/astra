import { useEffect, useRef } from 'react'
import { renderAstraLogoPngDataUrl } from '../components/icons/astraLogoShared'
import { deriveAccentHue, useThemeStore } from '../stores/themeStore'

const ICON_SYNC_DEBOUNCE_MS = 140
const ICON_RENDER_SIZE = 1024
const ICON_SYMBOL_SCALE = 0.9
const ICON_SQUIRCLE_INSET_RATIO = 0.055
const ICON_SQUIRCLE_RADIUS_RATIO = 0.22

export function useRuntimeAppIconSync(): void {
  const accent = useThemeStore((state) => state.resolvedTokens.accent)
  const timeoutRef = useRef<number | null>(null)
  const lastDataUrlRef = useRef<string | null>(null)
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
        const dataUrl = await renderAstraLogoPngDataUrl({
          includeBackground: false,
          backgroundMode: 'squircle',
          symbolScale: ICON_SYMBOL_SCALE,
          squircleInsetRatio: ICON_SQUIRCLE_INSET_RATIO,
          squircleRadiusRatio: ICON_SQUIRCLE_RADIUS_RATIO,
          mainFill: `hsl(${hue} 100% 50%)`,
          shadowFill: `hsl(${hue} 40% 14%)`,
        }, ICON_RENDER_SIZE)
        if (!dataUrl) return
        if (requestTokenRef.current !== requestToken) return

        if (lastDataUrlRef.current === dataUrl) return
        lastDataUrlRef.current = dataUrl

        try {
          syncRuntimeIcon(dataUrl)
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
