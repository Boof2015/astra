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

export interface ResolveChannelMixMatrixOptions {
  sourceChannels: number
  outputChannels: number
  multichannelEnabled: boolean
  manualRoutingMap?: readonly number[] | null
  includeLfeInDownmix?: boolean
}

const CENTER_GAIN = Math.SQRT1_2
const SURROUND_GAIN = Math.SQRT1_2
const LFE_DOWNMIX_GAIN = 0.5

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
}

const STANDARD_LAYOUTS: Record<number, string[]> = {
  1: ['M'],
  2: ['FL', 'FR'],
  3: ['FL', 'FR', 'FC'],
  4: ['FL', 'FR', 'SL', 'SR'],
  5: ['FL', 'FR', 'FC', 'SL', 'SR'],
  6: ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  8: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
}

function normalizeChannelCount(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(32, Math.trunc(value)))
}

function buildFallbackChannel(index: number): SourceChannel {
  return {
    id: `CH${index + 1}`,
    label: `Channel ${index + 1}`,
    role: 'unknown',
    index,
  }
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
  includeLfeInDownmix: boolean
): ChannelMixMatrix {
  if (sourceChannels === outputChannels) {
    return buildIdentityMatrix(sourceChannels, outputChannels)
  }

  const sourceLayout = buildSourceLayout(sourceChannels)
  const outputLayout = buildSpeakerLayout(outputChannels)
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

  return buildAutomaticMatrix(sourceChannels, outputChannels, includeLfeInDownmix)
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
