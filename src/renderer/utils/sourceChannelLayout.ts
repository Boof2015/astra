export type SourceChannelRole =
  | 'mono'
  | 'front-left'
  | 'front-right'
  | 'front-center'
  | 'lfe'
  | 'side-left'
  | 'side-right'
  | 'back-left'
  | 'back-right'
  | 'top-front-left'
  | 'top-front-right'
  | 'top-back-left'
  | 'top-back-right'
  | 'unknown'

export interface SourceChannel {
  id: string
  label: string
  role: SourceChannelRole
  index: number
}

export interface ChannelMixInput {
  sourceIndex: number
  gain: number
}

export type ChannelMixMatrix = ChannelMixInput[][]
export type StereoUpmixMode = 'off' | 'ambient'

export type StereoAmbientUpmixRouteKind = 'direct' | 'ambience'

export interface StereoAmbientUpmixInput {
  sourceIndex: 0 | 1
  gain: number
}

export interface StereoAmbientUpmixRoute {
  outputIndex: number
  outputId: string
  kind: StereoAmbientUpmixRouteKind
  inputs: StereoAmbientUpmixInput[]
  delaySeconds: number
  highpassHz: number | null
  lowpassHz: number | null
  allpassFrequenciesHz: number[]
}

export interface StereoAmbientUpmixPlan {
  outputChannels: number
  routes: StereoAmbientUpmixRoute[]
}

export interface ResolveChannelMixMatrixOptions {
  sourceChannels: number
  outputChannels: number
  multichannelEnabled: boolean
  manualRoutingMap?: readonly number[] | null
  includeLfeInDownmix?: boolean
  /**
   * Explicit output layout (one id per output channel). Overrides the
   * count-derived STANDARD_LAYOUTS lookup — required whenever the output bus
   * isn't a standard layout for its channel count (e.g. the binaural render
   * bus for 5.1.2, whose 8 speakers are not 7.1). Ignored when the length
   * doesn't match outputChannels or when a manual routing map is in effect.
   */
  outputChannelIds?: readonly string[] | null
}

export interface CanUseStereoAmbientUpmixOptions {
  sourceChannels: number
  outputChannels: number
  multichannelEnabled: boolean
  standardMode: boolean
  stereoUpmixMode: StereoUpmixMode
  /** See ResolveChannelMixMatrixOptions.outputChannelIds. */
  outputChannelIds?: readonly string[] | null
}

const CENTER_GAIN = Math.SQRT1_2
const SURROUND_GAIN = Math.SQRT1_2
const LFE_DOWNMIX_GAIN = 0.5
const SIDE_AMBIENCE_GAIN = Math.pow(10, -2 / 20)
const SIDE_AMBIENCE_CROSSFEED_GAIN = SIDE_AMBIENCE_GAIN * 0.5
const BACK_AMBIENCE_GAIN = Math.pow(10, -2 / 20)
const BACK_AMBIENCE_CROSSFEED_GAIN = BACK_AMBIENCE_GAIN * 0.5
// HPFs are intentionally aggressive (cascaded twice in the audio graph for
// 24 dB/oct) and the cutoffs are well above kick/bass territory. Any low-end
// leakage on the rears acoustically (or via receiver bass management) sums
// anti-phase with the front bass and audibly cancels it.
const SIDE_AMBIENCE_HIGHPASS_HZ = 300
const SIDE_AMBIENCE_LOWPASS_HZ = 8000
const BACK_AMBIENCE_HIGHPASS_HZ = 300
const BACK_AMBIENCE_LOWPASS_HZ = 6500

const CHANNEL_DEFINITIONS: Record<string, Omit<SourceChannel, 'index'>> = {
  M: { id: 'M', label: 'Mono', role: 'mono' },
  FL: { id: 'FL', label: 'Front Left', role: 'front-left' },
  FR: { id: 'FR', label: 'Front Right', role: 'front-right' },
  FC: { id: 'FC', label: 'Center', role: 'front-center' },
  LFE: { id: 'LFE', label: 'LFE/Sub', role: 'lfe' },
  SL: { id: 'SL', label: 'Side Left', role: 'side-left' },
  SR: { id: 'SR', label: 'Side Right', role: 'side-right' },
  BL: { id: 'BL', label: 'Back Left', role: 'back-left' },
  BR: { id: 'BR', label: 'Back Right', role: 'back-right' },
  TFL: { id: 'TFL', label: 'Top Front Left', role: 'top-front-left' },
  TFR: { id: 'TFR', label: 'Top Front Right', role: 'top-front-right' },
  TBL: { id: 'TBL', label: 'Top Back Left', role: 'top-back-left' },
  TBR: { id: 'TBR', label: 'Top Back Right', role: 'top-back-right' },
}

