import type { WebContents } from 'electron'
import { resolveUIScaleShortcutAction } from './uiScaleShortcuts'

// These windows have their own compact layouts and never participate in app UI scaling.
export function installFixedWindowZoom(webContents: WebContents, platform = process.platform): void {
  const resetZoom = () => {
    if (!webContents.isDestroyed()) webContents.setZoomLevel(0)
  }

  webContents.on('dom-ready', () => {
    resetZoom()
    void webContents.setVisualZoomLevelLimits(1, 1).catch((error) => {
      if (!webContents.isDestroyed()) console.error('Failed to disable popout visual zoom:', error)
    })
  })
  webContents.on('before-input-event', (event, input) => {
    if (!resolveUIScaleShortcutAction(input, platform)) return
    event.preventDefault()
    resetZoom()
  })
  webContents.on('zoom-changed', (event) => {
    event.preventDefault()
    resetZoom()
  })
}
