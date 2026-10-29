import { useEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { RemoteAudioCacheStatus } from '../../../../types/remoteAudioCache'
import {
  CACHE_MAJOR_STOPS, CACHE_SLIDER_MAX, CACHE_STOPS, CacheLimitEdits, cacheSliderValue, cacheTickOffset, formatGb,
  nearestCacheStop, SerialQueue, stepCacheStop
} from './serverModel'

const GB = 1024 ** 3

/**
 * Cache status, polled every 5 s. Writes (limit, clear) go through one queue, and a
 * poll that started before a write can't overwrite what that write reported.
 */
function useRemoteCache() {
  const [status, setStatus] = useState<RemoteAudioCacheStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const writes = useRef({ started: 0, running: 0 })
  const queue = useRef(new SerialQueue()).current

  const write = async (work: () => Promise<RemoteAudioCacheStatus>) => {
    writes.current.started++
    writes.current.running++
    setError(null)
    try { setStatus(await work()) }
    catch { setError('Could not update the audio cache. Please try again.') }
    finally { writes.current.running-- }
  }
  const edits = useRef<CacheLimitEdits | null>(null)
  edits.current ??= new CacheLimitEdits(queue, gb => write(() => window.electronAPI.setRemoteCacheLimit(gb)), rerender)

  useEffect(() => {
    let active = true
    const refresh = () => {
      const startedAt = writes.current.started
      void window.electronAPI.getRemoteCacheStatus()
        .then(value => {
          if (active && writes.current.running === 0 && writes.current.started === startedAt) setStatus(value)
        })
        .catch(() => { if (active) setError('Could not read the audio cache.') })
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const clear = () => queue.run(() => write(() => window.electronAPI.clearRemoteCache()))
  return { status, error, edits: edits.current, clear }
}

/**
 * Usage bar (in use vs. cached) and a cache limit slider that snaps to stops
 * getting finer as sizes grow. The limit is saved when the drag or key press
 * ends, so dragging through small sizes never evicts audio along the way.
 */
export function StorageGroup() {
  const { status, error, edits, clear } = useRemoteCache()
  const [clearing, setClearing] = useState(false)
  const savedLimit = status?.limitGb ?? 5
  const limit = edits.draft ?? savedLimit
  const release = () => { void edits.release(savedLimit) }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const keys: Record<string, number | 'first' | 'last'> = {
      ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1, Home: 'first', End: 'last'
    }
    const move = keys[event.key]
    if (move === undefined) return
    event.preventDefault()
    edits.edit(move === 'first' ? CACHE_STOPS[0][0] : move === 'last' ? CACHE_STOPS[CACHE_STOPS.length - 1][0]
      : stepCacheStop(limit, move as 1 | -1))
  }

  const used = status?.usedBytes ?? 0
  const inUse = Math.min(status?.activeBytes ?? 0, used)
  const cached = Math.max(0, used - inUse)
  const limitBytes = limit * GB
  const share = (bytes: number) => `${Math.min(100, (bytes / limitBytes) * 100).toFixed(1)}%`
  const over = !!status && used > limitBytes

  return (
    <div className="servers-group">
      <div className="servers-row servers-cache">
        <div className="servers-cache-top">
          <div className="servers-row-text">
            <span className="servers-label">Audio cache</span>
            <span className="servers-sub">Recently played server audio, kept for instant replay.</span>
          </div>
          <span className="servers-amount">
            {status ? formatGb(used) : '…'} <span>of {limit} GB</span>
          </span>
          <button type="button" className="servers-btn" disabled={!status || clearing || cached === 0}
            onClick={() => { setClearing(true); void clear().finally(() => setClearing(false)) }}>
            Clear
          </button>
        </div>
        <div className="servers-usage-bar" role="img"
          aria-label={`${formatGb(inUse)} in use, ${formatGb(cached)} cached, limit ${limit} GB`}>
          <i className="is-use" style={{ width: share(inUse) }} />
          <i className="is-cached" style={{ width: share(cached) }} />
        </div>
        <div className="servers-legend">
          <span><b className="is-use" />In use {formatGb(inUse)}</span>
          <span><b className="is-cached" />Cached {formatGb(cached)}</span>
          {over && <span className="servers-over">The oldest unused audio will be removed to fit.</span>}
        </div>
        {error && <span className="servers-sub is-warn" role="alert">{error}</span>}
      </div>
      <div className="servers-row servers-row-wrap servers-limit">
        <div className="servers-row-text"><label className="servers-label" htmlFor="servers-cache-limit">Cache limit</label></div>
        <div className="servers-slider">
          <div className="servers-slider-col">
            <input id="servers-cache-limit" type="range" min={0} max={CACHE_SLIDER_MAX} step={1}
              value={cacheSliderValue(limit)} disabled={!status}
              aria-valuetext={`${limit} gigabytes`}
              onChange={event => edits.edit(nearestCacheStop(Number(event.target.value)))}
              onKeyDown={onKeyDown}
              onKeyUp={release}
              onPointerUp={release}
              onBlur={release} />
            <div className="servers-ticks" aria-hidden="true">
              {CACHE_STOPS.map(([gb]) => {
                const major = CACHE_MAJOR_STOPS.includes(gb)
                return (
                  <span key={gb} className={`${major ? 'is-major' : 'is-minor'}${gb === limit ? ' is-on' : ''}`}
                    style={{ '--tick': cacheTickOffset(gb) } as CSSProperties}>
                    {major ? `${gb}${gb === 50 ? ' GB' : ''}` : ''}
                  </span>
                )
              })}
            </div>
          </div>
          <span className="servers-slider-value">{limit} GB</span>
        </div>
      </div>
    </div>
  )
}