// 12ch is 7.1.4 in FFmpeg's native channel order (heights after the bed).
// 10ch is deliberately absent: it is ambiguous between 7.1.2 and 5.1.4, so
// 10-channel sources keep the generic CHn fallback.
const STANDARD_LAYOUTS: Record<number, string[]> = {
  1: ['M'],
  2: ['FL', 'FR'],
  3: ['FL', 'FR', 'FC'],
  4: ['FL', 'FR', 'SL', 'SR'],
  5: ['FL', 'FR', 'FC', 'SL', 'SR'],
  6: ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  8: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  12: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
}

function normalizeChannelCount(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(32, Math.trunc(value)))
}

export function normalizeStereoUpmixMode(value: unknown): StereoUpmixMode {
  return value === 'ambient' ? 'ambient' : 'off'
}

function buildFallbackChannel(index: number): SourceChannel {
  return {
    id: `CH${index + 1}`,
    label: `Channel ${index + 1}`,
    role: 'unknown',
    index,
  }
}

/**
 * Builds an output layout from explicit channel ids. Unknown ids keep their
 * name (rather than becoming CHn) so exact-id routing still matches them.
 */
function buildLayoutFromChannelIds(ids: readonly string[]): SourceChannel[] {
  return ids.map((id, index) => {
    const definition = CHANNEL_DEFINITIONS[id]
    return definition ? { ...definition, index } : { ...buildFallbackChannel(index), id, label: id }
  })
}

export function buildStandardChannelLayout(channelCount: number): SourceChannel[] {
  const normalizedCount = normalizeChannelCount(channelCount)
  const standardIds = STANDARD_LAYOUTS[normalizedCount]
  if (!standardIds) {
    return Array.from({ length: normalizedCount }, (_, index) => buildFallbackChannel(index))
  }

  return standardIds.map((id, index) => ({
    ...CHANNEL_DEFINITIONS[id],
    index,
  }))
}

export function getSourceChannelId(index: number, channelCount?: number): string {
  if (channelCount == null) {
    // Preserve the legacy generic source label when the caller has no layout context.
    return `SRC${index + 1}`
  }

  return buildStandardChannelLayout(channelCount)[index]?.id ?? `CH${index + 1}`
}

export function getSourceChannelLabel(index: number, channelCount?: number): string {
  if (channelCount == null) {
    // Preserve the legacy generic source label when the caller has no layout context.
    return `Decoded Channel ${index + 1}`
  }

  return buildStandardChannelLayout(channelCount)[index]?.label ?? `Channel ${index + 1}`
}

export function buildSourceLayout(channelCount: number): SourceChannel[] {
  return buildStandardChannelLayout(channelCount)
}

export function buildSpeakerLayout(channelCount: number): SourceChannel[] {
  return buildStandardChannelLayout(channelCount)
}

function createEmptyMatrix(outputChannels: number): ChannelMixMatrix {
  return Array.from({ length: outputChannels }, () => [])
}

function addMix(
  matrix: ChannelMixMatrix,
  outputIndex: number | null,
  sourceIndex: number,
  gain: number
): void {
  if (outputIndex == null || outputIndex < 0 || outputIndex >= matrix.length) return
  if (!Number.isFinite(gain) || gain <= 0) return

  const row = matrix[outputIndex]
  const existing = row.find((entry) => entry.sourceIndex === sourceIndex)
  if (existing) {
    existing.gain += gain
    return
  }

  row.push({ sourceIndex, gain })
}

function findOutputIndex(layout: readonly SourceChannel[], ids: readonly string[]): number | null {
  for (const id of ids) {
    const index = layout.findIndex((channel) => channel.id === id)
    if (index >= 0) return index
  }

  return null
}

