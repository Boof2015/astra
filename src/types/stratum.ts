/** Public settings state only. Listener credentials and sessions stay in main. */
export interface StratumStatus {
  sourceId: number
  enabled: boolean
  state: 'unchecked' | 'checking' | 'unavailable' | 'available' | 'enabled' | 'error'
  endpoint: string | null
  error: string | null
}

export interface StratumAPI {
  status(sourceId: number): Promise<StratumStatus>
  discover(sourceId: number): Promise<StratumStatus>
  setEnabled(sourceId: number, enabled: boolean): Promise<StratumStatus>
  onChanged(callback: (status: StratumStatus) => void): () => void
}
