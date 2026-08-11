import type { TrayRendererCommand } from '../../types/desktopIntegration'

export class TrayRendererCommandQueue {
  private readonly pending: TrayRendererCommand[] = []

  enqueue(command: TrayRendererCommand): void {
    this.pending.push(command)
  }

  flush(send: (command: TrayRendererCommand) => void): number {
    const commands = this.pending.splice(0)
    for (const command of commands) send(command)
    return commands.length
  }

  get size(): number {
    return this.pending.length
  }
}