function buildIdentityMatrix(sourceChannels: number, outputChannels: number): ChannelMixMatrix {
  const matrix = createEmptyMatrix(outputChannels)
  for (let index = 0; index < Math.min(sourceChannels, outputChannels); index++) {
    matrix[index].push({ sourceIndex: index, gain: 1 })
  }
  return matrix
}

function buildManualMatrix(
  sourceChannels: number,
  outputChannels: number,
  manualRoutingMap: readonly number[],
  includeLfeInDownmix: boolean
): ChannelMixMatrix {
  const matrix = createEmptyMatrix(outputChannels)
  const sourceLayout = buildSourceLayout(sourceChannels)
  const outputLayout = buildSpeakerLayout(outputChannels)

  for (let outputIndex = 0; outputIndex < outputChannels; outputIndex++) {
    const rawSourceIndex = manualRoutingMap[outputIndex]
    if (!Number.isFinite(rawSourceIndex)) continue
    const sourceIndex = Math.trunc(rawSourceIndex)
    if (sourceIndex < 0 || sourceIndex >= sourceChannels) continue
    matrix[outputIndex].push({ sourceIndex, gain: 1 })
  }

  foldUnmappedManualCenter(matrix, sourceLayout, outputLayout)
  if (includeLfeInDownmix) {
    foldUnmappedManualLfe(matrix, sourceLayout, outputLayout)
  }
  return matrix
}

function rowHasSource(row: readonly ChannelMixInput[], sourceIndex: number | null): boolean {
  return sourceIndex != null && row.some((input) => input.sourceIndex === sourceIndex)
}

function foldUnmappedManualCenter(
  matrix: ChannelMixMatrix,
  sourceLayout: readonly SourceChannel[],
  outputLayout: readonly SourceChannel[]
): void {
  const centerSourceIndex = findOutputIndex(sourceLayout, ['FC'])
  if (centerSourceIndex == null) return
  if (findOutputIndex(outputLayout, ['FC']) != null) return
  if (matrix.some((row) => rowHasSource(row, centerSourceIndex))) return

  const frontLeftSourceIndex = findOutputIndex(sourceLayout, ['FL'])
  const frontRightSourceIndex = findOutputIndex(sourceLayout, ['FR'])
  const frontLeftOutputIndex = findOutputIndex(outputLayout, ['FL'])
  const frontRightOutputIndex = findOutputIndex(outputLayout, ['FR'])

  if (
    frontLeftOutputIndex != null &&
    rowHasSource(matrix[frontLeftOutputIndex], frontLeftSourceIndex)
  ) {
    addMix(matrix, frontLeftOutputIndex, centerSourceIndex, CENTER_GAIN)
  }

  if (
    frontRightOutputIndex != null &&
    rowHasSource(matrix[frontRightOutputIndex], frontRightSourceIndex)
  ) {
    addMix(matrix, frontRightOutputIndex, centerSourceIndex, CENTER_GAIN)
  }
}

function foldUnmappedManualLfe(
  matrix: ChannelMixMatrix,
  sourceLayout: readonly SourceChannel[],
  outputLayout: readonly SourceChannel[]
): void {
  const lfeSourceIndex = findOutputIndex(sourceLayout, ['LFE'])
  if (lfeSourceIndex == null) return
  if (findOutputIndex(outputLayout, ['LFE']) != null) return
  if (matrix.some((row) => rowHasSource(row, lfeSourceIndex))) return

  const frontLeftSourceIndex = findOutputIndex(sourceLayout, ['FL'])
  const frontRightSourceIndex = findOutputIndex(sourceLayout, ['FR'])
  const frontLeftOutputIndex = findOutputIndex(outputLayout, ['FL'])
  const frontRightOutputIndex = findOutputIndex(outputLayout, ['FR'])

  if (
    frontLeftOutputIndex != null &&
    rowHasSource(matrix[frontLeftOutputIndex], frontLeftSourceIndex)
  ) {
    addMix(matrix, frontLeftOutputIndex, lfeSourceIndex, LFE_DOWNMIX_GAIN)
  }

  if (
    frontRightOutputIndex != null &&
    rowHasSource(matrix[frontRightOutputIndex], frontRightSourceIndex)
  ) {
    addMix(matrix, frontRightOutputIndex, lfeSourceIndex, LFE_DOWNMIX_GAIN)
  }
}

