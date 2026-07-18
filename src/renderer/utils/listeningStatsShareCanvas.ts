import type { ListeningStatsShareItem, ListeningStatsShareModel } from './listeningStatsShare'

export const LISTENING_STATS_SHARE_WIDTH = 1474
export const LISTENING_STATS_SHARE_HEIGHT = 1920

export interface ListeningStatsShareCanvasAssets {
  accentColor: string
  artworkByHash: ReadonlyMap<string, HTMLImageElement>
  astraLogo: HTMLImageElement | null
  astraWordmark: HTMLImageElement | null
}

const BACKGROUND = '#0f0f10'
const TEXT = '#f5f5f6'
const TEXT_SECONDARY = '#c5c5ca'
const CENTER_X = LISTENING_STATS_SHARE_WIDTH / 2
const FRAME_LEFT = 64
const FRAME_RIGHT = 1410
const CONTENT_LEFT = 120
const CONTENT_RIGHT = 1354
const HERO_X = 437
const HERO_Y = 190
const HERO_SIZE = 600

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
  family = 'Inter, sans-serif'
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

function formatItemMetric(item: ListeningStatsShareItem, model: ListeningStatsShareModel): string {
  if (model.rankingMetric === 'plays') {
    const plays = Math.max(0, Math.round(item.qualifiedPlays))
    return `${plays.toLocaleString('en-US')} ${plays === 1 ? 'PLAY' : 'PLAYS'}`
  }
  const minutes = Math.floor(Math.max(0, item.listenedSeconds) / 60)
  if (minutes < 1) return '<1 MIN'
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) return `${minutes} MIN`
  return remainder === 0 ? `${hours} HR` : `${hours} HR ${remainder} MIN`
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

function drawBackground(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  context.fillStyle = BACKGROUND
  context.fillRect(0, 0, LISTENING_STATS_SHARE_WIDTH, LISTENING_STATS_SHARE_HEIGHT)

  const artwork = heroArtwork(model, assets)
  if (artwork) {
    context.save()
    context.globalAlpha = 0.24
    context.filter = 'blur(164px) saturate(1.35)'
    drawImageCover(context, artwork, 120, -235, 1234, 1234)
    context.restore()
  }

  const verticalVeil = context.createLinearGradient(0, 0, 0, 1200)
  verticalVeil.addColorStop(0, 'rgba(15, 15, 16, 0.4)')
  verticalVeil.addColorStop(0.5, 'rgba(15, 15, 16, 0.7)')
  verticalVeil.addColorStop(1, BACKGROUND)
  context.fillStyle = verticalVeil
  context.fillRect(0, 0, LISTENING_STATS_SHARE_WIDTH, 1200)

  const edgeVeil = context.createRadialGradient(CENTER_X, 425, 230, CENTER_X, 425, 940)
  edgeVeil.addColorStop(0, 'rgba(15, 15, 16, 0)')
  edgeVeil.addColorStop(1, 'rgba(15, 15, 16, 0.48)')
  context.fillStyle = edgeVeil
  context.fillRect(0, 0, LISTENING_STATS_SHARE_WIDTH, 1040)
}

function drawHeader(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  accentColor: string
): void {
  context.fillStyle = TEXT_SECONDARY
  context.font = '600 32px "JetBrains Mono", monospace'
  context.fillText('LISTENING STATS', FRAME_LEFT, 80)
  context.textAlign = 'right'
  context.fillText(model.rankingLabel.replace('RANKED ', ''), FRAME_RIGHT, 80)

  context.textAlign = 'center'
  context.fillStyle = accentColor
  context.font = '700 36px "JetBrains Mono", monospace'
  context.fillText(model.title, CENTER_X, 145)
  context.textAlign = 'left'
}

function drawHeroFrame(context: CanvasRenderingContext2D, drawContent: () => void): void {
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.55)'
  context.shadowBlur = 32
  context.shadowOffsetY = 16
  roundedRectPath(context, HERO_X, HERO_Y, HERO_SIZE, HERO_SIZE, 22)
  context.fillStyle = '#09090a'
  context.fill()
  context.restore()

  context.save()
  roundedRectPath(context, HERO_X, HERO_Y, HERO_SIZE, HERO_SIZE, 22)
  context.clip()
  drawContent()
  context.restore()

  roundedRectPath(context, HERO_X, HERO_Y, HERO_SIZE, HERO_SIZE, 22)
  context.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  context.lineWidth = 1
  context.stroke()
}

