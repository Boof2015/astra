import type { ConnectionFailureKind, SourceErrorKind } from '../../types/subsonic'
import { JellyfinHttpError } from './jellyfin'
import { isPlexAccessFailure, isPlexTransportFailure, PlexRequestError } from './plex'
import { SubsonicRequestError } from './subsonic'

/** Subsonic API errors that mean the server refused this sign-in. */
const SUBSONIC_AUTH_CODES = new Set([40, 41, 44, 50])

/** A proxy or the server itself saying it's down for now: waiting fixes these. */
const UNAVAILABLE_HTTP_STATUSES = new Set([502, 503, 504])

/** TLS failures from Node's fetch about the certificate itself: expired, self-signed, wrong name, unknown issuer. */
const CERTIFICATE_CODE = /CERT|ISSUER|SELF_SIGNED|UNABLE_TO_VERIFY/
/**
 * A secure connection that couldn't be set up at all, before any certificate: typically
 * https:// pointed at a plain-HTTP port (ERR_SSL_WRONG_VERSION_NUMBER).
 */
const SECURE_CONNECTION_CODE = /^ERR_SSL_|^ERR_TLS_|^EPROTO$/

/** The server answered but refused this sign-in: wrong password, revoked token, lost access. */
export function isSignInFailure(error: unknown): boolean {
  if (error instanceof SubsonicRequestError) {
    return (error.apiCode !== undefined && SUBSONIC_AUTH_CODES.has(error.apiCode))
      || error.httpStatus === 401 || error.httpStatus === 403
  }
  if (error instanceof JellyfinHttpError) return error.status === 401 || error.status === 403
  return isPlexAccessFailure(error)
}

/**
 * Nothing usable came back because the server couldn't be reached: the request failed
 * before any answer (other than an untrusted certificate), timed out, or a proxy said
 * the server is down. A server that answered with an error isn't "offline".
 */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof SubsonicRequestError) return error.httpStatus !== undefined && UNAVAILABLE_HTTP_STATUSES.has(error.httpStatus)
  if (error instanceof JellyfinHttpError || error instanceof PlexRequestError) return UNAVAILABLE_HTTP_STATUSES.has(error.status)
  if (isPlexTransportFailure(error)) return true
  const value = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null
  // The Subsonic and Jellyfin clients abort a request that runs past its timeout.
  if (value?.name === 'AbortError' || value?.name === 'TimeoutError') return true
  // Node's fetch rejects with "fetch failed" when no response came back; the cause says why.
  // A TLS failure means something did answer, so it isn't "offline".
  if (error instanceof TypeError && value?.message === 'fetch failed') {
    const code = String(value.cause?.code ?? '')
    return !CERTIFICATE_CODE.test(code) && !SECURE_CONNECTION_CODE.test(code)
  }
  return false
}

/**
 * Why a source stopped working, for what the app offers next: sign in again (`auth`),
 * wait and retry (`unreachable`), or read the server's message (`sync`). While connecting,
 * only a server that couldn't be reached is `unreachable`; one that answered with an
 * error keeps its message. Once connected, anything but a refused sign-in is `sync`.
 */
export function classifySourceError(error: unknown, stage: 'connect' | 'sync'): SourceErrorKind {
  if (isSignInFailure(error)) return 'auth'
  return stage === 'connect' && isTransportFailure(error) ? 'unreachable' : 'sync'
}

/** The code Node's fetch puts on a failed request's cause (or the error itself). */
function failureCode(error: unknown): string {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null
  return String(value?.cause?.code ?? value?.code ?? '')
}

function isCertificateFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed' && CERTIFICATE_CODE.test(failureCode(error))
}

function isSecureConnectionFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed' && !CERTIFICATE_CODE.test(failureCode(error))
    && SECURE_CONNECTION_CODE.test(failureCode(error))
}

const SERVER_NAMES = { subsonic: 'a Subsonic or Navidrome server', jellyfin: 'a Jellyfin server' } as const

/**
 * What a failed connection to a Subsonic or Jellyfin server means, as a plain sentence and
 * a kind the windows can act on. Replaces messages like "fetch failed" or "Jellyfin
 * authentication failed (401)". A refusal is only called a wrong password when it is one.
 */
