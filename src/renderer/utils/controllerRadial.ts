import type { InputActionId } from '../../types/inputBindings'

export interface ControllerRadialVector {
  x: number
  y: number
}

export type ControllerRadialAction =
  | InputActionId
  | 'more'
  | 'previous-tab'
  | 'next-tab'
  | 'sidebar'
  | 'now-playing'
  | 'toggle-queue'

export interface ControllerRadialItem {
  id: string
  label: string
  action?: ControllerRadialAction
  children?: readonly ControllerRadialItem[]
  keepOpen?: boolean
  disabled?: boolean
}

export interface ControllerRadialMenuState {
  open: boolean
  path: readonly string[]
  selectedIndex: number
  aimVector: ControllerRadialVector | null
}

export interface ControllerRadialRootOptions {
  canOpenContext: boolean
  showQueue: boolean
}

export interface ControllerRadialView {
  title: string
  items: readonly ControllerRadialItem[]
  path: readonly string[]
}

export type ControllerRadialActivationResult =
  | { type: 'enter'; path: readonly string[] }
  | { type: 'execute'; action: ControllerRadialAction; keepOpen: boolean }
  | { type: 'noop' }

export type ControllerRadialBackResult =
  | { type: 'parent'; path: readonly string[] }
  | { type: 'close' }

export const CLOSED_CONTROLLER_RADIAL_MENU: ControllerRadialMenuState = {
  open: false,
  path: [],
  selectedIndex: 0,
  aimVector: null
}

export function createControllerRadialRoot(options: ControllerRadialRootOptions): readonly ControllerRadialItem[] {
  return [
    {
      id: 'more',
      label: 'More',
      action: 'more',
      disabled: !options.canOpenContext
    },
    {
      id: 'browse',
      label: 'Browse',
      // Clockwise from the top; forward/next actions on the right, back/prev on the left,
      // so opposite wedges are semantic pairs: Next Tab <-> Prev Tab, Forward <-> Back.
      // Top holds the "open" actions (Search / Quick Launch), bottom the view toggles.
      children: [
        { id: 'search', label: 'Search', action: 'focus-search-field' }, // top-right
        { id: 'next-tab', label: 'Next Tab', action: 'next-tab' }, // right
        { id: 'forward', label: 'Forward', action: 'navigate-forward' }, // lower-right
        { id: 'now-playing', label: 'Now Playing', action: 'now-playing' }, // bottom-right
        { id: 'sidebar', label: 'Sidebar', action: 'sidebar' }, // bottom-left
        { id: 'back', label: 'Back', action: 'navigate-back' }, // lower-left
        { id: 'previous-tab', label: 'Prev Tab', action: 'previous-tab' }, // left
        { id: 'quick-launch', label: 'Quick Launch', action: 'quick-launch-open' } // top-left
      ]
    },
    {
      id: 'playback',
      label: 'Playback',
      // Items lay out clockwise from the top. Forward actions on the right, backward on
      // the left, so opposite wedges are semantic pairs: Prev <-> Next, Seek -5 <-> +5.
      children: [
        { id: 'play-pause', label: 'Play/Pause', action: 'playback-toggle' }, // top-right
        { id: 'next-track', label: 'Next Track', action: 'next-track' }, // right
        { id: 'seek-forward', label: 'Seek +5s', action: 'seek-forward' }, // lower-right
        { id: 'repeat', label: 'Repeat', action: 'repeat' }, // bottom
        { id: 'seek-backward', label: 'Seek -5s', action: 'seek-backward' }, // lower-left
        { id: 'previous-track', label: 'Prev Track', action: 'previous-track' }, // left
        { id: 'shuffle', label: 'Shuffle', action: 'shuffle' } // top-left
      ]
    },
    {
      id: 'volume',
      label: 'Volume',
      children: [
        { id: 'volume-up', label: 'Volume Up', action: 'volume-up', keepOpen: true },
        { id: 'mute', label: 'Mute', action: 'mute', keepOpen: true },
        { id: 'volume-down', label: 'Volume Down', action: 'volume-down', keepOpen: true }
      ]
    },
    {
      id: 'queue',
      label: options.showQueue ? 'Hide Queue' : 'Queue',
      action: 'toggle-queue'
    }
  ]
}

export function clampControllerRadialIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(itemCount - 1, Math.max(0, Math.trunc(index)))
}

export function getControllerRadialView(
  root: readonly ControllerRadialItem[],
  path: readonly string[]
): ControllerRadialView {
  let title = 'Controller Menu'
  let items = root
  const validPath: string[] = []

  for (const id of path) {
    const next = items.find((item) => item.id === id)
    if (!next?.children?.length) break
    title = next.label
    items = next.children
    validPath.push(id)
  }

  return { title, items, path: validPath }
}

export function selectControllerRadialIndexFromVector(
  itemCount: number,
  vector: ControllerRadialVector | null,
  deadZone = 0.35
): number | null {
  if (!vector || itemCount <= 0) return null
  const magnitude = Math.hypot(vector.x, vector.y)
  if (magnitude < deadZone) return null

  const angleFromTop = Math.atan2(vector.x, -vector.y)
  const normalizedAngle = angleFromTop < 0 ? angleFromTop + Math.PI * 2 : angleFromTop
  const sliceSize = (Math.PI * 2) / itemCount
  // Slice `i` is drawn spanning [sliceSize·i, sliceSize·(i+1)) clockwise from top,
  // so floor() selects the wedge whose span actually contains the aim vector.
  // (round() would snap to the nearest boundary, landing on the next wedge over.)
  return Math.floor(normalizedAngle / sliceSize) % itemCount
}

export function resolveControllerRadialActivation(
  root: readonly ControllerRadialItem[],
  path: readonly string[],
  selectedIndex: number
): ControllerRadialActivationResult {
  const view = getControllerRadialView(root, path)
  const item = view.items[clampControllerRadialIndex(selectedIndex, view.items.length)]
  if (!item || item.disabled) return { type: 'noop' }
  if (item.children?.length) return { type: 'enter', path: [...view.path, item.id] }
  if (!item.action) return { type: 'noop' }
  return { type: 'execute', action: item.action, keepOpen: item.keepOpen === true }
}

export function resolveControllerRadialBack(path: readonly string[]): ControllerRadialBackResult {
  if (path.length === 0) return { type: 'close' }
  return { type: 'parent', path: path.slice(0, -1) }
}