function drawSingleArtwork(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  drawHeroFrame(context, () => {
    drawArtworkTile(context, heroArtwork(model, assets), HERO_X, HERO_Y, HERO_SIZE, HERO_SIZE, assets)
  })
}

function drawOverviewCollage(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  const gap = 4
  const half = (HERO_SIZE - gap) / 2
  const images = model.artworkHashes.slice(0, 4).map((hash) => assets.artworkByHash.get(hash) ?? null)
  drawHeroFrame(context, () => {
    if (images.length <= 1) {
      drawArtworkTile(context, images[0] ?? null, HERO_X, HERO_Y, HERO_SIZE, HERO_SIZE, assets)
      return
    }
    if (images.length === 2) {
      drawArtworkTile(context, images[0], HERO_X, HERO_Y, half, HERO_SIZE, assets)
      drawArtworkTile(context, images[1], HERO_X + half + gap, HERO_Y, half, HERO_SIZE, assets)
      return
    }
    if (images.length === 3) {
      drawArtworkTile(context, images[0], HERO_X, HERO_Y, half, HERO_SIZE, assets)
      drawArtworkTile(context, images[1], HERO_X + half + gap, HERO_Y, half, half, assets)
      drawArtworkTile(context, images[2], HERO_X + half + gap, HERO_Y + half + gap, half, half, assets)
      return
    }
    images.forEach((image, index) => {
      const column = index % 2
      const row = Math.floor(index / 2)
      drawArtworkTile(
        context,
        image,
        HERO_X + column * (half + gap),
        HERO_Y + row * (half + gap),
        half,
        half,
        assets
      )
    })
  })
}

function drawHeroCopy(context: CanvasRenderingContext2D, model: ListeningStatsShareModel): void {
  const title = model.hero?.title ?? 'YOUR TOP PICKS'
  const subtitle = model.hero?.subtitle ?? 'TRACK • ALBUM • ARTIST'

  context.textAlign = 'center'
  context.fillStyle = TEXT
  setFittedFont(context, title, 1180, 700, 56, 36)
  context.fillText(fitText(context, title, 1180), CENTER_X, 878)

  context.fillStyle = TEXT_SECONDARY
  setFittedFont(context, subtitle, 1120, 500, 34, 26)
  context.fillText(fitText(context, subtitle, 1120), CENTER_X, 936)
  context.textAlign = 'left'
}

function drawPersonality(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  accentColor: string
): void {
  if (!model.personalityText) return
  const value = model.personalityValue
  const sentence = model.personalityText
  const gap = 18
  let size = 40
  let valueWidth = 0
  let sentenceWidth = 0
  while (size >= 28) {
    context.font = `650 ${size}px Inter, sans-serif`
    valueWidth = context.measureText(value).width
    context.font = `500 ${size}px Inter, sans-serif`
    sentenceWidth = context.measureText(sentence).width
    if (valueWidth + gap + sentenceWidth <= 1220) break
    size -= 1
  }

  context.font = `650 ${size}px Inter, sans-serif`
  valueWidth = context.measureText(value).width
  context.font = `500 ${size}px Inter, sans-serif`
  const fittedSentence = fitText(context, sentence, 1220 - valueWidth - gap)
  sentenceWidth = context.measureText(fittedSentence).width
  let x = CENTER_X - (valueWidth + gap + sentenceWidth) / 2

  context.fillStyle = accentColor
  context.font = `650 ${size}px Inter, sans-serif`
  context.fillText(value, x, 1042)
  x += valueWidth + gap
  context.fillStyle = TEXT
  context.font = `500 ${size}px Inter, sans-serif`
  context.fillText(fittedSentence, x, 1042)
}

function drawSummary(context: CanvasRenderingContext2D, model: ListeningStatsShareModel): void {
  const centers = [240, 737, 1234]
  model.summaryStats.forEach((stat, index) => {
    context.textAlign = 'center'
    context.fillStyle = TEXT
    setFittedFont(context, stat.value, 330, 600, 48, 35)
    context.fillText(stat.value, centers[index], 1178)
    context.fillStyle = TEXT_SECONDARY
    context.font = '600 27px "JetBrains Mono", monospace'
    context.fillText(stat.label, centers[index], 1232)
  })
  context.textAlign = 'left'
}

