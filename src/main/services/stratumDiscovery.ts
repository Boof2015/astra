export interface StratumEndpoint { url: string; trust: 'sidecar_key' | 'https_proxy' }
export interface StratumManifest {
  version: 1
  kind: 'astra-sidecar'
  installation: string
  spkiSha256: string
  endpoints: StratumEndpoint[]
}

export const STRATUM_CAPABILITIES = '/stratum/access/v1/capabilities'
export class StratumVerificationError extends Error {}

export function stratumEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || /[\s\\\p{Cc}]/u.test(value)) {
    throw new Error('Invalid Sidecar address.')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invalid Sidecar address.') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash
    || url.port === '0' || ['0.0.0.0', '[::]'].includes(url.hostname)) throw new Error('Sidecar requires a complete HTTPS address.')
  return url.toString().replace(/\/+$/, '')
}

/** Accept only the installed Sidecar format, not the earlier proof's URL array. */
export function parseStratumManifest(value: unknown): StratumManifest {
  const v = value as StratumManifest | null
  if (!v || v.version !== 1 || v.kind !== 'astra-sidecar' || typeof v.installation !== 'string' || !/^[a-fA-F0-9]{32}$/.test(v.installation)
    || typeof v.spkiSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(v.spkiSha256) || !Array.isArray(v.endpoints)
    || !v.endpoints.length || v.endpoints.length > 16) throw new Error('Invalid Stratum announcement.')
  const endpoints = v.endpoints.map(endpoint => {
    if (!endpoint || !['sidecar_key', 'https_proxy'].includes(endpoint.trust)) throw new Error('Invalid Sidecar connection type.')
    const url = stratumEndpoint(endpoint.url)
    if (url !== endpoint.url) throw new Error('Invalid Sidecar address.')
    return { url, trust: endpoint.trust }
  })
  if (new Set(endpoints.map(endpoint => endpoint.url)).size !== endpoints.length) throw new Error('Duplicate Sidecar addresses.')
  return { version: 1, kind: 'astra-sidecar', installation: v.installation.toLowerCase(), spkiSha256: v.spkiSha256.toLowerCase(), endpoints }
}

/** A malformed marked entry is an error; it must not make another entry win. */
export function discoverStratum(radios: unknown[]): StratumManifest | null {
  const candidates: StratumManifest[] = []
  for (const raw of radios) {
    const radio = raw as { homePageUrl?: unknown; streamUrl?: unknown } | null
    if (!radio || typeof radio.homePageUrl !== 'string' || !radio.homePageUrl.includes('#stratum-v1=')) continue
    try {
      if (radio.homePageUrl.length > 16384) throw new Error()
      const [address, descriptor] = radio.homePageUrl.split('#stratum-v1=')
      const manifest = parseStratumManifest(JSON.parse(decodeURIComponent(descriptor)))
      if (address !== radio.streamUrl || address !== manifest.endpoints[0].url + STRATUM_CAPABILITIES) throw new Error()
      candidates.push(manifest)
    } catch { throw new Error('The Stratum announcement is invalid. Ask the server owner to update discovery in Sidecar.') }
  }
  if (candidates.length > 1) throw new Error('More than one Stratum announcement was found. Ask the server owner to remove the extra entry.')
  return candidates[0] ?? null
}

export function verifyStratumCapabilities(bytes: Buffer, manifest: StratumManifest): void {
  let value: Record<string, unknown>
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Sidecar returned an invalid response.') }
  if (!value || value.service !== 'astra-sidecar' || value.installation !== manifest.installation
    || value.spkiSha256 !== manifest.spkiSha256) throw new StratumVerificationError('Sidecar does not match this server’s Stratum announcement.')
  if (value.protocol !== 'stratum-access-proof-1' || value.audioExperiment !== 'stratum-authenticated-audio-1'
    || value.authentication !== 'subsonic-token' || value.sessionRenewal !== 'fresh-credentials-same-user') {
    throw new StratumVerificationError('This Sidecar version is not supported by Astra.')
  }
  if (value.ready !== true || value.playback !== true) throw new StratumVerificationError('Finish Sidecar setup before enabling Stratum.')
}
