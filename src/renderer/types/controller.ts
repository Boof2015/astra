export type ControllerFamily = 'xbox' | 'playstation'

export type ControllerDirection = 'up' | 'down' | 'left' | 'right'

export type ControllerCommand =
  | { type: 'move'; direction: ControllerDirection }
  | { type: 'activate' }
  | { type: 'back' }
  | { type: 'toggle-queue' }
  | { type: 'playback-toggle' }
  | { type: 'previous-track' }
  | { type: 'next-track' }
  | { type: 'open-radial' }
  | { type: 'jump-sidebar' }
  | { type: 'jump-transport' }
  | { type: 'seek-backward' }
  | { type: 'seek-forward' }
  | { type: 'scroll'; delta: number }

export interface ControllerFrame {
  index: number
  id: string
  mapping: string
  buttons: readonly number[]
  axes: readonly number[]
}

export interface ControllerPromptLabels {
  activate: string
  back: string
  playPause: string
  queue: string
  radialMenu: string
  bumperLeft: string
  bumperRight: string
  triggerLeft: string
  triggerRight: string
  stickLeft: string
  stickRight: string
}

export type ControllerButtonRole = keyof ControllerPromptLabels