function drawRankedItems(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  const isOverview = model.lens === 'overview'
  const items = isOverview ? model.overviewItems.slice(0, 3) : model.secondaryItems.slice(0, 3)
  if (items.length === 0) return

  const heading = isOverview
    ? 'YOUR TOP PICKS'
    : `NEXT ${model.lens === 'track' ? 'TRACKS' : 'ALBUMS'}`
  context.fillStyle = assets.accentColor
  context.font = '700 27px "JetBrains Mono", monospace'
  context.fillText(heading, CONTENT_LEFT, 1395)
  context.textAlign = 'right'
  context.fillStyle = TEXT_SECONDARY
  context.fillText(model.rankingLabel, CONTENT_RIGHT, 1395)
  context.textAlign = 'left'

  items.forEach((item, index) => {
    const rowTops = [1448, 1563, 1678]
    const titleBaselines = [1490, 1605, 1720]
    const metadataBaselines = [1528, 1643, 1758]
    const y = rowTops[index]
    const image = artworkForItem(item, assets)

    context.textAlign = 'center'
    context.fillStyle = TEXT_SECONDARY
    context.font = isOverview
      ? '600 17px "JetBrains Mono", monospace'
      : '500 27px "JetBrains Mono", monospace'
    context.fillText(isOverview ? item.kind.toUpperCase() : String(item.rank).padStart(2, '0'), 133, y + 55)
    context.textAlign = 'left'

    context.save()
    roundedRectPath(context, 226, y, 92, 92, 4)
    context.clip()
    drawArtworkTile(context, image, 226, y, 92, 92, assets)
    context.restore()

    context.fillStyle = TEXT
    context.font = '600 42px Inter, sans-serif'
    context.fillText(fitText(context, item.title, 740), 356, titleBaselines[index])
    context.fillStyle = TEXT_SECONDARY
    context.font = '500 27px Inter, sans-serif'
    context.fillText(fitText(context, item.subtitle, 740), 356, metadataBaselines[index])

    context.textAlign = 'right'
    context.fillStyle = TEXT_SECONDARY
    context.font = '500 28px "JetBrains Mono", monospace'
    context.fillText(formatItemMetric(item, model), CONTENT_RIGHT, y + 55)
    context.textAlign = 'left'
  })
}

function drawFooter(
  context: CanvasRenderingContext2D,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  const baseline = 1880
  context.fillStyle = TEXT_SECONDARY
  context.font = '600 24px "JetBrains Mono", monospace'
  context.fillText(model.rangeLabel, FRAME_LEFT, baseline)

  const wordmarkWidth = 190
  const wordmarkHeight = 24
  const logoSize = 46
  const wordmarkX = 1256
  const logoX = 1191
  const label = 'LISTENED LOCALLY WITH'
  context.font = '600 24px "JetBrains Mono", monospace'
  context.textAlign = 'right'
  context.fillText(label, logoX - 16, baseline)
  context.textAlign = 'left'
  if (assets.astraLogo) context.drawImage(assets.astraLogo, logoX, 1846, logoSize, logoSize)
  if (assets.astraWordmark) {
    context.save()
    context.globalAlpha = 0.84
    context.drawImage(assets.astraWordmark, wordmarkX, 1859, wordmarkWidth, wordmarkHeight)
    context.restore()
  }
}

export function renderListeningStatsShareCard(
  canvas: HTMLCanvasElement,
  model: ListeningStatsShareModel,
  assets: ListeningStatsShareCanvasAssets
): void {
  canvas.width = LISTENING_STATS_SHARE_WIDTH
  canvas.height = LISTENING_STATS_SHARE_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas rendering is unavailable.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.textBaseline = 'alphabetic'

  drawBackground(context, model, assets)
  drawHeader(context, model, assets.accentColor)
  if (model.lens === 'overview') drawOverviewCollage(context, model, assets)
  else drawSingleArtwork(context, model, assets)
  drawHeroCopy(context, model)
  drawPersonality(context, model, assets.accentColor)
  drawSummary(context, model)
  drawRankedItems(context, model, assets)
  drawFooter(context, model, assets)
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
