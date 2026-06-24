export type ControllerFamily = 'xbox' | 'playstation'

export type ControllerDirection = 'up' | 'down' | 'left' | 'right'

export type ControllerCommand =
  | { type: 'move'; direction: ControllerDirection }
  | { type: 'activate' }
  | { type: 'back' }
  | { type: 'context' }
  | { type: 'toggle-queue' }
  | { type: 'playback-toggle' }
  | { type: 'bumper-left' }
  | { type: 'bumper-right' }
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
  context: string
  queue: string
  menu: string
  bumperLeft: string
  bumperRight: string
  stickLeft: string
  stickRight: string
}
