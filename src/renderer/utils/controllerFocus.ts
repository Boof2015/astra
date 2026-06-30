import type { ControllerDirection } from '../types/controller'

export interface SpatialRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface SpatialCandidate<T> {
  item: T
  rect: SpatialRect
}

const EXPLICIT_CONTROLLER_TARGET_SELECTOR = '[data-controller-focusable="true"]'

const AUTO_CONTROLLER_TARGET_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="menuitem"]:not([aria-disabled="true"])',
  '[role="option"]:not([aria-disabled="true"])',
  '[role="tab"]:not([aria-disabled="true"])'
].join(',')

const CONTROLLER_OVERLAY_SELECTOR = [
  '[data-controller-scope="overlay"]',
  '[role="dialog"][aria-modal="true"]',
  '.modal-overlay',
  '.track-context-menu',
  '.sidebar-playlist-popout'
].join(',')

export const CONTROLLER_VIRTUAL_MOVE_EVENT = 'astra-controller-virtual-move'

export interface ControllerVirtualMoveDetail {
  direction: 'up' | 'down'
  currentIndex: number
}

interface RememberedTarget {
  element: HTMLElement
  key: string | null
}

const rememberedBaseTargets = new Map<string, RememberedTarget>()
let lastBaseRegionId: string | null = null
let lastOverlayTarget: HTMLElement | null = null

function rectCenter(rect: SpatialRect): { x: number; y: number } {
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2
  }
}

export function findSpatialCandidate<T>(
  sourceRect: SpatialRect,
  candidates: readonly SpatialCandidate<T>[],
  direction: ControllerDirection
): T | null {
  const source = rectCenter(sourceRect)
  let best: { item: T; score: number } | null = null

  for (const candidate of candidates) {
    const target = rectCenter(candidate.rect)
    const dx = target.x - source.x
    const dy = target.y - source.y
    const primary = direction === 'left'
      ? -dx
      : direction === 'right'
        ? dx
        : direction === 'up'
          ? -dy
          : dy
    if (primary <= 1) continue

    const perpendicular = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    const alignmentPenalty = perpendicular > primary * 2.5 ? perpendicular * 2 : perpendicular * 0.7
    const score = primary + alignmentPenalty
    if (!best || score < best.score) best = { item: candidate.item, score }
  }

  return best?.item ?? null
}

function isElementVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  if (element.closest('[aria-hidden="true"]')) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function isControllerTarget(element: HTMLElement): boolean {
  if (!isElementVisible(element)) return false
  if (element.closest('[data-controller-exclude="true"]')) return false
  const controllerParent = element.parentElement?.closest<HTMLElement>('[data-controller-focusable="true"]')
  if (controllerParent && element.dataset.controllerFocusChild !== 'true') return false
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return false
  }
  return true
}

function getTopControllerOverlay(): HTMLElement | null {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(CONTROLLER_OVERLAY_SELECTOR))
    .filter(isElementVisible)
  return overlays.at(-1) ?? null
}

function getActiveControllerScope(): ParentNode {
  return getTopControllerOverlay() ?? document
}