function distributeToFront(
  matrix: ChannelMixMatrix,
  outputLayout: readonly SourceChannel[],
  sourceIndex: number,
  gain: number
): void {
  const monoIndex = findOutputIndex(outputLayout, ['M'])
  if (monoIndex != null) {
    addMix(matrix, monoIndex, sourceIndex, gain)
    return
  }

  addMix(matrix, findOutputIndex(outputLayout, ['FL']), sourceIndex, gain)
  addMix(matrix, findOutputIndex(outputLayout, ['FR']), sourceIndex, gain)
}

function routeAutomaticSource(
  matrix: ChannelMixMatrix,
  source: SourceChannel,
  outputLayout: readonly SourceChannel[],
  includeLfeInDownmix: boolean
): void {
  const exactOutputIndex = findOutputIndex(outputLayout, [source.id])
  if (exactOutputIndex != null) {
    addMix(matrix, exactOutputIndex, source.index, 1)
    return
  }

  switch (source.id) {
    case 'M':
      distributeToFront(matrix, outputLayout, source.index, 1)
      return
    case 'FC':
      distributeToFront(matrix, outputLayout, source.index, CENTER_GAIN)
      return
    case 'LFE':
      // LFE fold-down is opt-in because it is effects content, not bass management.
      if (includeLfeInDownmix) {
        distributeToFront(matrix, outputLayout, source.index, LFE_DOWNMIX_GAIN)
      }
      return
    case 'SL': {
      const backLeft = findOutputIndex(outputLayout, ['BL'])
      addMix(
        matrix,
        backLeft ?? findOutputIndex(outputLayout, ['FL', 'M']),
        source.index,
        backLeft != null ? 1 : SURROUND_GAIN
      )
      return
    }
    case 'SR': {
      const backRight = findOutputIndex(outputLayout, ['BR'])
      addMix(
        matrix,
        backRight ?? findOutputIndex(outputLayout, ['FR', 'M']),
        source.index,
        backRight != null ? 1 : SURROUND_GAIN
      )
      return
    }
    case 'BL':
      addMix(
        matrix,
        findOutputIndex(outputLayout, ['SL']) ?? findOutputIndex(outputLayout, ['FL', 'M']),
        source.index,
        SURROUND_GAIN
      )
      return
    case 'BR':
      addMix(
        matrix,
        findOutputIndex(outputLayout, ['SR']) ?? findOutputIndex(outputLayout, ['FR', 'M']),
        source.index,
        SURROUND_GAIN
      )
      return
    case 'TFL':
      addMix(matrix, findOutputIndex(outputLayout, ['FL', 'M']), source.index, SURROUND_GAIN)
      return
    case 'TFR':
      addMix(matrix, findOutputIndex(outputLayout, ['FR', 'M']), source.index, SURROUND_GAIN)
      return
    case 'TBL': {
      // Prefer staying in the height layer (mirrors the SL->BL substitute),
      // then fall down through the rear/side bed before reaching the fronts.
      const topFrontLeft = findOutputIndex(outputLayout, ['TFL'])
      addMix(
        matrix,
        topFrontLeft ?? findOutputIndex(outputLayout, ['BL', 'SL', 'FL', 'M']),
        source.index,
        topFrontLeft != null ? 1 : SURROUND_GAIN
      )
      return
    }
    case 'TBR': {
      const topFrontRight = findOutputIndex(outputLayout, ['TFR'])
      addMix(
        matrix,
        topFrontRight ?? findOutputIndex(outputLayout, ['BR', 'SR', 'FR', 'M']),
        source.index,
        topFrontRight != null ? 1 : SURROUND_GAIN
      )
      return
    }
    case 'FL':
      addMix(matrix, findOutputIndex(outputLayout, ['M']), source.index, 0.5)
      return
    case 'FR':
      addMix(matrix, findOutputIndex(outputLayout, ['M']), source.index, 0.5)
      return
    default:
      if (source.index < matrix.length) {
        addMix(matrix, source.index, source.index, 1)
      }
  }
}

