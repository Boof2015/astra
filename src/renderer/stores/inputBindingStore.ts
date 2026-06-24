import { create } from 'zustand'
import type {
  GlobalShortcutRegistrationResult,
  InputActionId,
  InputBinding
} from '../../types/inputBindings'
import {
  INPUT_ACTION_DEFINITIONS,
  INPUT_ACTION_IDS,
  MAX_BINDINGS_PER_ACTION,
  getInputActionDefinition
} from '../constants/keyboardShortcuts'
import { cloneInputBinding, inputBindingsEqual, sanitizeInputBinding } from '../utils/inputBindings'

export const INPUT_BINDINGS_STORAGE_KEY = 'astra-input-bindings-v1'
export const GLOBAL_INPUT_BINDINGS_STORAGE_KEY = 'astra-global-input-bindings-v1'

export type InputBindingSlots = [InputBinding | null, InputBinding | null]
export type InputBindingOverrides = Partial<Record<InputActionId, InputBindingSlots>>
export type GlobalInputBindingSlots = [boolean, boolean]
export type GlobalInputBindingPreferences = Partial<Record<InputActionId, GlobalInputBindingSlots>>
export type GlobalInputBindingStatuses = Record<string, GlobalShortcutRegistrationResult>

interface PersistedInputBindings {
  version: 1
  overrides: Record<string, unknown>
}

interface InputBindingStore {
  overrides: InputBindingOverrides
  globalEnabled: GlobalInputBindingPreferences
  globalStatuses: GlobalInputBindingStatuses
  globalRegistrationSuspended: boolean
  assignBinding: (actionId: InputActionId, slotIndex: number, binding: InputBinding) => void
  clearBinding: (actionId: InputActionId, slotIndex: number) => void
  resetAction: (actionId: InputActionId) => void
  resetAll: () => void
  setGlobalEnabled: (actionId: InputActionId, slotIndex: number, enabled: boolean) => void
  setGlobalStatuses: (statuses: GlobalShortcutRegistrationResult[]) => void
  setGlobalRegistrationSuspended: (suspended: boolean) => void
}

