export interface StaticNormalizationGainOptions {
  targetLufs: number
  loudnessLufs: number
  peakLinear: number
  minGainDb: number
  maxGainDb: number
  peakCeilingLinear: number
}

export interface StaticNormalizationGain {
  gainDb: number
  linearGain: number
  peakLimited: boolean
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
function linearToDb(value: number): number { return 20 * Math.log10(Math.max(value, 1e-10)) }
function dbToLinear(value: number): number { return Math.pow(10, value / 20) }

export function resolveStaticNormalizationGain(
  options: StaticNormalizationGainOptions
): StaticNormalizationGain {
  if (!Number.isFinite(options.loudnessLufs)) {
    return {
      gainDb: 0,
      linearGain: 1,
      peakLimited: false
    }
  }

  const loudnessGainDb = options.targetLufs - options.loudnessLufs
  let gainDb = clamp(loudnessGainDb, options.minGainDb, options.maxGainDb)
  let peakLimited = false

  if (
    Number.isFinite(options.peakLinear)
    && options.peakLinear > 0
    && Number.isFinite(options.peakCeilingLinear)
    && options.peakCeilingLinear > 0
  ) {
    const peakSafeGainDb = linearToDb(options.peakCeilingLinear / options.peakLinear)
    if (gainDb > peakSafeGainDb) {
      gainDb = Math.max(options.minGainDb, peakSafeGainDb)
      peakLimited = true
    }
  }

  return {
    gainDb,
    linearGain: dbToLinear(gainDb),
    peakLimited
  }
}

