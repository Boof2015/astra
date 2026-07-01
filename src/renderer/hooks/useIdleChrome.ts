import { useEffect, useState } from 'react'

/**
 * Tracks pointer activity and reports whether on-screen chrome should be visible. After
 * `timeoutMs` with no pointer movement/press, returns false so the caller can fade out chrome
 * (and hide the cursor) — used by the Zone Display, which often sits on an always-on screen.
 * Any pointer move/press restores it immediately.
 *
 * Listens on `window` (Zone Display is a fullscreen overlay), and starts visible so a freshly
 * shown surface always reveals its chrome until the user has been idle.
 */
export function useIdleChrome(timeoutMs = 3500): boolean {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    let timer: number | null = null

    const arm = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setVisible(false), timeoutMs)
    }

    const wake = () => {
      setVisible(true)
      arm()
    }

    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', wake)
    arm()

    return () => {
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', wake)
    }
  }, [timeoutMs])

  return visible
}
