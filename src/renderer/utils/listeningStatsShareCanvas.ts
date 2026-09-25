import type { ListeningStatsShareItem, ListeningStatsShareModel } from './listeningStatsShare'

/** Logical layout size (9:16 story). The canvas backing store is SCALE× this. */
export const LISTENING_STATS_SHARE_WIDTH = 1080
export const LISTENING_STATS_SHARE_HEIGHT = 1920
export const LISTENING_STATS_SHARE_SCALE = 1

export interface ListeningStatsShareCanvasAssets {
  accentColor: string
  /** Dominant artwork colour used to tint the background; null keeps it neutral. */
  tintColor: string | null
  artworkByHash: ReadonlyMap<string, HTMLImageElement>
  astraLogo: HTMLImageElement | null
  astraWordmark: HTMLImageElement | null
}

export const LISTENING_STATS_SHARE_BACKGROUND = '#0c0c0e'

const TEXT = '#f5f5f6'
const TEXT_SECONDARY = 'rgba(245, 245, 246, 0.7)'
const TEXT_TERTIARY = 'rgba(245, 245, 246, 0.5)'
const RULE = 'rgba(245, 245, 246, 0.14)'
const MONO = '"JetBrains Mono", monospace'
const SANS = 'Inter, sans-serif'
const LABEL_TRACKING = '0.08em'

// Grid: one margin, one content column. Everything aligns to LEFT or RIGHT.
const LEFT = 72
const RIGHT = LISTENING_STATS_SHARE_WIDTH - 72
const CONTENT_WIDTH = RIGHT - LEFT

const HEADER_BASELINE = 100
const HEADER_RULE_Y = 132
const SECTION_BASELINE = 196
const ART_TOP = 228
const ART_SIZE = 480
const ART_BOTTOM = ART_TOP + ART_SIZE
const READOUT_LEFT = LEFT + ART_SIZE + 40
const READOUT_WIDTH = RIGHT - READOUT_LEFT
const READOUT_ROW_HEIGHT = 72
const TITLE_BASELINE = ART_BOTTOM + 92
const TITLE_LINE_HEIGHT = 80
const LIST_HEADING_OFFSET = 52
const LIST_ROWS_OFFSET = 80
const LIST_ROW_HEIGHT = 116
const LIST_THUMB = 80
const LIST_RANK_WIDTH = 64
const LIST_METER_WIDTH = 150
const PERIOD_RULE_Y = 1404
const PERIOD_HEADING_BASELINE = 1452
const PERIOD_VALUE_BASELINE = 1524
const PERIOD_LABEL_BASELINE = 1566
const ACTIVITY_BOTTOM = 1704
const ACTIVITY_DATE_BASELINE = 1746
const FOOTER_RULE_Y = 1784
const FOOTER_BASELINE = 1846

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.quadraticCurveTo(x + width, y, x + width, y + r)
  context.lineTo(x + width, y + height - r)
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  context.lineTo(x + r, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  if (sourceWidth <= 0 || sourceHeight <= 0) return
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const cropWidth = width / scale
  const cropHeight = height / scale
  context.drawImage(
    image,
    (sourceWidth - cropWidth) / 2,
    (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    x,
    y,
    width,
    height
  )
}

function fitText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  const normalized = value.trim() || 'Unknown'
  if (context.measureText(normalized).width <= maxWidth) return normalized
  let low = 0
  let high = normalized.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (context.measureText(`${normalized.slice(0, middle).trimEnd()}…`).width <= maxWidth) low = middle
    else high = middle - 1
  }
  return `${normalized.slice(0, low).trimEnd()}…`
}

function setFittedFont(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
  weight: number,
  initialSize: number,
  minimumSize: number,
  family = SANS
): number {
  let size = initialSize
  while (size > minimumSize) {
    context.font = `${weight} ${size}px ${family}`
    if (context.measureText(value).width <= maxWidth) return size
    size -= 1
  }
  context.font = `${weight} ${minimumSize}px ${family}`
  return minimumSize
}

/**
 * Greedy line wrap. Breaks on spaces, and falls back to per-character breaks for
 * words wider than the line (unspaced CJK titles). When the text needs more than
 * `maxLines`, the last line is ellipsized and `overflowed` is set.
 */