interface PersistedGlobalInputBindings {
  version: 1
  enabled: Record<string, unknown>
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

function parseGlobalInputBindingPreferences(rawValue: string | null): GlobalInputBindingPreferences {
  if (!rawValue) return {}
  try {
    const parsed = JSON.parse(rawValue) as Partial<PersistedGlobalInputBindings>
    if (parsed.version !== 1 || !parsed.enabled || typeof parsed.enabled !== 'object') return {}
    const enabled: GlobalInputBindingPreferences = {}
    for (const [rawActionId, rawSlots] of Object.entries(parsed.enabled)) {
      const actionId = rawActionId as InputActionId
      if (!INPUT_ACTION_IDS.has(actionId) || !Array.isArray(rawSlots)) continue
      enabled[actionId] = [rawSlots[0] === true, rawSlots[1] === true]
    }
    return enabled
  } catch {
    return {}
  }
}

function readGlobalEnabled(): GlobalInputBindingPreferences {
  try {
    return parseGlobalInputBindingPreferences(localStorage.getItem(GLOBAL_INPUT_BINDINGS_STORAGE_KEY))
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

function persistGlobalEnabled(enabled: GlobalInputBindingPreferences): void {
  try {
    const payload: PersistedGlobalInputBindings = { version: 1, enabled }
    localStorage.setItem(GLOBAL_INPUT_BINDINGS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Keep in-memory global preferences when storage is unavailable.
  }
}

function clearPersistedGlobalEnabled(): void {
  try {
    localStorage.removeItem(GLOBAL_INPUT_BINDINGS_STORAGE_KEY)
  } catch {
    // Keep the in-memory reset when storage is unavailable.
  }
}

export function getGlobalInputBindingSlotKey(actionId: InputActionId, slotIndex: number): string {
  return `${actionId}:${slotIndex}`
}

export function isGlobalInputBindingEnabled(
  actionId: InputActionId,
  slotIndex: number,
  preferences: GlobalInputBindingPreferences
): boolean {
  return preferences[actionId]?.[slotIndex] === true
}

function updateGlobalPreference(
  preferences: GlobalInputBindingPreferences,
  actionId: InputActionId,
  slotIndex: number,
  enabled: boolean
): GlobalInputBindingPreferences {
  const slots: GlobalInputBindingSlots = [
    preferences[actionId]?.[0] === true,
    preferences[actionId]?.[1] === true
  ]
  slots[slotIndex] = enabled
  return { ...preferences, [actionId]: slots }
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
  globalEnabled: readGlobalEnabled(),
  globalStatuses: {},
  globalRegistrationSuspended: false,
  assignBinding: (actionId, slotIndex, binding) => set((state) => {
    if (slotIndex < 0 || slotIndex >= MAX_BINDINGS_PER_ACTION) return state
    let nextOverrides = { ...state.overrides }
    let nextGlobalEnabled = { ...state.globalEnabled }
    const conflict = findBindingConflict(binding, actionId, slotIndex, state.overrides)
    if (conflict) {
      const conflictSlots = getEffectiveBindingSlots(conflict.actionId, nextOverrides)
      conflictSlots[conflict.slotIndex] = null
      nextOverrides = updateOverride(nextOverrides, conflict.actionId, conflictSlots)
      nextGlobalEnabled = updateGlobalPreference(nextGlobalEnabled, conflict.actionId, conflict.slotIndex, false)
    }

    const targetSlots = getEffectiveBindingSlots(actionId, nextOverrides)
    targetSlots[slotIndex] = cloneInputBinding(binding)
    nextOverrides = updateOverride(nextOverrides, actionId, targetSlots)
    if (binding.device !== 'keyboard') {
      nextGlobalEnabled = updateGlobalPreference(nextGlobalEnabled, actionId, slotIndex, false)
    }
    persistOverrides(nextOverrides)
    persistGlobalEnabled(nextGlobalEnabled)
    return { overrides: nextOverrides, globalEnabled: nextGlobalEnabled, globalStatuses: {} }
  }),
  clearBinding: (actionId, slotIndex) => set((state) => {
    if (slotIndex < 0 || slotIndex >= MAX_BINDINGS_PER_ACTION) return state
    const slots = getEffectiveBindingSlots(actionId, state.overrides)
    slots[slotIndex] = null
    const overrides = updateOverride(state.overrides, actionId, slots)
    const globalEnabled = updateGlobalPreference(state.globalEnabled, actionId, slotIndex, false)
    persistOverrides(overrides)
    persistGlobalEnabled(globalEnabled)
    return { overrides, globalEnabled, globalStatuses: {} }
  }),
  resetAction: (actionId) => set((state) => {
    let overrides = { ...state.overrides }
    let globalEnabled = { ...state.globalEnabled }
    delete overrides[actionId]
    delete globalEnabled[actionId]
    const defaults = getDefaultBindingSlots(actionId)
    defaults.forEach((binding, slotIndex) => {
      if (!binding) return
      const conflict = findBindingConflict(binding, actionId, slotIndex, overrides)
      if (!conflict || conflict.actionId === actionId) return
      const conflictSlots = getEffectiveBindingSlots(conflict.actionId, overrides)
      conflictSlots[conflict.slotIndex] = null
      overrides = updateOverride(overrides, conflict.actionId, conflictSlots)
      globalEnabled = updateGlobalPreference(globalEnabled, conflict.actionId, conflict.slotIndex, false)
    })
    persistOverrides(overrides)
    persistGlobalEnabled(globalEnabled)
    return { overrides, globalEnabled, globalStatuses: {} }
  }),
  resetAll: () => set(() => {
    const overrides: InputBindingOverrides = {}
    clearPersistedOverrides()
    clearPersistedGlobalEnabled()
    return { overrides, globalEnabled: {}, globalStatuses: {} }
  }),
  setGlobalEnabled: (actionId, slotIndex, enabled) => set((state) => {
    if (slotIndex < 0 || slotIndex >= MAX_BINDINGS_PER_ACTION) return state
    const binding = getEffectiveBindingSlots(actionId, state.overrides)[slotIndex]
    if (enabled && binding?.device !== 'keyboard') return state
    const globalEnabled = updateGlobalPreference(state.globalEnabled, actionId, slotIndex, enabled)
    persistGlobalEnabled(globalEnabled)
    const globalStatuses = { ...state.globalStatuses }
    delete globalStatuses[getGlobalInputBindingSlotKey(actionId, slotIndex)]
    return { globalEnabled, globalStatuses }
  }),
  setGlobalStatuses: (statuses) => set(() => ({
    globalStatuses: Object.fromEntries(statuses.map((status) => [
      getGlobalInputBindingSlotKey(status.actionId, status.slotIndex),
      status
    ]))
  })),
  setGlobalRegistrationSuspended: (globalRegistrationSuspended) => set({ globalRegistrationSuspended })
}))