function buildAutomaticMatrix(
  sourceChannels: number,
  outputChannels: number,
  includeLfeInDownmix: boolean,
  outputChannelIds: readonly string[] | null
): ChannelMixMatrix {
  const sourceLayout = buildSourceLayout(sourceChannels)
  const outputLayout = outputChannelIds
    ? buildLayoutFromChannelIds(outputChannelIds)
    : buildSpeakerLayout(outputChannels)

  // With explicit ids, matching counts no longer imply matching layouts
  // (an 8-wide 5.1.2 bus is not 7.1) — identity requires id equality.
  const isIdentity = outputChannelIds
    ? sourceLayout.length === outputLayout.length &&
      sourceLayout.every((channel, index) => channel.id === outputLayout[index].id)
    : sourceChannels === outputChannels
  if (isIdentity) {
    return buildIdentityMatrix(sourceChannels, outputChannels)
  }

  const matrix = createEmptyMatrix(outputChannels)

  for (const source of sourceLayout) {
    routeAutomaticSource(matrix, source, outputLayout, includeLfeInDownmix)
  }

  return matrix
}

export function resolveChannelMixMatrix(options: ResolveChannelMixMatrixOptions): ChannelMixMatrix {
  const sourceChannels = normalizeChannelCount(options.sourceChannels)
  const requestedOutputChannels = normalizeChannelCount(options.outputChannels)
  const outputChannels = options.multichannelEnabled
    ? requestedOutputChannels
    : Math.min(2, requestedOutputChannels)
  const includeLfeInDownmix = Boolean(options.includeLfeInDownmix)

  const manualRoutingMap = options.multichannelEnabled && options.manualRoutingMap && options.manualRoutingMap.length > 0
    ? options.manualRoutingMap
    : null

  if (manualRoutingMap) {
    return buildManualMatrix(sourceChannels, outputChannels, manualRoutingMap, includeLfeInDownmix)
  }

  const outputChannelIds = options.outputChannelIds && options.outputChannelIds.length === outputChannels
    ? options.outputChannelIds
    : null

  return buildAutomaticMatrix(sourceChannels, outputChannels, includeLfeInDownmix, outputChannelIds)
}

interface StereoAmbientRouteSpec {
  outputId: string
  kind: StereoAmbientUpmixRouteKind
  inputs: StereoAmbientUpmixInput[]
  delaySeconds?: number
  highpassHz?: number | null
  lowpassHz?: number | null
  allpassFrequenciesHz?: number[]
}

function addStereoAmbientRoute(
  routes: StereoAmbientUpmixRoute[],
  layout: readonly SourceChannel[],
  spec: StereoAmbientRouteSpec
): void {
  const outputIndex = findOutputIndex(layout, [spec.outputId])
  if (outputIndex == null) return

  routes.push({
    outputIndex,
    outputId: spec.outputId,
    kind: spec.kind,
    inputs: spec.inputs,
    delaySeconds: spec.delaySeconds ?? 0,
    highpassHz: spec.highpassHz ?? null,
    lowpassHz: spec.lowpassHz ?? null,
    allpassFrequenciesHz: spec.allpassFrequenciesHz ?? [],
  })
}

