import type { SourceErrorKind } from '../../types/subsonic'
import { JellyfinHttpError } from './jellyfin'
import { isPlexAccessFailure, isPlexTransportFailure, PlexRequestError } from './plex'
import { SubsonicRequestError } from './subsonic'

/** Subsonic API errors that mean the server refused this sign-in. */
const SUBSONIC_AUTH_CODES = new Set([40, 41, 44, 50])

/** A proxy or the server itself saying it's down for now: waiting fixes these. */
const UNAVAILABLE_HTTP_STATUSES = new Set([502, 503, 504])

/** TLS failures from Node's fetch: a certificate this computer doesn't trust. */
const CERTIFICATE_CODE = /CERT|ISSUER|SELF_SIGNED|SSL|TLS/

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
  if (error instanceof TypeError && value?.message === 'fetch failed') return !CERTIFICATE_CODE.test(String(value.cause?.code ?? ''))
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
