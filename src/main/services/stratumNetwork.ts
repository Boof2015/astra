// Startup includes multiple TLS exchanges and server-side source preparation.
// These are control requests, not evidence that an audio bitrate is too high.
export const STRATUM_CONNECT_TIMEOUT_MS = 60_000
export const STRATUM_VERIFY_TIMEOUT_MS = 15_000
export const STRATUM_CONTROL_TIMEOUT_MS = 30_000
// Releasing a handle/session also needs a fresh HTTPS connection. A 1.5-second
// cutoff can abandon the DELETE before it reaches Sidecar, exhausting its slots
// on subsequent skips. Keep cleanup bounded, but allow the audio-request budget.
export const STRATUM_CLEANUP_TIMEOUT_MS = 12_000

export function stratumRequestTimeout(path: string): number {
  // Keep audio delivery's existing bound separate from startup patience.
  return path.endsWith('/segment') ? 12_000 : STRATUM_CONTROL_TIMEOUT_MS
}

/** Only app-owned messages, never raw socket errors, URLs or server responses. */
export class StratumNetworkError extends Error {
  readonly kind: 'timeout' | 'connection' | 'interrupted'
  readonly contextual: boolean
  constructor(kind: 'timeout' | 'connection' | 'interrupted', detail?: string) {
    super(detail ?? (kind === 'timeout' ? 'Sidecar took too long to respond.'
      : kind === 'interrupted' ? 'The connection to Sidecar was interrupted.'
      : 'Could not connect to Sidecar.'))
    this.kind = kind
    this.contextual = detail !== undefined
  }
}

const timeoutMessages = {
  secure: 'Sidecar took too long to establish a secure connection.',
  verification: 'Sidecar took too long to answer its connection check.',
  signin: 'Sidecar took too long to complete sign-in.',
  preparation: 'Sidecar took too long to prepare this track.',
  segment: 'Sidecar took too long to send this audio segment.',
  discovery: 'Navidrome took too long to provide Sidecar’s discovery information.',
  setup: 'Connecting and signing in to Sidecar took too long.',
  request: 'Sidecar took too long to respond.'
} as const

/** Describe only known operations, never a URL, track id, handle or raw error.
 * Outer waits preserve the innermost request's more specific timeout. */
export function stratumTimeoutContext(error: unknown, stage: keyof typeof timeoutMessages): unknown {
  if (error instanceof StratumNetworkError ? error.kind === 'timeout' && !error.contextual
    : error instanceof Error && error.name === 'TimeoutError') {
    return new StratumNetworkError('timeout', timeoutMessages[stage])
  }
  return error
}

export function stratumRequestStage(path: string): keyof typeof timeoutMessages {
  return path === '/access/v1/capabilities' ? 'verification'
    : path === '/access/v1/sessions' || path === '/access/v1/session' ? 'signin'
      : path.startsWith('/audio/v1/playbacks/') ? 'preparation'
        : path.endsWith('/segment') ? 'segment' : 'request'
}

export function stratumConnectionFailure(error: unknown, secure: boolean): StratumNetworkError {
  const code = (error as { code?: unknown })?.code
  if (code === 'ETIMEDOUT') return new StratumNetworkError('timeout')
  const messages: Record<string, string> = {
    ECONNRESET: secure ? 'Sidecar closed the connection before sending a response.' : 'The connection to Sidecar closed during the HTTPS handshake.',
    EPIPE: 'The connection to Sidecar closed while sending the request.',
    ECONNREFUSED: 'Sidecar refused the connection. Check that it is running.',
    EHOSTUNREACH: 'Sidecar’s address could not be reached from this computer.',
    ENETUNREACH: 'The network used to reach Sidecar is unavailable.',
    ENOTFOUND: 'Sidecar’s address could not be found.',
    EAI_AGAIN: 'Sidecar’s address could not be resolved. Try again.',
    EACCES: 'This computer blocked Astra’s connection to Sidecar.',
    EPERM: 'This computer blocked Astra’s connection to Sidecar.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Sidecar’s HTTPS certificate is not trusted.',
    SELF_SIGNED_CERT_IN_CHAIN: 'Sidecar’s HTTPS certificate is not trusted.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Sidecar’s HTTPS certificate could not be verified.',
    CERT_HAS_EXPIRED: 'Sidecar’s HTTPS certificate has expired.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'Sidecar’s HTTPS certificate does not match its address.'
  }
  // Native error codes identify the failure without exposing raw errors or URLs.
  const message = typeof code === 'string' && Object.hasOwn(messages, code) ? `${messages[code]} (${code})`
    : secure ? 'The connection to Sidecar failed before a response arrived.' : 'Could not establish an HTTPS connection to Sidecar.'
  return new StratumNetworkError('connection', message)
}

export function stratumAborted(signal: AbortSignal): Error {
  return signal.reason?.name === 'TimeoutError' ? new StratumNetworkError('timeout')
    : new Error('Stratum playback was cancelled.')
}
