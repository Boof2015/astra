import { useEffect, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'

export default function ArtistSplitExceptionsSettings() {
  const artistSplitExceptions = useLibraryStore((state) => state.artistSplitExceptions)
  const loadArtistSplitExceptions = useLibraryStore((state) => state.loadArtistSplitExceptions)
  const addArtistSplitException = useLibraryStore((state) => state.addArtistSplitException)
  const removeArtistSplitException = useLibraryStore((state) => state.removeArtistSplitException)
  const restartConfirmation = useLibraryStore((state) => state.artistSplitExceptionsRestartConfirmation)
  const setArtistSplitExceptionsRestartConfirmation = useLibraryStore((state) => state.setArtistSplitExceptionsRestartConfirmation)

  const [nameInput, setNameInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    void loadArtistSplitExceptions()
  }, [loadArtistSplitExceptions])

  // Auto-clear restart confirmation
  useEffect(() => {
    if (!restartConfirmation) return
    const id = window.setTimeout(() => setArtistSplitExceptionsRestartConfirmation(''), 3200)
    return () => window.clearTimeout(id)
  }, [restartConfirmation, setArtistSplitExceptionsRestartConfirmation])

  const handleAdd = async () => {
    const trimmed = nameInput.trim()
    if (!trimmed || isSubmitting) return
    setIsSubmitting(true)
    try {
      await addArtistSplitException(trimmed)
      setNameInput('')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-label">Artist Split Exceptions</div>
      <div className="settings-grid">
        <div className="settings-field">
          <span className="settings-field-label">Exceptions</span>
          <div className="settings-inline-row">
            <input
              className="settings-select settings-inline-input"
              type="text"
              placeholder="e.g. Tyler, The Creator"
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void handleAdd()
              }}
            />
            <button
              type="button"
              className="settings-btn settings-btn-primary"
              onClick={() => void handleAdd()}
              disabled={!nameInput.trim() || isSubmitting}
            >
              Add
            </button>
          </div>
          <p className="settings-note">
            Full artist credits listed here are never split into separate collaborators
            (e.g. &quot;Tyler, The Creator&quot;, &quot;Earth, Wind &amp; Fire&quot;).
          </p>
          {artistSplitExceptions.length > 0 && (
            <div className="settings-artist-split-exception-list">
              {artistSplitExceptions.map((name) => (
                <div key={name} className="settings-inline-row">
                  <span className="settings-chip settings-chip-mono settings-chip-grow">{name}</span>
                  <button
                    type="button"
                    className="settings-chip settings-chip-danger"
                    onClick={() => void removeArtistSplitException(name)}
                    aria-label={`Remove ${name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="settings-note">
            Restart Astra after modifying this list for changes to take effect.
          </p>
          {restartConfirmation && <p className="settings-note settings-note-success">{restartConfirmation}</p>}
        </div>
      </div>
    </div>
  )
}
