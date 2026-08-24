import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type UIEvent
} from 'react'
import type { ListImperativeAPI, RowComponentProps } from 'react-window'
import {
  getFixedRowRange,
  getFixedRowScrollOffset,
  getFixedRowTotalHeight,
  type FixedRowRange
} from './fixedRowVirtualization'

type FixedRowComponent<RowProps extends object> = (
  props: RowComponentProps<RowProps>
) => ReactElement | null

interface FixedRowListProps<RowProps extends object> extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onScroll'> {
  children?: ReactNode
  defaultHeight?: number
  listRef?: Ref<ListImperativeAPI>
  // Fires for both the owned scroller and an external one. External scroll
  // events are native, not React synthetic, so no event is forwarded.
  onScroll?: () => void
  overscanCount?: number
  // Opts into external-scrollport mode: the returned element owns the scroll,
  // this list renders as a full-height canvas inside it, and rows are windowed
  // against that element's viewport. Returning null falls back to no windowing
  // updates until the element resolves. Must be a div, since it is what
  // ListImperativeAPI.element then exposes.
  resolveScrollElement?: (listElement: HTMLDivElement) => HTMLDivElement | null
  rowComponent: FixedRowComponent<RowProps>
  rowCount: number
  rowHeight: number
  rowProps: RowProps
  style?: CSSProperties
}

interface MountedFixedRowProps<RowProps extends object> {
  index: number
  rowComponent: FixedRowComponent<RowProps>
  rowCount: number
  rowHeight: number
  rowProps: RowProps
}

function MountedFixedRowRenderer<RowProps extends object>({
  index,
  rowComponent: RowComponent,
  rowCount,
  rowHeight,
  rowProps
}: MountedFixedRowProps<RowProps>): ReactElement | null {
  return (
    <RowComponent
      {...rowProps}
      ariaAttributes={{
        'aria-posinset': index + 1,
        'aria-setsize': rowCount,
        role: 'listitem'
      }}
      index={index}
      style={{
        position: 'absolute',
        left: 0,
        transform: `translateY(${index * rowHeight}px)`,
        height: rowHeight,
        width: '100%'
      }}
    />
  )
}

const MountedFixedRow = memo(MountedFixedRowRenderer) as typeof MountedFixedRowRenderer

function areFixedRowRangesEqual(left: FixedRowRange, right: FixedRowRange): boolean {
  return left.visibleStartIndex === right.visibleStartIndex
    && left.visibleStopIndex === right.visibleStopIndex
    && left.overscanStartIndex === right.overscanStartIndex
    && left.overscanStopIndex === right.overscanStopIndex
}

function resolveViewportHeight(styleHeight: CSSProperties['height'], defaultHeight: number): number {
  if (typeof styleHeight === 'number' && Number.isFinite(styleHeight) && styleHeight > 0) {
    return styleHeight
  }
  return defaultHeight
}

