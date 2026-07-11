// IAMF container sniffing shared by the renderer decode branch (AudioEngine)
// and the main-process library scanner. Detection is content-based, not
// extension-based, so misnamed files still route correctly.

import { isIamfObuStream } from './obuWalker'
import { mp4HasIamfTrack } from './mp4'

export type IamfContainerKind = 'obu' | 'mp4'

function asUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

export function detectIamfContainer(bytes: ArrayBuffer | Uint8Array): IamfContainerKind | null {
  const view = asUint8(bytes)
  if (isIamfObuStream(view)) return 'obu'
  if (isMp4File(view) && mp4HasIamfTrack(view)) return 'mp4'
  return null
}

export function isMp4File(bytes: Uint8Array): boolean {
  // ISO-BMFF: 4-byte box size then 'ftyp'.
  return (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  )
}