export function describeConnectionFailure(error: unknown, provider: 'subsonic' | 'jellyfin'): { kind: ConnectionFailureKind; message: string } {
  if (isSignInFailure(error)) {
    const code = error instanceof SubsonicRequestError ? error.apiCode : undefined
    // 50: the account may not do this. 41: token sign-in, which Astra uses, doesn't work for LDAP accounts.
    if (code === 50) return { kind: 'auth', message: 'The server didn’t allow this account to sign in.' }
    if (code === 41) return { kind: 'auth', message: 'The server can’t check this account’s password the way Astra signs in (token sign-in isn’t available for LDAP accounts).' }
    return { kind: 'auth', message: 'The server didn’t accept this username and password.' }
  }
  if (isCertificateFailure(error)) {
    return { kind: 'certificate', message: 'The server’s security certificate isn’t trusted by this computer.' }
  }
  if (isSecureConnectionFailure(error)) {
    return { kind: 'secure-connection', message: 'Astra couldn’t set up a secure connection. If the server doesn’t use HTTPS, start the address with http:// instead.' }
  }
  if (isTransportFailure(error)) {
    const status = error instanceof SubsonicRequestError ? error.httpStatus : error instanceof JellyfinHttpError ? error.status : undefined
    if (status !== undefined) return { kind: 'unreachable', message: `The server is unavailable right now (HTTP ${status}).` }
    const code = failureCode(error)
    const name = (error as { name?: unknown } | null)?.name
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'unreachable', message: 'No server was found at that address. Check the address.' }
    if (code === 'ECONNREFUSED') return { kind: 'unreachable', message: 'The server refused the connection. Check the address and port, and that the server is running.' }
    if (name === 'AbortError' || name === 'TimeoutError' || /TIMEDOUT|TIMEOUT/.test(code)) {
      return { kind: 'unreachable', message: 'The server didn’t respond. Check that it’s running and reachable from this computer.' }
    }
    return { kind: 'unreachable', message: 'The connection to the server failed. Check the address and your network.' }
  }
  if (error instanceof SubsonicRequestError) {
    if (error.apiCode === 20 || error.apiCode === 30) {
      return { kind: 'incompatible', message: `Astra and the server don’t use compatible Subsonic versions. The server said: “${error.message}”` }
    }
    if (error.apiCode !== undefined) return { kind: 'server-error', message: `The server said: “${error.message}”` }
    // An HTTP error before any Subsonic answer: nothing at that path speaks Subsonic.
    if (error.httpStatus === 404 || error.httpStatus === 405) return notThisServer(provider)
    return { kind: 'server-error', message: `The server answered with an error (HTTP ${error.httpStatus}).` }
  }
  if (error instanceof JellyfinHttpError) {
    if (error.status === 404 || error.status === 405) return notThisServer(provider)
    return { kind: 'server-error', message: `The server answered with an error (HTTP ${error.status}).` }
  }
  // An answer that isn't this server's JSON: a web page, or another service's reply.
  if (error instanceof SyntaxError || (error instanceof Error && /^Invalid (Subsonic response payload|Jellyfin authentication response)\.$/.test(error.message))) {
    return notThisServer(provider)
  }
  return { kind: 'other', message: error instanceof Error && error.message ? error.message : 'The connection failed.' }
}

function notThisServer(provider: 'subsonic' | 'jellyfin'): { kind: ConnectionFailureKind; message: string } {
  return { kind: 'not-server', message: `The server answered, but not as ${SERVER_NAMES[provider]}. Check the address, including any path${provider === 'jellyfin' ? ' (like /jellyfin)' : ''}.` }
}

/**
 * The message stored for a failed sync. While connecting it's the plain sentence above.
 * Once connected, a server's own message stays as it is; only a dropped, refused or
 * insecure connection (which would read "fetch failed") or a refused sign-in (whose
 * reason the server page shows) gets the plain sentence.
 */
export function syncFailureMessage(error: unknown, provider: 'subsonic' | 'jellyfin', stage: 'connect' | 'sync'): string {
  if (stage === 'connect' || isSignInFailure(error) || isTransportFailure(error) || isCertificateFailure(error) || isSecureConnectionFailure(error)) {
    return describeConnectionFailure(error, provider).message
  }
  return error instanceof Error && error.message ? error.message : 'The sync failed.'
}
