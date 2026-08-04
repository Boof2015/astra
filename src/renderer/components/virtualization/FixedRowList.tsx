import {
  memo,
  useCallback,
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

interface FixedRowListProps<RowProps extends object> extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children?: ReactNode
  defaultHeight?: number
  listRef?: Ref<ListImperativeAPI>
  overscanCount?: number
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
  rowComponent,
  rowCount,
  rowHeight,
  rowProps,
  style,
  ...rest
}: FixedRowListProps<RowProps>): ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const fallbackViewportHeight = resolveViewportHeight(style?.height, defaultHeight)
  const [range, setRange] = useState<FixedRowRange>(() => getFixedRowRange({
    rowCount,
    rowHeight,
    viewportHeight: fallbackViewportHeight,
    scrollTop: 0,
    overscanCount
  }))

  const updateRange = useCallback((scrollTop: number, measuredViewportHeight: number) => {
    const nextRange = getFixedRowRange({
      rowCount,
      rowHeight,
      viewportHeight: measuredViewportHeight > 0 ? measuredViewportHeight : fallbackViewportHeight,
      scrollTop,
      overscanCount
    })
    setRange((currentRange) => (
      areFixedRowRangesEqual(currentRange, nextRange) ? currentRange : nextRange
    ))
  }, [fallbackViewportHeight, overscanCount, rowCount, rowHeight])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    updateRange(element.scrollTop, element.clientHeight)
    onScroll?.(event)
  }, [onScroll, updateRange])

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return
    updateRange(element.scrollTop, element.clientHeight)
  }, [updateRange])

  useImperativeHandle(listRef, () => ({
    get element() {
      return elementRef.current
    },
    scrollToRow({ align = 'auto', behavior = 'auto', index }) {
      const element = elementRef.current
      const top = getFixedRowScrollOffset({
        align,
        currentScrollTop: element?.scrollTop ?? 0,
        index,
        rowCount,
        rowHeight,
        viewportHeight: element?.clientHeight || fallbackViewportHeight
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
  }), [fallbackViewportHeight, rowCount, rowHeight])

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

  return (
    <div
      role="list"
      {...rest}
      className={className}
      ref={elementRef}
      onScroll={handleScroll}
      style={{
        position: 'relative',
        maxHeight: '100%',
        flexGrow: 1,
        overflowY: 'auto',
        ...style
      }}
    >
      {mountedRows}
      {children}
      <div
        aria-hidden
        style={{
          height: getFixedRowTotalHeight(rowCount, rowHeight),
          width: '100%',
          zIndex: -1
        }}
      />
    </div>
  )
}
