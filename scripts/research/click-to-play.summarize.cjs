const fs = require('node:fs')
const path = require('node:path')
const directory = process.argv[2]
const results = fs.readdirSync(directory).filter((name) => name.endsWith('.result.json')).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name))))
const groups = new Map()
for (const result of results) {
  const key = `${result.config.build}/${result.config.name}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(...result.samples)
}
const quantile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  if (fraction === 0.5 && sorted.length % 2 === 0) return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}
const metrics = {
  scheduled: (s) => s.attempt?.commandToScheduledPlayMs,
  controlled: (s) => s.controlledLoadMs,
  loadingState: (s) => s.loadingStateMs,
  feedbackFrame: (s) => s.feedbackFrameMs,
  queuePreparation: (s) => s.attempt?.queuePreparationMs,
  contextInit: (s) => s.attempt?.audioContextInitMs,
  preflight: (s) => s.attempt?.localFilePreflightMs,
  probe: (s) => s.attempt?.probeMs,
  decode: (s) => s.attempt?.ffmpegMs,
  loudnessWait: (s) => s.attempt?.loudnessMs,
  loudnessRequest: (s) => s.loudnessRequests?.[0]?.durationMs,
  bufferAllocation: (s) => s.attempt?.webAudioBufferAllocationMs,
  deinterleave: (s) => s.attempt?.pcmDeinterleaveMs,
  pipeline: (s) => s.attempt?.standardLoadPipelineMs,
  supersededWait: (s) => s.attempt?.supersededLoadWaitMs
}
const summary = Object.fromEntries([...groups].map(([key, samples]) => [key, {
  coldCount: samples.filter((sample) => sample.kind === 'cold').length,
  warmCount: samples.filter((sample) => sample.kind === 'warm').length,
  sources: [...new Set(samples.map((sample) => sample.attempt?.loudnessSource))],
  metrics: Object.fromEntries(Object.entries(metrics).map(([name, select]) => {
    const cold = samples.filter((sample) => sample.kind === 'cold').map(select).filter(Number.isFinite)
    const warm = samples.filter((sample) => sample.kind === 'warm').map(select).filter(Number.isFinite)
    return [name, { cold, coldMedian: quantile(cold, 0.5), warmMedian: quantile(warm, 0.5), warmP95: quantile(warm, 0.95) }]
  }))
}]))
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