function wrapText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
  maxLines: number
): { lines: string[]; overflowed: boolean } {
  const normalized = value.trim().replace(/\s+/g, ' ') || 'Unknown'
  const tokens = normalized.split(/( )/).flatMap((token) =>
    context.measureText(token).width > maxWidth ? [...token] : [token]
  )
  const lines: string[] = []
  let current = ''
  let index = 0
  for (; index < tokens.length; index++) {
    const candidate = current + tokens[index]
    if (current.trim() && context.measureText(candidate.trimEnd()).width > maxWidth) {
      lines.push(current.trimEnd())
      if (lines.length === maxLines) break
      current = tokens[index].trimStart()
    } else {
      current = candidate
    }
  }
  if (lines.length < maxLines) {
    if (current.trim()) lines.push(current.trim())
    return { lines, overflowed: false }
  }
  const separator = tokens[index - 1] === ' ' ? ' ' : ''
  const rest = tokens.slice(index).join('').trimStart()
  lines[maxLines - 1] = fitText(context, `${lines[maxLines - 1]}${separator}${rest}`, maxWidth)
  return { lines, overflowed: true }
}

function withLabelFont(context: CanvasRenderingContext2D, size: number, weight = 600): void {
  context.font = `${weight} ${size}px ${MONO}`
  context.letterSpacing = LABEL_TRACKING
}