// Walks offsetTop/offsetParent rather than reading a DOMRect: the app shell is
// rendered inside `transform: scale(var(--ui-scale))`, so rects come back in
// scaled pixels while scrollTop/clientHeight stay in layout pixels. Mixing the
// two desynchronizes rows from the scrollbar at any UI scale but 100%.
// Requires the scroll container to be an offsetParent (position: relative).
function getOffsetTopWithinScrollElement(element: HTMLElement, scrollElement: HTMLElement): number {
  let offset = 0
  let node: HTMLElement | null = element
  while (node && node !== scrollElement) {
    offset += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return node === scrollElement ? Math.max(0, offset) : 0
}

// react-window 2.2.x walks its bounds cache from row zero for every range
// calculation. Track lists have a fixed row height, so direct index arithmetic
// keeps deep scrollbar jumps independent of library size.
export default function FixedRowList<RowProps extends object>({
  children,
  className,
  defaultHeight = 0,
  listRef,
  onScroll,
  overscanCount = 3,
  resolveScrollElement,
  rowComponent,
  rowCount,
  rowHeight,
  rowProps,
  style,
  ...rest
}: FixedRowListProps<RowProps>): ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const isExternalScroll = typeof resolveScrollElement === 'function'
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  // Mirrored into a ref so the imperative handle never reads geometry from a
  // stale render closure.
  const leadingHeightRef = useRef(0)
  // Keeps the scroll subscription below from tearing down and re-attaching
  // every time the caller's handler changes identity.
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll
  const fallbackViewportHeight = resolveViewportHeight(style?.height, defaultHeight)
  const [range, setRange] = useState<FixedRowRange>(() => getFixedRowRange({
    rowCount,
    rowHeight,
    viewportHeight: fallbackViewportHeight,
    scrollTop: 0,
    overscanCount
  }))

  const updateRange = useCallback((
    scrollTop: number,
    measuredViewportHeight: number,
    leadingHeight: number
  ) => {
    const nextRange = getFixedRowRange({
      rowCount,
      rowHeight,
      viewportHeight: measuredViewportHeight > 0 ? measuredViewportHeight : fallbackViewportHeight,
      scrollTop,
      overscanCount,
      leadingHeight
    })
    setRange((currentRange) => (
      areFixedRowRangesEqual(currentRange, nextRange) ? currentRange : nextRange
    ))
  }, [fallbackViewportHeight, overscanCount, rowCount, rowHeight])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    updateRange(element.scrollTop, element.clientHeight, 0)
    onScroll?.()
  }, [onScroll, updateRange])

  const syncExternalGeometry = useCallback(() => {
    const element = elementRef.current
    if (!element || !scrollElement) return
    const nextLeadingHeight = getOffsetTopWithinScrollElement(element, scrollElement)
    leadingHeightRef.current = nextLeadingHeight
    updateRange(scrollElement.scrollTop, scrollElement.clientHeight, nextLeadingHeight)
  }, [scrollElement, updateRange])

  // Intentionally runs on every render (no dependency array). It is what keeps
  // the leading height honest when content above the list changes size — the
  // artist discography rail switching modes, the year album grid expanding, a
  // column set change — without each of those needing to notify the list.
  useLayoutEffect(() => {
    if (!isExternalScroll) return
    const element = elementRef.current
    if (!element) return
    const nextScrollElement = resolveScrollElement(element)
    if (nextScrollElement !== scrollElement) {
      setScrollElement(nextScrollElement)
      return
    }
    syncExternalGeometry()
  })

  useLayoutEffect(() => {
    if (isExternalScroll) return
    const element = elementRef.current
    if (!element) return
    updateRange(element.scrollTop, element.clientHeight, 0)
  }, [isExternalScroll, updateRange])

  useEffect(() => {
    if (!isExternalScroll || !scrollElement) return

    const handleExternalScroll = (): void => {
      syncExternalGeometry()
      onScrollRef.current?.()
    }

    // Passive effects flush after the whole commit, so this also corrects the
    // range for a parent that restores scrollTop in its own layout effect.
    syncExternalGeometry()
    scrollElement.addEventListener('scroll', handleExternalScroll, { passive: true })

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncExternalGeometry)
      return () => {
        scrollElement.removeEventListener('scroll', handleExternalScroll)
        window.removeEventListener('resize', syncExternalGeometry)
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      syncExternalGeometry()
    })
    resizeObserver.observe(scrollElement)

    return () => {
      scrollElement.removeEventListener('scroll', handleExternalScroll)
      resizeObserver.disconnect()
    }
  }, [isExternalScroll, scrollElement, syncExternalGeometry])

  useImperativeHandle(listRef, () => ({
    get element() {
      return (isExternalScroll ? scrollElement : elementRef.current) ?? null
    },
    scrollToRow({ align = 'auto', behavior = 'auto', index }) {
      const element = isExternalScroll ? scrollElement : elementRef.current
      const top = getFixedRowScrollOffset({
        align,
        currentScrollTop: element?.scrollTop ?? 0,
        index,
        rowCount,
        rowHeight,
        viewportHeight: element?.clientHeight || fallbackViewportHeight,
        leadingHeight: isExternalScroll ? leadingHeightRef.current : 0
      })
      if (!element) return

      if (typeof element.scrollTo === 'function') {
        element.scrollTo({
          behavior,
          top
        })
      } else {
        element.scrollTop = top
      }
    }
  }), [fallbackViewportHeight, isExternalScroll, rowCount, rowHeight, scrollElement])

  const mountedRows = useMemo(() => {
    const rows: ReactElement[] = []
    for (let index = range.overscanStartIndex; index <= range.overscanStopIndex; index += 1) {
      rows.push(
        <MountedFixedRow
          index={index}
          key={index}
          rowComponent={rowComponent}
          rowCount={rowCount}
          rowHeight={rowHeight}
          rowProps={rowProps}
        />
      )
    }
    return rows
  }, [range.overscanStartIndex, range.overscanStopIndex, rowComponent, rowCount, rowHeight, rowProps])

  const totalHeight = getFixedRowTotalHeight(rowCount, rowHeight)

  return (
    <div
      role="list"
      {...rest}
      className={className}
      ref={elementRef}
      onScroll={isExternalScroll ? undefined : handleScroll}
      style={isExternalScroll
        ? {
          // Full-height canvas: the surrounding scrollport provides the
          // viewport, so the spacer's job moves onto the element itself.
          position: 'relative',
          width: '100%',
          height: totalHeight,
          ...style
        }
        : {
          position: 'relative',
          maxHeight: '100%',
          flexGrow: 1,
          overflowY: 'auto',
          ...style
        }}
    >
      {mountedRows}
      {children}
      {!isExternalScroll && (
        <div
          aria-hidden
          style={{
            height: totalHeight,
            width: '100%',
            zIndex: -1
          }}
        />
      )}
    </div>
  )
}
