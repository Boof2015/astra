export interface LocalPcmProbeDecodeCoordinationOptions<TProbe, TDecode> {
  probePromise: Promise<TProbe>
  startDecode: () => Promise<TDecode>
  acceptProbe: (probe: TProbe) => void | Promise<void>
  overlap: boolean
}

/**
 * Starts decode early when overlap is enabled, but never exposes a successful
 * decode result until authoritative probe metadata has been accepted. In
 * serial rollback mode, decode starts only after that same acceptance point.
 */
export async function coordinateLocalPcmProbeAndDecode<TProbe, TDecode>(
  options: LocalPcmProbeDecodeCoordinationOptions<TProbe, TDecode>
): Promise<{ probe: TProbe; decode: TDecode }> {
  void options.probePromise.catch(() => undefined)
  let decodePromise = options.overlap ? options.startDecode() : null
  if (decodePromise) {
    // Probe acceptance remains the ordering barrier, but an implementation
    // may reject its decode promise before the probe finishes. Observe that
    // rejection immediately while preserving it for the awaited result.
    void decodePromise.catch(() => undefined)
  }
  const probe = await options.probePromise
  await options.acceptProbe(probe)
  decodePromise ??= options.startDecode()
  return {
    probe,
    decode: await decodePromise
  }
}