function getControllerTargets(scope = getActiveControllerScope()): HTMLElement[] {
  const roots = scope === document
    ? Array.from(document.querySelectorAll<HTMLElement>('[data-controller-region="true"]')).filter(isElementVisible)
    : [scope as HTMLElement]
  const targets = roots.flatMap((root) => {
    const explicitTargets = Array.from(
      root.querySelectorAll<HTMLElement>(EXPLICIT_CONTROLLER_TARGET_SELECTOR)
    )
    const descendantAutoGroups = Array.from(
      root.querySelectorAll<HTMLElement>('[data-controller-auto-items="true"]')
    )
    // An overlay scope always treats its root as an auto-item group; the base document treats the
    // region root as one only when it explicitly opts in via data-controller-auto-items.
    const rootIsAutoGroup = scope !== document || root.matches('[data-controller-auto-items="true"]')
    const autoGroups = rootIsAutoGroup ? [root, ...descendantAutoGroups] : descendantAutoGroups
    const automaticTargets = autoGroups.flatMap((group) => (
      Array.from(group.querySelectorAll<HTMLElement>(AUTO_CONTROLLER_TARGET_SELECTOR))
    ))
    return [...explicitTargets, ...automaticTargets]
  })
  return [...new Set(targets)]
    .filter(isControllerTarget)
    .sort((left, right) => {
      const position = left.compareDocumentPosition(right)
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
}

function ensureProgrammaticFocus(element: HTMLElement): void {
  if (element.tabIndex < 0 && !element.hasAttribute('tabindex')) element.tabIndex = -1
}

function getControllerRegionId(element: HTMLElement): string | null {
  return element.closest<HTMLElement>('[data-controller-region-id]')?.dataset.controllerRegionId ?? null
}

type ControllerGroupAxis = 'horizontal' | 'vertical' | 'grid'

function getControllerGroup(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>('[data-controller-group]')
}

function getControllerGroupAxis(group: HTMLElement | null): ControllerGroupAxis {
  const axis = group?.dataset.controllerAxis
  return axis === 'horizontal' || axis === 'grid' ? axis : 'vertical'
}

function getGroupTargets(group: HTMLElement | null, targets: readonly HTMLElement[]): HTMLElement[] {
  return targets.filter((target) => getControllerGroup(target) === group)
}

function getRegionGroups(regionId: string | null, targets: readonly HTMLElement[]): Array<HTMLElement | null> {
  const groups: Array<HTMLElement | null> = []
  for (const target of targets) {
    if (getControllerRegionId(target) !== regionId) continue
    const group = getControllerGroup(target)
    if (!groups.includes(group)) groups.push(group)
  }
  return groups
}

function closestTargetAcrossGroups(
  source: HTMLElement,
  candidates: readonly HTMLElement[],
  direction: ControllerDirection
): HTMLElement | null {
  if (candidates.length === 0) return null
  const sourceCenter = rectCenter(source.getBoundingClientRect())
  const compareHorizontalPosition = direction === 'up' || direction === 'down'
  return [...candidates].sort((left, right) => {
    const leftCenter = rectCenter(left.getBoundingClientRect())
    const rightCenter = rectCenter(right.getBoundingClientRect())
    const leftDistance = compareHorizontalPosition
      ? Math.abs(leftCenter.x - sourceCenter.x)
      : Math.abs(leftCenter.y - sourceCenter.y)
    const rightDistance = compareHorizontalPosition
      ? Math.abs(rightCenter.x - sourceCenter.x)
      : Math.abs(rightCenter.y - sourceCenter.y)
    return leftDistance - rightDistance
  })[0] ?? null
}

export function resolveControllerGroupIndex(
  axis: Exclude<ControllerGroupAxis, 'grid'>,
  currentIndex: number,
  itemCount: number,
  direction: ControllerDirection
): number | null {
  const delta = axis === 'horizontal'
    ? direction === 'left'
      ? -1
      : direction === 'right'
        ? 1
        : 0
    : direction === 'up'
      ? -1
      : direction === 'down'
        ? 1
        : 0
  if (delta === 0) return null
  const nextIndex = currentIndex + delta
  return nextIndex >= 0 && nextIndex < itemCount ? nextIndex : null
}

function moveWithinControllerGroup(
  current: HTMLElement,
  groupTargets: readonly HTMLElement[],
  axis: ControllerGroupAxis,
  direction: ControllerDirection
): HTMLElement | null {
  if (groupTargets.indexOf(current) < 0) return null
  // Constrain to the declared axis so off-axis presses fall through to neighbouring groups/regions,
  // but always pick the target by spatial position (not DOM index) so movement matches what the
  // user actually sees on screen — including rows of differing widths and wrapped grids.
  if (axis === 'horizontal' && direction !== 'left' && direction !== 'right') return null
  if (axis === 'vertical' && direction !== 'up' && direction !== 'down') return null
  return findSpatialCandidate(
    current.getBoundingClientRect(),
    groupTargets
      .filter((target) => target !== current)
      .map((target) => ({ item: target, rect: target.getBoundingClientRect() })),
    direction
  )
}

function moveToAdjacentControllerGroup(
  current: HTMLElement,
  direction: ControllerDirection,
  regionTargets: readonly HTMLElement[]
): HTMLElement | null {
  if (direction !== 'up' && direction !== 'down') return null
  const currentGroup = getControllerGroup(current)
  const groups = getRegionGroups(getControllerRegionId(current), regionTargets)
  const currentGroupIndex = groups.indexOf(currentGroup)
  if (currentGroupIndex < 0) return null
  const nextGroup = groups[currentGroupIndex + (direction === 'up' ? -1 : 1)]
  if (nextGroup === undefined) return null
  return closestTargetAcrossGroups(current, getGroupTargets(nextGroup, regionTargets), direction)
}

function requestVirtualControllerMove(
  current: HTMLElement,
  direction: ControllerDirection
): boolean {
  if (direction !== 'up' && direction !== 'down') return false
  const group = getControllerGroup(current)
  if (group?.dataset.controllerVirtual !== 'true') return false
  const currentIndex = Number.parseInt(current.dataset.controllerIndex ?? '', 10)
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return false
  const event = new CustomEvent<ControllerVirtualMoveDetail>(CONTROLLER_VIRTUAL_MOVE_EVENT, {
    bubbles: false,
    cancelable: true,
    detail: { direction, currentIndex }
  })
  group.dispatchEvent(event)
  return event.defaultPrevented
}

export function resolveControllerRegionTransition(
  sourceRegionId: string | null,
  direction: ControllerDirection,
  availableRegionIds: ReadonlySet<string>
): string | null {
  if (!sourceRegionId) return null
  const contentRegionId = [...availableRegionIds].find((regionId) => regionId.startsWith('view:')) ?? null

  if (sourceRegionId === 'sidebar' && direction === 'right') return contentRegionId
  if (sourceRegionId.startsWith('view:')) {
    if (direction === 'left' && availableRegionIds.has('sidebar')) return 'sidebar'
    if (direction === 'right' && availableRegionIds.has('queue')) return 'queue'
    if (direction === 'down' && availableRegionIds.has('transport')) return 'transport'
  }
  if (sourceRegionId === 'queue' && direction === 'left') return contentRegionId
  if (sourceRegionId === 'transport' && direction === 'up') return contentRegionId
  return null
}

function getControllerTargetKey(element: HTMLElement): string | null {
  return element.dataset.controllerKey
    ?? element.id
    ?? element.getAttribute('aria-label')
    ?? null
}

function getRememberedBaseTarget(targets: readonly HTMLElement[]): HTMLElement | null {
  if (!lastBaseRegionId) return null
  const remembered = rememberedBaseTargets.get(lastBaseRegionId)
  if (!remembered) return null
  if (targets.includes(remembered.element)) return remembered.element
  if (!remembered.key) return null
  return targets.find((target) => (
    getControllerRegionId(target) === lastBaseRegionId
    && getControllerTargetKey(target) === remembered.key
  )) ?? null
}

export function focusControllerTarget(element: HTMLElement): HTMLElement {
  ensureProgrammaticFocus(element)
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  if (element.closest(CONTROLLER_OVERLAY_SELECTOR)) lastOverlayTarget = element
  else {
    const regionId = getControllerRegionId(element)
    if (regionId) {
      lastBaseRegionId = regionId
      rememberedBaseTargets.set(regionId, {
        element,
        key: getControllerTargetKey(element)
      })
    }
  }
  return element
}

export function focusInitialControllerTarget(): HTMLElement | null {
  const targets = getControllerTargets()
  if (targets.length === 0) return null
  const overlay = getTopControllerOverlay()
  const rememberedTarget = overlay ? lastOverlayTarget : getRememberedBaseTarget(targets)
  if (rememberedTarget && targets.includes(rememberedTarget)) {
    return focusControllerTarget(rememberedTarget)
  }
  const activeTarget = targets.find((target) => (
    target.matches('.active, [aria-current="page"], [aria-selected="true"]')
  ))
  return focusControllerTarget(activeTarget ?? targets[0])
}

export function getCurrentControllerTarget(): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return null
  return getControllerTargets().includes(active) ? active : null
}

export function moveControllerFocus(direction: ControllerDirection): HTMLElement | null {
  const targets = getControllerTargets()
  if (targets.length === 0) return null
  const current = getCurrentControllerTarget()
  if (!current) return focusInitialControllerTarget()
  const currentRegionId = getControllerRegionId(current)
  const regionTargets = targets.filter((candidate) => getControllerRegionId(candidate) === currentRegionId)
  const currentGroup = getControllerGroup(current)
  const groupTarget = moveWithinControllerGroup(
    current,
    getGroupTargets(currentGroup, regionTargets),
    getControllerGroupAxis(currentGroup),
    direction
  )
  if (groupTarget) return focusControllerTarget(groupTarget)

  if (requestVirtualControllerMove(current, direction)) return current

  const adjacentGroupTarget = moveToAdjacentControllerGroup(current, direction, regionTargets)
  if (adjacentGroupTarget) return focusControllerTarget(adjacentGroupTarget)

  const availableRegionIds = new Set(
    targets.map(getControllerRegionId).filter((regionId): regionId is string => regionId !== null)
  )
  const transitionRegionId = resolveControllerRegionTransition(currentRegionId, direction, availableRegionIds)
  if (!transitionRegionId) return current
  const transitionTargets = targets.filter((candidate) => getControllerRegionId(candidate) === transitionRegionId)
  const rememberedTransitionTarget = rememberedBaseTargets.get(transitionRegionId)
  const rememberedElement = rememberedTransitionTarget
    ? transitionTargets.find((candidate) => (
        candidate === rememberedTransitionTarget.element
        || (rememberedTransitionTarget.key !== null && getControllerTargetKey(candidate) === rememberedTransitionTarget.key)
      ))
    : null
  if (rememberedElement) return focusControllerTarget(rememberedElement)

  const transitionTarget = transitionTargets[0]
  return transitionTarget ? focusControllerTarget(transitionTarget) : current
}

export function activateControllerTarget(): boolean {
  const target = getCurrentControllerTarget() ?? focusInitialControllerTarget()
  if (!target) return false
  target.click()
  return true
}

export function focusControllerRegion(regionId: string): HTMLElement | null {
  const regionTargets = getControllerTargets().filter(
    (target) => getControllerRegionId(target) === regionId
  )
  if (regionTargets.length === 0) return null
  const remembered = rememberedBaseTargets.get(regionId)
  const rememberedElement = remembered
    ? regionTargets.find((candidate) => (
        candidate === remembered.element
        || (remembered.key !== null && getControllerTargetKey(candidate) === remembered.key)
      ))
    : null
  const activeTarget = regionTargets.find((target) => (
    target.matches('.active, [aria-current="page"], [aria-selected="true"]')
  ))
  return focusControllerTarget(rememberedElement ?? activeTarget ?? regionTargets[0])
}

export function isNowPlayingContext(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  return Boolean(active.closest('[data-controller-region-id="transport"], .fullscreen-overlay'))
}

export function resolveSectionTabIndex(
  activeIndex: number,
  tabCount: number,
  direction: 'previous' | 'next'
): number | null {
  if (tabCount < 2) return null
  const base = activeIndex < 0 ? 0 : activeIndex
  const delta = direction === 'next' ? 1 : -1
  const nextIndex = (base + delta + tabCount) % tabCount
  return nextIndex === base ? null : nextIndex
}

export function switchControllerSection(direction: 'previous' | 'next'): boolean {
  // Prefer the tab strip of the visible content view (e.g. Library's Tracks/Albums/Artists/Folders),
  // independent of where focus currently sits; fall back to the global sidebar nav for views that
  // have no sub-tabs (Home, Playlists, library detail views).
  const strip = document.querySelector<HTMLElement>(
    '[data-controller-region-id^="view:"] [data-controller-tabstrip]'
  ) ?? document.querySelector<HTMLElement>('[data-controller-tabstrip="sidebar-nav"]')
  if (!strip) return false

  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-controller-tab]'))
    .filter(isElementVisible)
  const activeIndex = tabs.findIndex((tab) => (
    tab.matches('.active, [aria-selected="true"], [aria-current="page"]')
  ))
  const nextIndex = resolveSectionTabIndex(activeIndex, tabs.length, direction)
  if (nextIndex === null) return false
  tabs[nextIndex].click()
  return true
}

