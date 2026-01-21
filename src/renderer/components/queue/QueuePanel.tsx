import { useState, useRef } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { Track } from '../../types/audio'

export default function QueuePanel() {
  const {
    queue,
    queueIndex,
    currentTrack,
    playTrackAt,
    removeFromQueue,
    moveInQueue,
    clearQueue
  } = usePlayerStore()

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragNodeRef = useRef<HTMLDivElement | null>(null)

  const formatDuration = (seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index)
    dragNodeRef.current = e.target as HTMLDivElement
    e.dataTransfer.effectAllowed = 'move'
    // Add dragging class after a frame to avoid affecting the drag image
    setTimeout(() => {
      dragNodeRef.current?.classList.add('dragging')
    }, 0)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (dragIndex === null || dragIndex === index) return
    setDragOverIndex(index)
  }

  const handleDragEnd = () => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      moveInQueue(dragIndex, dragOverIndex)
    }
    dragNodeRef.current?.classList.remove('dragging')
    setDragIndex(null)
    setDragOverIndex(null)
  }

  const handleDragLeave = () => {
    setDragOverIndex(null)
  }

  const upcomingTracks = queue.slice(queueIndex + 1)
  const previousTracks = queue.slice(0, queueIndex)

  if (queue.length === 0) {
    return (
      <div className="queue-panel">
        <div className="queue-header">
          <h3>Queue</h3>
        </div>
        <div className="queue-empty">
          <p>No tracks in queue</p>
          <p className="queue-empty-hint">Play a track from your library to start</p>
        </div>
      </div>
    )
  }

  return (
    <div className="queue-panel">
      <div className="queue-header">
        <h3>Queue</h3>
        <button className="queue-clear-btn" onClick={clearQueue} title="Clear queue">
          Clear
        </button>
      </div>

      <div className="queue-content">
        {/* Now Playing */}
        {currentTrack && (
          <div className="queue-section">
            <div className="queue-section-title">Now Playing</div>
            <div className="queue-item queue-item-current">
              <div className="queue-item-info">
                <div className="queue-item-title">{currentTrack.title}</div>
                <div className="queue-item-artist">{currentTrack.artist}</div>
              </div>
              <div className="queue-item-duration">
                {formatDuration(currentTrack.duration)}
              </div>
            </div>
          </div>
        )}

        {/* Up Next */}
        {upcomingTracks.length > 0 && (
          <div className="queue-section">
            <div className="queue-section-title">
              Up Next ({upcomingTracks.length} {upcomingTracks.length === 1 ? 'track' : 'tracks'})
            </div>
            <div className="queue-list">
              {upcomingTracks.map((track, i) => {
                const actualIndex = queueIndex + 1 + i
                return (
                  <div
                    key={`${track.id}-${actualIndex}`}
                    className={`queue-item ${dragOverIndex === actualIndex ? 'queue-item-drag-over' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, actualIndex)}
                    onDragOver={(e) => handleDragOver(e, actualIndex)}
                    onDragEnd={handleDragEnd}
                    onDragLeave={handleDragLeave}
                    onClick={() => playTrackAt(actualIndex)}
                  >
                    <div className="queue-item-drag-handle">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"/>
                      </svg>
                    </div>
                    <div className="queue-item-info">
                      <div className="queue-item-title">{track.title}</div>
                      <div className="queue-item-artist">{track.artist}</div>
                    </div>
                    <div className="queue-item-duration">
                      {formatDuration(track.duration)}
                    </div>
                    <button
                      className="queue-item-remove"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeFromQueue(actualIndex)
                      }}
                      title="Remove from queue"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Previously Played */}
        {previousTracks.length > 0 && (
          <div className="queue-section queue-section-previous">
            <div className="queue-section-title">Previously Played</div>
            <div className="queue-list">
              {previousTracks.map((track, i) => (
                <div
                  key={`${track.id}-${i}`}
                  className="queue-item queue-item-previous"
                  onClick={() => playTrackAt(i)}
                >
                  <div className="queue-item-info">
                    <div className="queue-item-title">{track.title}</div>
                    <div className="queue-item-artist">{track.artist}</div>
                  </div>
                  <div className="queue-item-duration">
                    {formatDuration(track.duration)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