export function resolveStereoAmbientUpmixPlan(
  outputChannels: number,
  outputChannelIds?: readonly string[] | null
): StereoAmbientUpmixPlan {
  const normalizedOutputChannels = normalizeChannelCount(outputChannels)
  // Ambience only targets the bed (SL/SR/BL/BR); with an explicit layout,
  // speakers the layout doesn't have are simply skipped (5.1.2 gets side
  // ambience only) and heights stay silent.
  const outputLayout = outputChannelIds && outputChannelIds.length === normalizedOutputChannels
    ? buildLayoutFromChannelIds(outputChannelIds)
    : buildSpeakerLayout(normalizedOutputChannels)
  const routes: StereoAmbientUpmixRoute[] = []

  // Sign-flipped crossfeed emphasizes the stereo difference signal, but it is
  // intentionally weaker than the same-side feed so centered content does not
  // disappear completely from the ambient bed.
  addStereoAmbientRoute(routes, outputLayout, {
    outputId: 'FL', kind: 'direct', inputs: [{ sourceIndex: 0, gain: 1 }],
  })
  addStereoAmbientRoute(routes, outputLayout, {
    outputId: 'FR', kind: 'direct', inputs: [{ sourceIndex: 1, gain: 1 }],
  })

  addStereoAmbientRoute(routes, outputLayout, {
    outputId: 'SL',
    kind: 'ambience',
    inputs: [
      { sourceIndex: 0, gain: SIDE_AMBIENCE_GAIN },
      { sourceIndex: 1, gain: -SIDE_AMBIENCE_CROSSFEED_GAIN },
    ],
    highpassHz: SIDE_AMBIENCE_HIGHPASS_HZ,
    lowpassHz: SIDE_AMBIENCE_LOWPASS_HZ,
    allpassFrequenciesHz: [420, 1700, 4300],
    delaySeconds: 0.012,
  })
  addStereoAmbientRoute(routes, outputLayout, {
    outputId: 'SR',
    kind: 'ambience',
    inputs: [
      { sourceIndex: 0, gain: -SIDE_AMBIENCE_CROSSFEED_GAIN },
      { sourceIndex: 1, gain: SIDE_AMBIENCE_GAIN },
    ],
    highpassHz: SIDE_AMBIENCE_HIGHPASS_HZ,
    lowpassHz: SIDE_AMBIENCE_LOWPASS_HZ,
    allpassFrequenciesHz: [380, 1900, 4700],
    delaySeconds: 0.016,
  })
  addStereoAmbientRoute(routes, outputLayout, {
    outputId: 'BL',
    kind: 'ambience',
    inputs: [
      { sourceIndex: 0, gain: BACK_AMBIENCE_GAIN },
      { sourceIndex: 1, gain: -BACK_AMBIENCE_CROSSFEED_GAIN },
    ],
    highpassHz: BACK_AMBIENCE_HIGHPASS_HZ,
    lowpassHz: BACK_AMBIENCE_LOWPASS_HZ,
    allpassFrequenciesHz: [310, 1300, 3200],
    delaySeconds: 0.022,
  })
  addStereoAmbientRoute(routes, outputLayout, {
    outputId: 'BR',
    kind: 'ambience',
    inputs: [
      { sourceIndex: 0, gain: -BACK_AMBIENCE_CROSSFEED_GAIN },
      { sourceIndex: 1, gain: BACK_AMBIENCE_GAIN },
    ],
    highpassHz: BACK_AMBIENCE_HIGHPASS_HZ,
    lowpassHz: BACK_AMBIENCE_LOWPASS_HZ,
    allpassFrequenciesHz: [340, 1450, 3500],
    delaySeconds: 0.026,
  })

  routes.sort((a, b) => a.outputIndex - b.outputIndex)

  return {
    outputChannels: normalizedOutputChannels,
    routes,
  }
}

export function canUseStereoAmbientUpmix(options: CanUseStereoAmbientUpmixOptions): boolean {
  if (!options.standardMode) return false
  if (options.stereoUpmixMode !== 'ambient') return false
  if (!options.multichannelEnabled) return false

  const sourceChannels = normalizeChannelCount(options.sourceChannels)
  const outputChannels = normalizeChannelCount(options.outputChannels)
  if (sourceChannels !== 2 || outputChannels <= 2) return false

  return resolveStereoAmbientUpmixPlan(outputChannels, options.outputChannelIds)
    .routes.some((route) => route.kind === 'ambience')
}

export function isIdentityChannelMixMatrix(
  matrix: readonly (readonly ChannelMixInput[])[],
  sourceChannels: number,
  outputChannels: number
): boolean {
  if (matrix.length !== outputChannels) return false

  for (let outputIndex = 0; outputIndex < outputChannels; outputIndex++) {
    const row = matrix[outputIndex]
    if (outputIndex >= sourceChannels) {
      if (row.length !== 0) return false
      continue
    }

    if (row.length !== 1) return false
    const input = row[0]
    if (input.sourceIndex !== outputIndex || Math.abs(input.gain - 1) > 1e-6) {
      return false
    }
  }

  return true
}
