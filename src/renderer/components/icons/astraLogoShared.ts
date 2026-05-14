export const ASTRA_LOGO_VIEWBOX = '0 0 1024 1024'
export const ASTRA_LOGO_EXPORT_SIZE = 1024

export const ASTRA_LOGO_BG_TRANSFORM = 'matrix(0.784074,0,0,0.973384,-34.499234,-27.254753)'
export const ASTRA_LOGO_BG_PATH = 'M1286.23,28C1321.449,28 1350,50.998 1350,79.367L1350,1028.633C1350,1057.002 1321.449,1080 1286.23,1080L107.77,1080C72.551,1080 44,1057.002 44,1028.633L44,79.367C44,50.998 72.551,28 107.77,28L1286.23,28Z'

export const ASTRA_LOGO_SHADOW_TRANSFORM = 'matrix(1.726813,0,0,1.726813,-608.701518,-379.851382)'
export const ASTRA_LOGO_SHADOW_LEFT_TRANSFORM = 'matrix(1,0,0,1,-10,3)'
export const ASTRA_LOGO_SHADOW_RIGHT_TRANSFORM = 'matrix(1,0,0,1,0,3)'

export const ASTRA_LOGO_MAIN_TRANSFORM = 'matrix(1.726813,0,0,1.726813,-660.505902,-397.11951)'

export const ASTRA_LOGO_LEFT_PATH = 'M526.083,500.65C529.86,496.662 535.112,494.402 540.605,494.402C553.071,494.402 576.056,494.402 588.831,494.402C594.652,494.402 600.185,496.939 603.984,501.35C610.054,508.396 619.61,519.49 627.207,528.31C633.905,536.085 633.631,547.668 626.573,555.117C603.295,579.689 553.937,631.788 536.916,649.755C533.139,653.742 527.889,656 522.397,656L452,656C440.954,656 432,647.046 432,636C432,626.32 432,615.247 432,607.967C432,602.851 433.96,597.93 437.478,594.215C454.783,575.942 508.184,519.551 526.083,500.65Z'
export const ASTRA_LOGO_RIGHT_PATH = 'M580,389.237C580,378.578 588.641,369.937 599.3,369.937C625.097,369.937 669.782,369.937 688.899,369.937C694.682,369.937 700.183,372.436 703.987,376.792C736.676,414.222 893.163,593.401 921.571,625.929C924.427,629.198 926,633.392 926,637.733C926,637.733 926,637.734 926,637.734C926,648.379 917.371,657.008 906.726,657.008L817.1,657.008C811.318,657.008 805.817,654.51 802.013,650.155C769.332,612.742 612.909,433.673 584.448,401.092C581.58,397.809 580,393.598 580,389.239C580,389.238 580,389.237 580,389.237Z'

export const ASTRA_LOGO_MAIN_FILL_CSS = 'hsl(var(--accent-h) 100% 50%)'
export const ASTRA_LOGO_SHADOW_FILL_CSS = 'hsl(var(--accent-h) 40% 14%)'
export const ASTRA_LOGO_BACKGROUND_FILL = '#05070a'
export const ASTRA_APP_ICON_SYMBOL_SCALE = 0.9
export const ASTRA_APP_ICON_SQUIRCLE_INSET_RATIO = 64 / 1024
export const ASTRA_APP_ICON_SQUIRCLE_RADIUS_RATIO = 0.22

export interface AstraLogoSvgMarkupOptions {
  includeBackground?: boolean
  mainFill: string
  shadowFill: string
  backgroundFill?: string
  symbolScale?: number
}

