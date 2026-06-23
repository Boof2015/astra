import {
  SHORTCUT_DEFINITIONS,
  SHORTCUT_SECTION_META,
  getShortcutTokenLabel,
  type ShortcutBinding,
  type ShortcutSectionId
} from '../../constants/keyboardShortcuts'
import { useUIStore } from '../../stores/uiStore'
import { usePresence } from '../../hooks/usePresence'

function ShortcutBindingDisplay({
  binding,
  platform
}: {
  binding: ShortcutBinding
  platform: NodeJS.Platform
}) {
  return (
    <span className="keyboard-shortcuts-binding" aria-label={binding.tokens.map((token) => getShortcutTokenLabel(token, platform)).join(' + ')}>
      {binding.tokens.map((token, index) => (
        <span key={`${token}-${index}`} className="keyboard-shortcuts-binding-token">
          {index > 0 && <span className="keyboard-shortcuts-binding-separator">+</span>}
          <kbd>{getShortcutTokenLabel(token, platform)}</kbd>
        </span>
      ))}
    </span>
  )
}

export default function KeyboardShortcutsModal() {
  const isOpen = useUIStore((state) => state.isKeyboardShortcutsOpen)
  const closeKeyboardShortcuts = useUIStore((state) => state.closeKeyboardShortcuts)
  const platform = window.electronAPI?.platform ?? 'linux'
  const presence = usePresence(isOpen)

  if (!presence.shouldRender) return null

  const definitionsBySection = SHORTCUT_SECTION_META.reduce<Record<ShortcutSectionId, typeof SHORTCUT_DEFINITIONS>>(
    (acc, section) => {
      acc[section.id] = SHORTCUT_DEFINITIONS.filter((shortcut) => shortcut.section === section.id)
      return acc
    },
    {
      global: [],
      'quick-launch': [],
      contextual: []
    }
  )

  return (
    <div
      className="modal-overlay keyboard-shortcuts-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={closeKeyboardShortcuts}
    >
      <div
        className="modal-content keyboard-shortcuts-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
      >
        <div className="modal-header keyboard-shortcuts-header">
          <div className="keyboard-shortcuts-header-copy">
            <h2>Keyboard Shortcuts</h2>
            <p className="keyboard-shortcuts-intro">
              Built-in bindings for playback, navigation, and Quick Launch. Press <kbd>Esc</kbd> to close.
            </p>
          </div>
          <button
            className="modal-close"
            onClick={closeKeyboardShortcuts}
            aria-label="Close keyboard shortcuts"
            autoFocus
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body keyboard-shortcuts-body">
          {SHORTCUT_SECTION_META.map((section) => {
            const shortcuts = definitionsBySection[section.id]
            if (shortcuts.length === 0) return null

            return (
              <section key={section.id} className="keyboard-shortcuts-section">
                <div className="keyboard-shortcuts-section-head">
                  <h3>{section.label}</h3>
                  <p>{section.description}</p>
                </div>
                <table className="keyboard-shortcuts-table">
                  <tbody>
                    {shortcuts.map((shortcut) => (
                      <tr key={shortcut.id}>
                        <th scope="row" className="keyboard-shortcuts-action-cell">
                          {shortcut.action}
                        </th>
                        <td className="keyboard-shortcuts-bindings-cell">
                          <div className="keyboard-shortcuts-bindings">
                            {shortcut.bindings.map((binding, bindingIndex) => (
                              <ShortcutBindingDisplay
                                key={`${shortcut.id}-${bindingIndex}`}
                                binding={binding}
                                platform={platform}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="keyboard-shortcuts-description-cell">
                          {shortcut.description}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
