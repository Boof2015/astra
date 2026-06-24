import { useEffect, useMemo, useState } from 'react'
import type { InputActionId, InputBinding, RawBindingInput } from '../../../types/inputBindings'
import {
  INPUT_ACTION_DEFINITIONS,
  INPUT_ACTION_GROUPS,
  getInputActionDefinition
} from '../../constants/keyboardShortcuts'
import { beginInputCapture } from '../../input/inputCapture'
import {
  findBindingConflict,
  getEffectiveBindingSlots,
  useInputBindingStore
} from '../../stores/inputBindingStore'
import { formatInputBinding, normalizeRawKeyboardBinding } from '../../utils/inputBindings'
import ConfirmActionModal from './ConfirmActionModal'

interface CaptureTarget {
  actionId: InputActionId
  slotIndex: number
}

interface PendingConflict extends CaptureTarget {
  binding: InputBinding
  conflictActionId: InputActionId
}

function isModifierOnlyInput(input: RawBindingInput): boolean {
  if (input.device !== 'keyboard') return false
  return ['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'].includes(input.key)
}

export default function KeybindSettings() {
  const overrides = useInputBindingStore((state) => state.overrides)
  const assignBinding = useInputBindingStore((state) => state.assignBinding)
  const clearBinding = useInputBindingStore((state) => state.clearBinding)
  const resetAction = useInputBindingStore((state) => state.resetAction)
  const resetAll = useInputBindingStore((state) => state.resetAll)
  const platform = window.electronAPI?.platform ?? 'linux'
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget | null>(null)
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null)
  const [feedback, setFeedback] = useState('')

  const definitionsByGroup = useMemo(() => {
    return new Map(INPUT_ACTION_GROUPS.map((group) => [
      group.id,
      INPUT_ACTION_DEFINITIONS.filter((definition) => definition.group === group.id)
    ]))
  }, [])

  useEffect(() => {
    if (!captureTarget) return
    return beginInputCapture((input) => {
      if (input.device === 'keyboard' && input.type !== 'keyDown') return
      if (input.device === 'keyboard' && input.key === 'Escape') {
        setCaptureTarget(null)
        setFeedback('Binding capture canceled.')
        return
      }
      if (input.device === 'keyboard' && input.key === 'Tab') {
        setFeedback('Tab is reserved for interface focus and cannot be assigned.')
        return
      }
      if (isModifierOnlyInput(input)) {
        setFeedback('Press a key together with the modifier.')
        return
      }

      const binding = input.device === 'mouse'
        ? input
        : normalizeRawKeyboardBinding(input, platform)
      if (!binding) {
        setFeedback('That input cannot be assigned.')
        return
      }

      const latestOverrides = useInputBindingStore.getState().overrides
      const conflict = findBindingConflict(
        binding,
        captureTarget.actionId,
        captureTarget.slotIndex,
        latestOverrides
      )
      setCaptureTarget(null)
      if (conflict) {
        setPendingConflict({
          ...captureTarget,
          binding,
          conflictActionId: conflict.actionId
        })
        return
      }

      assignBinding(captureTarget.actionId, captureTarget.slotIndex, binding)
      setFeedback(`${getInputActionDefinition(captureTarget.actionId).action} updated.`)
    })
  }, [assignBinding, captureTarget, platform])

  const confirmConflict = () => {
    if (!pendingConflict) return
    assignBinding(pendingConflict.actionId, pendingConflict.slotIndex, pendingConflict.binding)
    setFeedback(`${formatInputBinding(pendingConflict.binding, platform)} reassigned.`)
    setPendingConflict(null)
  }

  return (
    <>
      <section className="settings-section settings-section-panel keybind-settings">
        <div className="settings-section-head keybind-settings-head">
          <div>
            <h3>Keybinds</h3>
            <p>Assign up to two keyboard or mouse-side-button bindings to each action.</p>
          </div>
          <button
            type="button"
            className="settings-btn"
            onClick={() => {
              resetAll()
              setCaptureTarget(null)
              setFeedback('All keybinds restored to defaults.')
            }}
          >
            Restore Defaults
          </button>
        </div>

        <p className="settings-note keybind-settings-note">
          Click a binding slot, then press a key combination or Mouse 4/5. Esc cancels capture; Esc and Tab are reserved.
        </p>
        {feedback && <p className="settings-note keybind-feedback" role="status">{feedback}</p>}

        <div className="keybind-groups">
          {INPUT_ACTION_GROUPS.map((group) => (
            <section key={group.id} className="settings-card keybind-group">
              <div className="keybind-group-head">
                <div className="keybind-group-title">{group.label}</div>
                <p>{group.description}</p>
              </div>

              <div className="keybind-list">
                {definitionsByGroup.get(group.id)?.map((definition) => {
                  const slots = getEffectiveBindingSlots(definition.id, overrides)
                  return (
                    <div className="keybind-row" key={definition.id}>
                      <div className="keybind-copy">
                        <strong>{definition.action}</strong>
                        <span>{definition.description}</span>
                      </div>
                      <div className="keybind-slots">
                        {slots.map((binding, slotIndex) => {
                          const isCapturing = captureTarget?.actionId === definition.id
                            && captureTarget.slotIndex === slotIndex
                          return (
                            <div className="keybind-slot-wrap" key={`${definition.id}-${slotIndex}`}>
                              <button
                                type="button"
                                className={`keybind-slot ${isCapturing ? 'is-capturing' : ''}`}
                                aria-label={`${definition.action}, binding ${slotIndex + 1}`}
                                onClick={() => {
                                  setFeedback('')
                                  setCaptureTarget({ actionId: definition.id, slotIndex })
                                }}
                              >
                                {isCapturing
                                  ? 'Press input…'
                                  : binding
                                    ? formatInputBinding(binding, platform)
                                    : 'Add binding'}
                              </button>
                              {binding && !isCapturing && (
                                <button
                                  type="button"
                                  className="keybind-clear"
                                  aria-label={`Clear ${definition.action} binding ${slotIndex + 1}`}
                                  title="Clear binding"
                                  onClick={() => {
                                    clearBinding(definition.id, slotIndex)
                                    setFeedback(`${definition.action} binding cleared.`)
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <button
                        type="button"
                        className="keybind-reset"
                        disabled={!overrides[definition.id]}
                        onClick={() => {
                          resetAction(definition.id)
                          setFeedback(`${definition.action} restored to default.`)
                        }}
                      >
                        Reset
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </section>

      <ConfirmActionModal
        isOpen={pendingConflict !== null}
        title="Reassign Binding?"
        message={pendingConflict
          ? `${formatInputBinding(pendingConflict.binding, platform)} is assigned to ${getInputActionDefinition(pendingConflict.conflictActionId).action}. Move it to ${getInputActionDefinition(pendingConflict.actionId).action}?`
          : ''}
        confirmLabel="Reassign"
        onCancel={() => setPendingConflict(null)}
        onConfirm={confirmConflict}
      />
    </>
  )
}
