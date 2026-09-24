import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export default function HomeExpandableGrid<T>({ items, initialRows = 2, maxRows, getKey, renderItem }: {
  items: readonly T[]
  initialRows?: number
  maxRows?: number
  getKey: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
}) {
  const gridId = useId()
  const gridRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const lessRef = useRef<HTMLButtonElement | null>(null)
  const focusAfterChange = useRef<'more' | 'less' | null>(null)
  const [columns, setColumns] = useState(1)
  const [blocks, setBlocks] = useState(1)
  const measuredColumnsRef = useRef(1)
  const [revealingKeys, setRevealingKeys] = useState<ReadonlyMap<string, number>>(() => new Map())
  const blockSize = columns * initialRows
  const availableCount = Math.min(items.length, columns * (maxRows ?? Infinity))
  const visibleCount = Math.min(availableCount, blockSize * blocks)
  const hasMore = visibleCount < availableCount
  const expanded = blocks > 1 && availableCount > blockSize

  useLayoutEffect(() => {
    const target = focusAfterChange.current
    if (!target) return
    const button = target === 'more' ? moreRef.current : lessRef.current
    button?.focus({ preventScroll: true })
    if (target === 'more') button?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    focusAfterChange.current = null
  }, [blocks])

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const update = () => {
      if (!grid.clientWidth) return
      const tracks = window.getComputedStyle(grid).gridTemplateColumns
      const nextColumns = tracks && tracks !== 'none' ? tracks.trim().split(/\s+/).length : 1
      // If resizing would remove the focused card, move focus to a retained card.
      const nextCount = nextColumns * Math.min(initialRows * blocks, maxRows ?? Infinity)
      const focusedIndex = Array.from(grid.children).findIndex((child) => child.contains(document.activeElement))
      if (focusedIndex >= nextCount) grid.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
      if (nextColumns !== measuredColumnsRef.current) {
        measuredColumnsRef.current = nextColumns
        setRevealingKeys(new Map())
      }
      setColumns(nextColumns)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [blocks, initialRows, maxRows])

  const showMore = () => {
    // When the final block removes Show more, retain focus on Show less.
    if (visibleCount + blockSize >= availableCount) focusAfterChange.current = 'less'
    setRevealingKeys(new Map(items.slice(visibleCount, Math.min(availableCount, visibleCount + blockSize)).map((item, index) => [getKey(item), index])))
    setBlocks((value) => value + 1)
  }
  const showLess = () => {
    focusAfterChange.current = 'more'
    setRevealingKeys(new Map())
    setBlocks(1)
  }

  return (
    <>
      <div className="home-media-grid" id={gridId} ref={gridRef}>
        {items.slice(0, visibleCount).map((item, index) => {
          const key = getKey(item)
          const revealIndex = revealingKeys.get(key)
          return (
            <div className={`home-media-grid-item${revealIndex !== undefined ? ' is-expansion-reveal' : ''}`} key={key}
              style={revealIndex !== undefined ? { animationDelay: `${Math.min(Math.floor(revealIndex / columns), 4) * 35}ms` } : undefined}
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget || revealIndex === undefined) return
                setRevealingKeys((current) => { const next = new Map(current); next.delete(key); return next })
              }}>
              {renderItem(item, index)}
            </div>
          )
        })}
      </div>
      {availableCount > blockSize && (
        <div className="home-grid-footer">
          <button ref={lessRef} type="button" className="home-grid-expand" hidden={!expanded} data-controller-focusable={expanded ? 'true' : undefined}
            aria-expanded={expanded} aria-controls={gridId} onClick={showLess}>Show less<Chevron up /></button>
          <button ref={moreRef} type="button" className="home-grid-expand" hidden={!hasMore} data-controller-focusable={hasMore ? 'true' : undefined}
            aria-expanded={expanded} aria-controls={gridId} onClick={showMore}>Show more<Chevron /></button>
        </div>
      )}
    </>
  )
}

function Chevron({ up = false }: { up?: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={up ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
}
