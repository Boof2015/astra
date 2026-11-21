/** Only for Astra's retained-cache loopback URLs. The cache suppresses optional
 * end-of-file probing for an unfinished Ogg response, based on its actual bytes.
 * Use the ordinary URL for seeks, which still need random byte access. */
export function remoteAudioStartupUrl(cacheUrl: string): string {
  return `${cacheUrl}?startup=1`
}