export function openControllerContextMenu(): boolean {
  const target = getCurrentControllerTarget()
  if (!target || target.dataset.controllerContext !== 'true') return false
  const rect = target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 2
  }))
  return true
}

export function closeTopControllerOverlay(): boolean {
  const overlay = getTopControllerOverlay()
  if (!overlay) return false
  const closeTarget = overlay.querySelector<HTMLElement>([
    '[data-controller-back="true"]',
    '.modal-close:not([disabled])',
    '.fullscreen-close:not([disabled])',
    'button[aria-label^="Close"]:not([disabled])'
  ].join(','))
  if (closeTarget && isElementVisible(closeTarget)) {
    closeTarget.click()
    window.requestAnimationFrame(() => {
      if (document.documentElement.dataset.inputModality !== 'controller') return
      const rememberedTarget = getRememberedBaseTarget(getControllerTargets())
      if (rememberedTarget) focusControllerTarget(rememberedTarget)
    })
    return true
  }
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
  window.requestAnimationFrame(() => {
    if (document.documentElement.dataset.inputModality !== 'controller') return
    const rememberedTarget = getRememberedBaseTarget(getControllerTargets())
    if (rememberedTarget) focusControllerTarget(rememberedTarget)
  })
  return true
}

export function scrollActiveControllerRegion(delta: number): void {
  const target = getCurrentControllerTarget()
  const requestedRoot = target?.closest<HTMLElement>('[data-controller-scroll]')
    ?? target?.closest<HTMLElement>('[data-controller-region="true"]')
    ?? getTopControllerOverlay()
  if (!requestedRoot) return

  const candidates = [
    requestedRoot,
    ...Array.from(requestedRoot.querySelectorAll<HTMLElement>('*'))
  ].filter((element) => element.scrollHeight > element.clientHeight + 1)
  const scrollRoot = candidates.find((element) => {
    const overflowY = window.getComputedStyle(element).overflowY
    return overflowY === 'auto' || overflowY === 'scroll'
  }) ?? candidates[0] ?? requestedRoot
  scrollRoot.scrollBy({ top: delta, behavior: 'auto' })
}

export function controllerTargetSupportsContext(): boolean {
  return getCurrentControllerTarget()?.dataset.controllerContext === 'true'
}