interface AstraLogoPngRenderOptions extends AstraLogoSvgMarkupOptions {
  backgroundMode?: 'svg' | 'squircle'
  squircleInsetRatio?: number
  squircleRadiusRatio?: number
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function buildAstraLogoSvgMarkup(options: AstraLogoSvgMarkupOptions): string {
  const includeBackground = options.includeBackground ?? true
  const mainFill = escapeXmlAttribute(options.mainFill)
  const shadowFill = escapeXmlAttribute(options.shadowFill)
  const backgroundFill = escapeXmlAttribute(options.backgroundFill ?? ASTRA_LOGO_BACKGROUND_FILL)
  const symbolScale = Number.isFinite(options.symbolScale ?? 1)
    ? Math.max(0.2, Math.min(3, options.symbolScale ?? 1))
    : 1
  const symbolTransform = symbolScale === 1
    ? ''
    : ` transform="translate(512 512) scale(${symbolScale}) translate(-512 -512)"`

  const backgroundLayer = includeBackground
    ? `
  <g id="bg" transform="${ASTRA_LOGO_BG_TRANSFORM}">
    <path d="${ASTRA_LOGO_BG_PATH}" fill="${backgroundFill}" />
  </g>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ASTRA_LOGO_EXPORT_SIZE}" height="${ASTRA_LOGO_EXPORT_SIZE}" viewBox="${ASTRA_LOGO_VIEWBOX}" fill="none">${backgroundLayer}
  <g id="symbol"${symbolTransform}>
  <g id="shadow" transform="${ASTRA_LOGO_SHADOW_TRANSFORM}">
    <g transform="${ASTRA_LOGO_SHADOW_LEFT_TRANSFORM}">
      <path d="${ASTRA_LOGO_LEFT_PATH}" fill="${shadowFill}" />
    </g>
    <g transform="${ASTRA_LOGO_SHADOW_RIGHT_TRANSFORM}">
      <path d="${ASTRA_LOGO_RIGHT_PATH}" fill="${shadowFill}" />
    </g>
  </g>
  <g id="main" transform="${ASTRA_LOGO_MAIN_TRANSFORM}">
    <path d="${ASTRA_LOGO_LEFT_PATH}" fill="${mainFill}" />
    <path d="${ASTRA_LOGO_RIGHT_PATH}" fill="${mainFill}" />
  </g>
</g>
</svg>`
}

export function createAstraLogoSvgDataUrl(options: AstraLogoSvgMarkupOptions): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildAstraLogoSvgMarkup(options))}`
}

export async function renderAstraLogoPngDataUrl(
  options: AstraLogoPngRenderOptions,
  size = ASTRA_LOGO_EXPORT_SIZE
): Promise<string | null> {
  const dimension = Math.max(16, Math.min(2048, Math.round(size)))
  const backgroundMode = options.backgroundMode ?? 'svg'
  const squircleInsetRatio = Math.max(0, Math.min(0.2, options.squircleInsetRatio ?? ASTRA_APP_ICON_SQUIRCLE_INSET_RATIO))
  const squircleRadiusRatio = Math.max(0.1, Math.min(0.45, options.squircleRadiusRatio ?? ASTRA_APP_ICON_SQUIRCLE_RADIUS_RATIO))
  const svgOptions: AstraLogoSvgMarkupOptions = {
    ...options,
    includeBackground: backgroundMode === 'svg' ? (options.includeBackground ?? true) : false,
  }
  const backgroundColor = options.backgroundFill ?? ASTRA_LOGO_BACKGROUND_FILL
  const svgDataUrl = createAstraLogoSvgDataUrl(svgOptions)

  return new Promise((resolve) => {
    const image = new Image()
    image.decoding = 'sync'
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = dimension
      canvas.height = dimension

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(null)
        return
      }

      ctx.clearRect(0, 0, dimension, dimension)
      if (backgroundMode === 'squircle') {
        const inset = Math.round(dimension * squircleInsetRatio)
        const squircleSize = Math.max(1, dimension - (inset * 2))
        const radius = Math.round(squircleSize * squircleRadiusRatio)
        drawRoundedRectPath(ctx, inset, inset, squircleSize, squircleSize, radius)
        ctx.fillStyle = backgroundColor
        ctx.fill()
        ctx.save()
        drawRoundedRectPath(ctx, inset, inset, squircleSize, squircleSize, radius)
        ctx.clip()
        ctx.drawImage(image, 0, 0, dimension, dimension)
        ctx.restore()
        resolve(canvas.toDataURL('image/png'))
        return
      }

      ctx.drawImage(image, 0, 0, dimension, dimension)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => resolve(null)
    image.src = svgDataUrl
  })
}
