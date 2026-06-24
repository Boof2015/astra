import { create } from 'zustand'
import type { InputActionId, InputBinding } from '../../types/inputBindings'
import {
  INPUT_ACTION_DEFINITIONS,
  INPUT_ACTION_IDS,
  MAX_BINDINGS_PER_ACTION,
  getInputActionDefinition
} from '../constants/keyboardShortcuts'
import { cloneInputBinding, inputBindingsEqual, sanitizeInputBinding } from '../utils/inputBindings'

export const INPUT_BINDINGS_STORAGE_KEY = 'astra-input-bindings-v1'

export type InputBindingSlots = [InputBinding | null, InputBinding | null]
export type InputBindingOverrides = Partial<Record<InputActionId, InputBindingSlots>>

interface PersistedInputBindings {
  version: 1
  overrides: Record<string, unknown>
}

interface InputBindingStore {
  overrides: InputBindingOverrides
  assignBinding: (actionId: InputActionId, slotIndex: number, binding: InputBinding) => void
  clearBinding: (actionId: InputActionId, slotIndex: number) => void
  resetAction: (actionId: InputActionId) => void
  resetAll: () => void
}

function toSlots(bindings: readonly InputBinding[]): InputBindingSlots {
  return [
    bindings[0] ? cloneInputBinding(bindings[0]) : null,
    bindings[1] ? cloneInputBinding(bindings[1]) : null
  ]
}

export function getDefaultBindingSlots(actionId: InputActionId): InputBindingSlots {
  return toSlots(getInputActionDefinition(actionId).defaultBindings)
}

export function getEffectiveBindingSlots(
  actionId: InputActionId,
  overrides: InputBindingOverrides
): InputBindingSlots {
  const override = overrides[actionId]
  if (!override) return getDefaultBindingSlots(actionId)
  return [override[0] ? cloneInputBinding(override[0]) : null, override[1] ? cloneInputBinding(override[1]) : null]
}

export function findBindingConflict(
  binding: InputBinding,
  actionId: InputActionId,
  slotIndex: number,
  overrides: InputBindingOverrides
): { actionId: InputActionId; slotIndex: number } | null {
  for (const definition of INPUT_ACTION_DEFINITIONS) {
    const slots = getEffectiveBindingSlots(definition.id, overrides)
    for (let index = 0; index < slots.length; index += 1) {
      const candidate = slots[index]
      if (!candidate || (definition.id === actionId && index === slotIndex)) continue
      if (inputBindingsEqual(candidate, binding)) return { actionId: definition.id, slotIndex: index }
    }
  }
  return null
}

function sanitizeSlots(value: unknown): InputBindingSlots | null {
  if (!Array.isArray(value) || value.length > MAX_BINDINGS_PER_ACTION) return null
  const slots: InputBindingSlots = [null, null]
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === null) continue
    const binding = sanitizeInputBinding(value[index])
    if (!binding) return null
    slots[index] = binding
  }
  return slots
}

export function parseInputBindingOverrides(rawValue: string | null): InputBindingOverrides {
  if (!rawValue) return {}
  try {
    const parsed = JSON.parse(rawValue) as Partial<PersistedInputBindings>
    if (parsed.version !== 1 || !parsed.overrides || typeof parsed.overrides !== 'object') return {}

    const overrides: InputBindingOverrides = {}
    for (const [rawActionId, rawSlots] of Object.entries(parsed.overrides)) {
      const actionId = rawActionId as InputActionId
      if (!INPUT_ACTION_IDS.has(actionId)) continue
      const slots = sanitizeSlots(rawSlots)
      if (slots) overrides[actionId] = slots
    }
    return overrides
  } catch {
    return {}
  }
}

function readOverrides(): InputBindingOverrides {
  try {
    return parseInputBindingOverrides(localStorage.getItem(INPUT_BINDINGS_STORAGE_KEY))
  } catch {
    return {}
  }
}

function persistOverrides(overrides: InputBindingOverrides): void {
  try {
    const payload: PersistedInputBindings = { version: 1, overrides }
    localStorage.setItem(INPUT_BINDINGS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Keep in-memory bindings when storage is unavailable.
  }
}

function clearPersistedOverrides(): void {
  try {
    localStorage.removeItem(INPUT_BINDINGS_STORAGE_KEY)
  } catch {
    // Keep the in-memory reset when storage is unavailable.
  }
}

function updateOverride(
  overrides: InputBindingOverrides,
  actionId: InputActionId,
  slots: InputBindingSlots
): InputBindingOverrides {
  return { ...overrides, [actionId]: slots }
}

export const useInputBindingStore = create<InputBindingStore>((set) => ({
  overrides: readOverrides(),
  assignBinding: (actionId, slotIndex, binding) => set((state) => {
    if (slotIndex < 0 || slotIndex >= MAX_BINDINGS_PER_ACTION) return state
    let nextOverrides = { ...state.overrides }
    const conflict = findBindingConflict(binding, actionId, slotIndex, state.overrides)
    if (conflict) {
      const conflictSlots = getEffectiveBindingSlots(conflict.actionId, nextOverrides)
      conflictSlots[conflict.slotIndex] = null
      nextOverrides = updateOverride(nextOverrides, conflict.actionId, conflictSlots)
    }

    const targetSlots = getEffectiveBindingSlots(actionId, nextOverrides)
    targetSlots[slotIndex] = cloneInputBinding(binding)
    nextOverrides = updateOverride(nextOverrides, actionId, targetSlots)
    persistOverrides(nextOverrides)
    return { overrides: nextOverrides }
  }),
  clearBinding: (actionId, slotIndex) => set((state) => {
    if (slotIndex < 0 || slotIndex >= MAX_BINDINGS_PER_ACTION) return state
    const slots = getEffectiveBindingSlots(actionId, state.overrides)
    slots[slotIndex] = null
    const overrides = updateOverride(state.overrides, actionId, slots)
    persistOverrides(overrides)
    return { overrides }
  }),
  resetAction: (actionId) => set((state) => {
    let overrides = { ...state.overrides }
    delete overrides[actionId]
    const defaults = getDefaultBindingSlots(actionId)
    defaults.forEach((binding, slotIndex) => {
      if (!binding) return
      const conflict = findBindingConflict(binding, actionId, slotIndex, overrides)
      if (!conflict || conflict.actionId === actionId) return
      const conflictSlots = getEffectiveBindingSlots(conflict.actionId, overrides)
      conflictSlots[conflict.slotIndex] = null
      overrides = updateOverride(overrides, conflict.actionId, conflictSlots)
    })
    persistOverrides(overrides)
    return { overrides }
  }),
  resetAll: () => set(() => {
    const overrides: InputBindingOverrides = {}
    clearPersistedOverrides()
    return { overrides }
  })
}))