function resetTracking(context: CanvasRenderingContext2D): void {
  context.letterSpacing = '0px'
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function mixHex(base: string, other: string | null, amount: number): string {
  const a = hexToRgb(base)
  const b = other ? hexToRgb(other) : null
  if (!a || !b) return base
  const mixed = a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount))
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`
}

function withAlpha(color: string, alpha: number): string {
  const rgb = hexToRgb(color)
  if (rgb) return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
  const channels = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color)
  return channels ? `rgba(${channels[1]}, ${channels[2]}, ${channels[3]}, ${alpha})` : color
}

function formatItemMetric(item: ListeningStatsShareItem, model: ListeningStatsShareModel): string {
  if (model.rankingMetric === 'plays') {
    return Math.max(0, Math.round(item.qualifiedPlays)).toLocaleString('en-US')
  }
  const minutes = Math.floor(Math.max(0, item.listenedSeconds) / 60)
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) return `${minutes}m`
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

function itemMetricValue(item: ListeningStatsShareItem, model: ListeningStatsShareModel): number {
  return Math.max(0, model.rankingMetric === 'plays' ? item.qualifiedPlays : item.listenedSeconds)
}

function artworkForItem(
  item: ListeningStatsShareItem | null | undefined,
  assets: ListeningStatsShareCanvasAssets
): HTMLImageElement | null {
  return item?.artworkHash ? assets.artworkByHash.get(item.artworkHash) ?? null : null
}

function heroArtwork(
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): HTMLImageElement | null {
  const hero = artworkForItem(model.hero, assets)
  if (hero) return hero
  const hash = model.artworkHashes[0]
  return hash ? assets.artworkByHash.get(hash) ?? null : null
}

function drawPlaceholder(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  assets: ListeningStatsShareCanvasAssets
): void {
  const gradient = context.createLinearGradient(x, y, x + width, y + height)
  gradient.addColorStop(0, '#24252a')
  gradient.addColorStop(1, '#121316')
  context.fillStyle = gradient
  context.fillRect(x, y, width, height)
  if (!assets.astraLogo) return
  const size = Math.min(width, height) * 0.28
  context.save()
  context.globalAlpha = 0.72
  context.drawImage(assets.astraLogo, x + (width - size) / 2, y + (height - size) / 2, size, size)
  context.restore()
}

function drawArtworkTile(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  x: number,
  y: number,
  width: number,
  height: number,
  assets: ListeningStatsShareCanvasAssets
): void {
  if (image) drawImageCover(context, image, x, y, width, height)
  else drawPlaceholder(context, x, y, width, height, assets)
}

function drawRule(context: CanvasRenderingContext2D, y: number, left = LEFT, right = RIGHT): void {
  context.fillStyle = RULE
  context.fillRect(left, y, right - left, 1)
}

function drawBackground(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  const base = mixHex(LISTENING_STATS_SHARE_BACKGROUND, assets.tintColor, 0.1)
  context.fillStyle = base
  context.fillRect(0, 0, LISTENING_STATS_SHARE_WIDTH, LISTENING_STATS_SHARE_HEIGHT)

  const artwork = heroArtwork(model, assets)
  if (artwork) {
    context.save()
    context.globalAlpha = 0.5
    context.filter = 'blur(120px) saturate(1.3)'
    drawImageCover(context, artwork, -120, -260, 1320, 1320)
    context.restore()
  }

  // Let the art glow through behind the hero, then settle into the tinted base
  // well before the list so small text always sits on a calm, even field.
  const fade = context.createLinearGradient(0, 0, 0, 1180)
  fade.addColorStop(0, withAlpha(base, 0.45))
  fade.addColorStop(0.55, withAlpha(base, 0.72))
  fade.addColorStop(1, base)
  context.fillStyle = fade
  context.fillRect(0, 0, LISTENING_STATS_SHARE_WIDTH, 1180)
  context.fillStyle = base
  context.fillRect(0, 1180, LISTENING_STATS_SHARE_WIDTH, LISTENING_STATS_SHARE_HEIGHT - 1180)
}

function drawHeader(context: CanvasRenderingContext2D, model: ListeningStatsShareModel): void {
  context.fillStyle = TEXT_SECONDARY
  withLabelFont(context, 26)
  context.fillText(`LISTENING REPORT · ${model.rangeTag}`, LEFT, HEADER_BASELINE)
  context.textAlign = 'right'
  context.fillStyle = TEXT_TERTIARY
  context.fillText(fitText(context, model.rangeLabel, CONTENT_WIDTH * 0.46), RIGHT, HEADER_BASELINE)
  context.textAlign = 'left'
  resetTracking(context)

  // Instrument-style scale: a hairline with minor ticks and a major tick every sixth.
  drawRule(context, HEADER_RULE_Y)
  const ticks = 24
  for (let index = 0; index <= ticks; index++) {
    const x = Math.round(LEFT + (CONTENT_WIDTH * index) / ticks)
    const major = index % 6 === 0
    context.fillStyle = major ? 'rgba(245, 245, 246, 0.32)' : RULE
    context.fillRect(Math.min(x, RIGHT - 1), HEADER_RULE_Y, 1, major ? 14 : 7)
  }
}

function drawSectionLabel(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  accentColor: string
): void {
  withLabelFont(context, 26, 700)
  context.fillStyle = accentColor
  context.fillText(model.lens === 'overview' ? 'OVERVIEW' : `01 / ${model.title}`, LEFT, SECTION_BASELINE)
  context.textAlign = 'right'
  context.fillStyle = TEXT_TERTIARY
  context.fillText(model.rankingLabel, RIGHT, SECTION_BASELINE)
  context.textAlign = 'left'
  resetTracking(context)
}

function drawHeroFrame(context: CanvasRenderingContext2D, drawContent: () => void): void {
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.5)'
  context.shadowBlur = 40
  context.shadowOffsetY = 18
  roundedRectPath(context, LEFT, ART_TOP, ART_SIZE, ART_SIZE, 12)
  context.fillStyle = '#09090a'
  context.fill()
  context.restore()

  context.save()
  roundedRectPath(context, LEFT, ART_TOP, ART_SIZE, ART_SIZE, 12)
  context.clip()
  drawContent()
  context.restore()

  roundedRectPath(context, LEFT, ART_TOP, ART_SIZE, ART_SIZE, 12)
  context.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  context.lineWidth = 1
  context.stroke()
}

function drawHeroArt(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  if (model.lens !== 'overview') {
    drawHeroFrame(context, () => {
      drawArtworkTile(context, heroArtwork(model, assets), LEFT, ART_TOP, ART_SIZE, ART_SIZE, assets)
    })
    return
  }

  const gap = 4
  const half = (ART_SIZE - gap) / 2
  const images = model.artworkHashes.slice(0, 4).map((hash) => assets.artworkByHash.get(hash) ?? null)
  drawHeroFrame(context, () => {
    if (images.length <= 1) {
      drawArtworkTile(context, images[0] ?? null, LEFT, ART_TOP, ART_SIZE, ART_SIZE, assets)
      return
    }
    if (images.length === 2) {
      drawArtworkTile(context, images[0], LEFT, ART_TOP, half, ART_SIZE, assets)
      drawArtworkTile(context, images[1], LEFT + half + gap, ART_TOP, half, ART_SIZE, assets)
      return
    }
    if (images.length === 3) {
      drawArtworkTile(context, images[0], LEFT, ART_TOP, half, ART_SIZE, assets)
      drawArtworkTile(context, images[1], LEFT + half + gap, ART_TOP, half, half, assets)
      drawArtworkTile(context, images[2], LEFT + half + gap, ART_TOP + half + gap, half, half, assets)
      return
    }
    images.forEach((image, index) => {
      const column = index % 2
      const row = Math.floor(index / 2)
      drawArtworkTile(context, image, LEFT + column * (half + gap), ART_TOP + row * (half + gap), half, half, assets)
    })
  })
}

function drawHeroReadout(context: CanvasRenderingContext2D, model: ListeningStatsShareModel): void {
  // Number first, unit label under it ("17 / PLAYS"), centred in the space
  // between the artwork's top edge and the readout rows so neither side of it
  // is left with a dead gap.
  const rowsTop = ART_BOTTOM - model.heroReadouts.length * READOUT_ROW_HEIGHT
  const size = setFittedFont(context, model.heroStat.value, READOUT_WIDTH, 600, 176, 72, MONO)
  const capHeight = size * 0.73
  const labelDrop = 50
  const spare = Math.max(0, rowsTop - ART_TOP - capHeight - labelDrop)
  const numberBaseline = ART_TOP + spare / 2 + capHeight
  context.fillStyle = TEXT
  context.letterSpacing = '-0.04em'
  context.fillText(model.heroStat.value, READOUT_LEFT - size * 0.04, numberBaseline)
  resetTracking(context)

  withLabelFont(context, 26)
  context.fillStyle = TEXT_TERTIARY
  context.fillText(model.heroStat.label, READOUT_LEFT, numberBaseline + labelDrop)
  resetTracking(context)

  model.heroReadouts.forEach((row, index) => {
    const top = rowsTop + index * READOUT_ROW_HEIGHT
    drawRule(context, top, READOUT_LEFT, RIGHT)
    const baseline = top + READOUT_ROW_HEIGHT / 2 + 12

    context.fillStyle = TEXT
    context.font = `600 36px ${MONO}`
    context.textAlign = 'right'
    const value = fitText(context, row.value, READOUT_WIDTH * 0.5)
    const valueWidth = context.measureText(value).width
    context.fillText(value, RIGHT, baseline)
    context.textAlign = 'left'

    withLabelFont(context, 26)
    context.fillStyle = TEXT_TERTIARY
    context.fillText(fitText(context, row.label, READOUT_WIDTH - valueWidth - 20), READOUT_LEFT, baseline)
    resetTracking(context)
  })
}

/** Draws the hero title block and returns the y where it ends. */
function drawHeroTitle(context: CanvasRenderingContext2D, model: ListeningStatsShareModel): number {
  context.fillStyle = TEXT
  let size = 72
  let lines: string[] = []
  // Prefer two lines at full size; only shrink when the title needs more than that.
  while (size >= 56) {
    context.font = `700 ${size}px ${SANS}`
    context.letterSpacing = '-0.02em'
    const wrapped = wrapText(context, model.heroTitle, CONTENT_WIDTH, 2)
    lines = wrapped.lines
    if (!wrapped.overflowed || size === 56) break
    size -= 4
  }
  lines.forEach((line, index) => {
    context.fillText(line, LEFT, TITLE_BASELINE + index * TITLE_LINE_HEIGHT)
  })
  resetTracking(context)

  const lastTitleBaseline = TITLE_BASELINE + (lines.length - 1) * TITLE_LINE_HEIGHT
  if (!model.heroSubtitle) return lastTitleBaseline + 20
  context.fillStyle = TEXT_SECONDARY
  context.font = `500 34px ${SANS}`
  const subtitleBaseline = lastTitleBaseline + 54
  context.fillText(fitText(context, model.heroSubtitle, CONTENT_WIDTH), LEFT, subtitleBaseline)
  return subtitleBaseline + 20
}

function drawRankedList(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets,
  titleBottom: number
): void {
  const isOverview = model.lens === 'overview'
  const items = (isOverview ? model.overviewItems : model.secondaryItems).slice(0, 3)
  if (items.length === 0) return

  // The title block grows with a second line; split whatever room is left evenly
  // above and below the list so a short title doesn't leave one big hole.
  const blockHeight = LIST_ROWS_OFFSET + items.length * LIST_ROW_HEIGHT
  const spare = Math.max(0, PERIOD_RULE_Y - titleBottom - blockHeight)
  const ruleY = Math.round(titleBottom + spare / 2)
  const headingBaseline = ruleY + LIST_HEADING_OFFSET
  const listTop = ruleY + LIST_ROWS_OFFSET

  drawRule(context, ruleY)
  withLabelFont(context, 26)
  context.fillStyle = TEXT_TERTIARY
  context.fillText(model.listHeading, LEFT, headingBaseline)
  context.textAlign = 'right'
  context.fillText(model.rankingMetric === 'plays' ? 'PLAYS' : 'TIME', RIGHT, headingBaseline)
  context.textAlign = 'left'
  resetTracking(context)

  // Bars are scaled against the #1 item so the gaps between ranks are visible.
  const leaderValue = Math.max(1, model.hero ? itemMetricValue(model.hero, model) : 0)
  const thumbLeft = isOverview ? LEFT : LEFT + LIST_RANK_WIDTH
  const textLeft = thumbLeft + LIST_THUMB + 28
  const textWidth = RIGHT - LIST_METER_WIDTH - 32 - textLeft

  items.forEach((item, index) => {
    const top = listTop + index * LIST_ROW_HEIGHT
    const thumbTop = top + (LIST_ROW_HEIGHT - LIST_THUMB) / 2
    const titleBaseline = top + 50
    const subtitleBaseline = top + 86

    if (!isOverview) {
      context.font = `500 28px ${MONO}`
      context.fillStyle = TEXT_TERTIARY
      context.fillText(String(item.rank).padStart(2, '0'), LEFT, titleBaseline + 12)
    }

    context.save()
    roundedRectPath(context, thumbLeft, thumbTop, LIST_THUMB, LIST_THUMB, 6)
    context.clip()
    drawArtworkTile(context, artworkForItem(item, assets), thumbLeft, thumbTop, LIST_THUMB, LIST_THUMB, assets)
    context.restore()

    context.fillStyle = TEXT
    context.font = `600 38px ${SANS}`
    context.fillText(fitText(context, item.title, textWidth), textLeft, titleBaseline)
    context.fillStyle = TEXT_SECONDARY
    context.font = `500 28px ${SANS}`
    context.fillText(fitText(context, item.subtitle, textWidth), textLeft, subtitleBaseline)

    context.textAlign = 'right'
    context.fillStyle = TEXT
    context.font = `600 36px ${MONO}`
    context.fillText(formatItemMetric(item, model), RIGHT, titleBaseline)
    context.textAlign = 'left'

    if (isOverview) {
      withLabelFont(context, 24)
      context.textAlign = 'right'
      context.fillStyle = TEXT_TERTIARY
      context.fillText(`TOP ${item.kind.toUpperCase()}`, RIGHT, subtitleBaseline)
      context.textAlign = 'left'
      resetTracking(context)
      return
    }

    const meterTop = subtitleBaseline - 12
    const fraction = Math.min(1, itemMetricValue(item, model) / leaderValue)
    context.fillStyle = 'rgba(245, 245, 246, 0.12)'
    roundedRectPath(context, RIGHT - LIST_METER_WIDTH, meterTop, LIST_METER_WIDTH, 8, 4)
    context.fill()
    context.fillStyle = assets.accentColor
    roundedRectPath(context, RIGHT - LIST_METER_WIDTH, meterTop, Math.max(8, LIST_METER_WIDTH * fraction), 8, 4)
    context.fill()
  })
}

function drawActivity(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  accentColor: string,
  top: number
): void {
  const values = model.activity
  if (values.length === 0) return
  const height = ACTIVITY_BOTTOM - top
  const peak = Math.max(...values)
  const peakIndex = model.activityPeak?.index ?? -1
  const gap = values.length > 40 ? 3 : values.length > 14 ? 6 : 12
  const barWidth = (CONTENT_WIDTH - gap * (values.length - 1)) / values.length

  values.forEach((value, index) => {
    const x = LEFT + index * (barWidth + gap)
    if (value <= 0 || peak <= 0) {
      // Silent days stay visible as baseline ticks, like an idle meter.
      context.fillStyle = RULE
      context.fillRect(x, ACTIVITY_BOTTOM - 3, barWidth, 3)
      return
    }
    const barHeight = Math.max(6, (value / peak) * height)
    context.fillStyle = index === peakIndex ? accentColor : 'rgba(245, 245, 246, 0.42)'
    roundedRectPath(context, x, ACTIVITY_BOTTOM - barHeight, barWidth, barHeight, Math.min(3, barWidth / 2))
    context.fill()
  })

  withLabelFont(context, 24)
  const edgeGap = 24
  let peakLeft = Infinity
  let peakRight = -Infinity
  if (model.activityPeak && peakIndex >= 0) {
    // Caption the highlighted bar from directly underneath: a caret at the bar's
    // centre, and the label centred on it but kept inside the grid.
    const peakCenter = LEFT + peakIndex * (barWidth + gap) + barWidth / 2
    const caretTop = ACTIVITY_BOTTOM + 8
    context.fillStyle = accentColor
    context.beginPath()
    context.moveTo(peakCenter, caretTop)
    context.lineTo(peakCenter + 8, caretTop + 10)
    context.lineTo(peakCenter - 8, caretTop + 10)
    context.closePath()
    context.fill()

    // Prefer sliding the caption between the range dates, as long as the caret
    // stays under it; only when that fails does it take over an edge date's spot.
    const labelWidth = context.measureText(model.activityPeak.label).width
    const centered = peakCenter - labelWidth / 2
    const minLeft = LEFT + context.measureText(model.activityStartLabel).width + edgeGap
    const maxLeft = RIGHT - context.measureText(model.activityEndLabel).width - edgeGap - labelWidth
    const nudged = Math.min(Math.max(centered, minLeft), maxLeft)
    const caretInside = peakCenter >= nudged + 12 && peakCenter <= nudged + labelWidth - 12
    peakLeft = minLeft <= maxLeft && caretInside
      ? nudged
      : Math.min(Math.max(LEFT, centered), RIGHT - labelWidth)
    peakRight = peakLeft + labelWidth
    context.fillText(model.activityPeak.label, peakLeft, ACTIVITY_DATE_BASELINE)
  }

  // Range dates give way when the peak caption still runs into them.
  context.fillStyle = TEXT_TERTIARY
  const startWidth = context.measureText(model.activityStartLabel).width
  if (LEFT + startWidth + edgeGap <= peakLeft) {
    context.fillText(model.activityStartLabel, LEFT, ACTIVITY_DATE_BASELINE)
  }
  const endWidth = context.measureText(model.activityEndLabel).width
  if (RIGHT - endWidth - edgeGap >= peakRight) {
    context.textAlign = 'right'
    context.fillText(model.activityEndLabel, RIGHT, ACTIVITY_DATE_BASELINE)
    context.textAlign = 'left'
  }
  resetTracking(context)
}

function drawPeriod(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  accentColor: string
): void {
  const hasStats = model.periodStats.length > 0
  if (!hasStats && model.activity.length === 0) return

  drawRule(context, PERIOD_RULE_Y)
  withLabelFont(context, 26)
  context.fillStyle = TEXT_TERTIARY
  context.fillText(hasStats ? 'ALL LISTENING' : 'ACTIVITY', LEFT, PERIOD_HEADING_BASELINE)
  resetTracking(context)

  if (!hasStats) {
    drawActivity(context, model, accentColor, PERIOD_HEADING_BASELINE + 40)
    return
  }

  // Columns are sized to their content and justified across the grid, shrinking
  // the values together until every column keeps at least MIN_GAP between them.
  const MIN_GAP = 36
  const stats = model.periodStats
  withLabelFont(context, 22)
  const labelWidths = stats.map((stat) => context.measureText(stat.label).width)
  resetTracking(context)
  let valueSize = 52
  let widths: number[] = []
  for (; valueSize >= 32; valueSize -= 2) {
    context.font = `600 ${valueSize}px ${MONO}`
    widths = stats.map((stat, index) => Math.max(context.measureText(stat.value).width, labelWidths[index]))
    const total = widths.reduce((sum, width) => sum + width, 0)
    if (total + MIN_GAP * (stats.length - 1) <= CONTENT_WIDTH) break
  }
  const gap = stats.length > 1
    ? (CONTENT_WIDTH - widths.reduce((sum, width) => sum + width, 0)) / (stats.length - 1)
    : 0
  let x = LEFT
  stats.forEach((stat, index) => {
    context.fillStyle = TEXT
    context.font = `600 ${valueSize}px ${MONO}`
    context.fillText(fitText(context, stat.value, widths[index]), x, PERIOD_VALUE_BASELINE)
    withLabelFont(context, 22)
    context.fillStyle = TEXT_TERTIARY
    context.fillText(fitText(context, stat.label, widths[index]), x, PERIOD_LABEL_BASELINE)
    resetTracking(context)
    x += widths[index] + gap
  })

  drawActivity(context, model, accentColor, PERIOD_LABEL_BASELINE + 40)
}

function drawFooter(context: CanvasRenderingContext2D, assets: ListeningStatsShareCanvasAssets): void {
  drawRule(context, FOOTER_RULE_Y)

  // Lay the brand out right-to-left from the grid edge so it can never overshoot.
  const markHeight = 20
  const logoSize = 40
  const wordmark = assets.astraWordmark
  const wordmarkWidth = wordmark
    ? markHeight * ((wordmark.naturalWidth || wordmark.width) / Math.max(1, wordmark.naturalHeight || wordmark.height))
    : 0
  const centerY = FOOTER_BASELINE - 9
  let x = RIGHT
  if (wordmark && wordmarkWidth > 0) {
    x -= wordmarkWidth
    context.save()
    context.globalAlpha = 0.86
    context.drawImage(wordmark, x, centerY - markHeight / 2, wordmarkWidth, markHeight)
    context.restore()
    x -= 18
  }
  if (assets.astraLogo) {
    x -= logoSize
    context.drawImage(assets.astraLogo, x, centerY - logoSize / 2, logoSize, logoSize)
    x -= 16
  }
  withLabelFont(context, 24)
  context.fillStyle = TEXT_TERTIARY
  context.textAlign = 'right'
  context.fillText('LISTENED LOCALLY WITH', x, FOOTER_BASELINE)
  context.textAlign = 'left'
  resetTracking(context)
}

export function renderListeningStatsShareCard(
  canvas: HTMLCanvasElement,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  canvas.width = LISTENING_STATS_SHARE_WIDTH * LISTENING_STATS_SHARE_SCALE
  canvas.height = LISTENING_STATS_SHARE_HEIGHT * LISTENING_STATS_SHARE_SCALE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas rendering is unavailable.')
  context.setTransform(LISTENING_STATS_SHARE_SCALE, 0, 0, LISTENING_STATS_SHARE_SCALE, 0, 0)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.textBaseline = 'alphabetic'

  drawBackground(context, model, assets)
  drawHeader(context, model)
  drawSectionLabel(context, model, assets.accentColor)
  drawHeroArt(context, model, assets)
  drawHeroReadout(context, model)
  const titleBottom = drawHeroTitle(context, model)
  drawRankedList(context, model, assets, titleBottom)
  drawPeriod(context, model, assets.accentColor)
  drawFooter(context, assets)
}

export async function loadListeningStatsShareImage(source: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = source
  if (typeof image.decode === 'function') {
    await image.decode()
  } else {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Share-card image could not be decoded.'))
    })
  }
  return image
}

export function listeningStatsShareCanvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Share-card PNG could not be created.'))
        return
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
    }, 'image/png')
  })
}
