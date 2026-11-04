/** Public settings state only. Listener credentials and sessions stay in main. */
export interface StratumStatus {
  sourceId: number
  enabled: boolean
  state: 'unchecked' | 'checking' | 'unavailable' | 'available' | 'enabled' | 'error'
  endpoint: string | null
  error: string | null
  connection: 'manual' | 'discovery' | null
}

/** A short-lived, main-owned proposal. This contains no listener credentials. */
export interface StratumManualCheck {
  token: string
  endpoint: string
  fingerprint: string
  requiresTrust: boolean
  identityChanged: boolean
}

export interface StratumAPI {
  status(sourceId: number): Promise<StratumStatus>
  discover(sourceId: number): Promise<StratumStatus>
  setEnabled(sourceId: number, enabled: boolean): Promise<StratumStatus>
  inspectManual(sourceId: number, address: string): Promise<StratumManualCheck>
  connectManual(sourceId: number, token: string): Promise<StratumStatus>
  forgetManual(sourceId: number): Promise<StratumStatus>
  onChanged(callback: (status: StratumStatus) => void): () => void
}
