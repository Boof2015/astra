import type {
  GlobalShortcutRegistrationRequest,
  GlobalShortcutRegistrationResult,
  InputActionId
} from '../../types/inputBindings'
import { keyboardBindingToAccelerator } from '../inputBindings'

export interface GlobalShortcutRegistrar {
  register: (accelerator: string, callback: () => void) => boolean
  unregister: (accelerator: string) => void
}

export class GlobalInputShortcutService {
  private readonly registeredAccelerators = new Set<string>()
  private readonly registrar: GlobalShortcutRegistrar

  constructor(registrar: GlobalShortcutRegistrar) {
    this.registrar = registrar
  }

  configure(
    requests: GlobalShortcutRegistrationRequest[],
    onAction: (actionId: InputActionId) => void
  ): GlobalShortcutRegistrationResult[] {
    this.clear()
    const results: GlobalShortcutRegistrationResult[] = []

    for (const request of requests) {
      const accelerator = keyboardBindingToAccelerator(request.binding)
      if (!accelerator) {
        results.push({
          actionId: request.actionId,
          slotIndex: request.slotIndex,
          state: 'unsupported',
          accelerator: null,
          message: 'This key cannot be represented as an operating-system shortcut.'
        })
        continue
      }

      let registered = false
      try {
        registered = this.registrar.register(accelerator, () => onAction(request.actionId))
      } catch {
        registered = false
      }

      if (registered) {
        this.registeredAccelerators.add(accelerator)
        results.push({
          actionId: request.actionId,
          slotIndex: request.slotIndex,
          state: 'registered',
          accelerator,
          message: 'Listening globally.'
        })
      } else {
        results.push({
          actionId: request.actionId,
          slotIndex: request.slotIndex,
          state: 'unavailable',
          accelerator,
          message: 'The operating system or another application is already using this shortcut.'
        })
      }
    }

    return results
  }

  clear(): void {
    for (const accelerator of this.registeredAccelerators) {
      this.registrar.unregister(accelerator)
    }
    this.registeredAccelerators.clear()
  }
}
