import LocalizedText from '../i18n/LocalizedText'
import { translate, translateSourceText } from '../../i18n'
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
  getGlobalInputBindingSlotKey,
  isGlobalInputBindingEnabled,
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
  const globalEnabled = useInputBindingStore((state) => state.globalEnabled)
  const globalStatuses = useInputBindingStore((state) => state.globalStatuses)
  const assignBinding = useInputBindingStore((state) => state.assignBinding)
  const clearBinding = useInputBindingStore((state) => state.clearBinding)
  const resetAction = useInputBindingStore((state) => state.resetAction)
  const resetAll = useInputBindingStore((state) => state.resetAll)
  const setGlobalRegistrationSuspended = useInputBindingStore((state) => state.setGlobalRegistrationSuspended)
  const setGlobalEnabled = useInputBindingStore((state) => state.setGlobalEnabled)
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
    setGlobalRegistrationSuspended(true)
    const stopCapture = beginInputCapture((input) => {
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
    return () => {
      stopCapture()
      setGlobalRegistrationSuspended(false)
    }
  }, [assignBinding, captureTarget, platform, setGlobalRegistrationSuspended])

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
            <h3><LocalizedText ns="settings" i18nKey="auto.keybindsettings.keybinds" /></h3>
            <p><LocalizedText ns="settings" i18nKey="auto.keybindsettings.assign_up_to_two_keyboard_or_mouse_side_button_bindings_" /></p>
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

            <LocalizedText ns="settings" i18nKey="auto.keybindsettings.restore_defaults" />
          </button>
        </div>

        <p className="settings-note keybind-settings-note">

          <LocalizedText ns="settings" i18nKey="auto.keybindsettings.click_a_binding_slot_then_press_a_key_combination_or_mou" />
        </p>
        {feedback && <p className="settings-note keybind-feedback" role="status">{translateSourceText(feedback)}</p>}

        <div className="keybind-groups">
          {INPUT_ACTION_GROUPS.map((group) => (
            <section key={group.id} className="settings-card keybind-group">
              <div className="keybind-group-head">
                <div className="keybind-group-title">{translateSourceText(group.label)}</div>
                <p>{translateSourceText(group.description)}</p>
              </div>

              <div className="keybind-list">
                {definitionsByGroup.get(group.id)?.map((definition) => {
                  const slots = getEffectiveBindingSlots(definition.id, overrides)
                  return (
                    <div className="keybind-row" key={definition.id}>
                      <div className="keybind-copy">
                        <strong>{translateSourceText(definition.action)}</strong>
                        <span>{translateSourceText(definition.description)}</span>
                      </div>
                      <div className="keybind-slots">
                        {slots.map((binding, slotIndex) => {
                          const isCapturing = captureTarget?.actionId === definition.id
                            && captureTarget.slotIndex === slotIndex
                          const globalOn = isGlobalInputBindingEnabled(definition.id, slotIndex, globalEnabled)
                          const globalStatus = globalStatuses[getGlobalInputBindingSlotKey(definition.id, slotIndex)]
                          const globalSupported = binding?.device === 'keyboard'
                          const hasNoModifiers = binding?.device === 'keyboard' && binding.modifiers.length === 0
                          return (
                            <div className="keybind-slot-control" key={`${definition.id}-${slotIndex}`}>
                              <div className="keybind-slot-wrap">
                                <button
                                  type="button"
                                  className={`keybind-slot ${isCapturing ? 'is-capturing' : ''}`}
                                  aria-label={translate('settings:auto.keybindsettings.action_binding_value2', { action: definition.action, value2: slotIndex + 1 })}
                                  onClick={() => {
                                    setFeedback('')
                                    setCaptureTarget({ actionId: definition.id, slotIndex })
                                  }}
                                >
                                  {isCapturing
                                    ? translate('settings:auto.keybindsettings.press_input')
                                    : binding
                                      ? formatInputBinding(binding, platform)
                                      : translate('settings:auto.keybindsettings.add_binding')}
                                </button>
                                {binding && !isCapturing && (
                                  <button
                                    type="button"
                                    className="keybind-clear"
                                    aria-label={translate('settings:auto.keybindsettings.clear_action_binding_value2', { action: definition.action, value2: slotIndex + 1 })}
                                    title={translate('settings:auto.keybindsettings.clear_binding')}
                                    onClick={() => {
                                      clearBinding(definition.id, slotIndex)
                                      setFeedback(`${definition.action} binding cleared.`)
                                    }}
                                  >
                                    ×
                                  </button>
                                )}
                              </div>
                              <button
                                type="button"
                                className={`keybind-global-toggle ${globalOn ? 'active' : ''} ${globalStatus?.state === 'unavailable' || globalStatus?.state === 'unsupported' ? 'has-error' : ''}`}
                                aria-pressed={globalOn}
                                disabled={!binding || !globalSupported || isCapturing}
                                title={!binding
                                  ? translate('settings:auto.keybindsettings.add_a_binding_first')
                                  : !globalSupported
                                    ? translate('settings:auto.keybindsettings.mouse_buttons_cannot_be_registered_globally_by_electron')
                                    : globalStatus?.message}
                                onClick={() => {
                                  setGlobalEnabled(definition.id, slotIndex, !globalOn)
                                  setFeedback(!globalOn
                                    ? `${definition.action} will listen globally while Astra is running.`
                                    : `${definition.action} is now local to Astra.`)
                                }}
                              >
                                <span className="keybind-global-dot" />

                                <LocalizedText ns="settings" i18nKey="auto.keybindsettings.global" />
                              </button>
                              {globalOn && (globalStatus?.state !== 'registered' || hasNoModifiers) && (
                                <span className={`keybind-global-status ${globalStatus?.state === 'unavailable' || globalStatus?.state === 'unsupported' ? 'has-error' : hasNoModifiers && globalStatus?.state === 'registered' ? 'has-warning' : ''}`}>
                                  {globalStatus?.state === 'unavailable' || globalStatus?.state === 'unsupported'
                                    ? globalStatus.message
                                    : globalStatus?.state !== 'registered'
                                      ? translate('settings:auto.keybindsettings.registering')
                                      : translate('settings:auto.keybindsettings.no_modifier_this_key_may_interfere_with_typing_or_naviga')}
                                </span>
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

                        <LocalizedText ns="settings" i18nKey="auto.keybindsettings.reset" />
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
        title={translate('settings:auto.keybindsettings.reassign_binding')}
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
