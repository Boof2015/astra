import { createHash, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { connect } from 'node:tls'
import { parseStratumManifest, stratumEndpoint, verifyStratumCapabilities, type StratumManifest } from './stratumDiscovery.ts'
import { createStratumTransport } from './stratumTransport.ts'
import { stratumAborted, stratumConnectionFailure, stratumTimeoutContext } from './stratumNetwork.ts'

interface Identity { fingerprint: string; trusted: boolean }
export interface ManualSidecar { manifest: StratumManifest; requiresTrust: boolean }

/** Inspect only the public TLS certificate. This socket never sends HTTP or credentials.
 * A self-signed identity is a proposal for user acceptance, never an approval. */
export function inspectSidecarIdentity(endpoint: string, signal: AbortSignal): Promise<Identity> {
  const url = new URL(stratumEndpoint(endpoint))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const socket = connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] })
    let settled = false
    const finish = (error?: unknown, value?: Identity) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(stratumTimeoutContext(error, 'secure'))
      else resolve(value!)
    }
    const abort = () => finish(stratumAborted(signal))
    signal.addEventListener('abort', abort, { once: true })
    socket.once('error', error => finish(stratumConnectionFailure(error, false)))
    socket.once('close', () => { if (!settled) finish(stratumConnectionFailure({}, false)) })
    socket.once('secureConnect', () => {
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw)
        const reason = String(socket.authorizationError ?? '')
        if (!socket.authorized && !['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(reason)) {
          throw stratumConnectionFailure({ code: reason }, false)
        }
        // Self-signed trust concerns the key, but an expired certificate still needs owner repair.
        if (Date.parse(certificate.validTo) < Date.now()) throw stratumConnectionFailure({ code: 'CERT_HAS_EXPIRED' }, false)
        if (Date.parse(certificate.validFrom) > Date.now()) throw new Error('Sidecar’s HTTPS certificate is not valid yet.')
        const fingerprint = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
        finish(undefined, { fingerprint, trusted: socket.authorized })
      } catch (error) { finish(error) }
    })
    if (signal.aborted) abort()
  })
}

/** Only the entered endpoint is used, even if a response advertises another URL.
 * No redirect, credentials, or listener session is allowed during this check. */
export async function inspectManualSidecar(address: string, signal: AbortSignal, dependencies = {
  identity: inspectSidecarIdentity, transport: createStratumTransport
}): Promise<ManualSidecar> {
  const endpoint = stratumEndpoint(typeof address === 'string' ? address.trim() : address)
  const identity = await dependencies.identity(endpoint, signal)
  const target = { url: endpoint, trust: identity.trusted ? 'https_proxy' as const : 'sidecar_key' as const }
  const transport = dependencies.transport(target, identity.fingerprint)
  try {
    const { bytes } = await transport.request('/access/v1/capabilities', 'GET', signal, undefined, undefined, 16 * 1024)
    let manifest: StratumManifest
    try {
      const value = JSON.parse(bytes.toString('utf8'))
      manifest = parseStratumManifest({ version: 1, kind: 'astra-sidecar', installation: value.installation,
        spkiSha256: identity.trusted ? value.spkiSha256 : identity.fingerprint, endpoints: [target] })
    } catch { throw new Error('This address did not return a compatible Sidecar. Check the address, including any path.') }
    verifyStratumCapabilities(bytes, manifest)
    return { manifest, requiresTrust: !identity.trusted }
  } finally { transport.close?.() }
}
