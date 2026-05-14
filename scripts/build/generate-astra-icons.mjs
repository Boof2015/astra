import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')
const resourcesDir = join(repoRoot, 'resources')
const tempDir = mkdtempSync(join(tmpdir(), 'astra-icons-'))
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const iconCanvasSize = 1024
const iconBackground = { r: 5, g: 7, b: 10 }
const iconBackgroundFill = '#05070a'
const iconBackgroundInsetRatio = 64 / 1024
const iconCornerRadiusRatio = 0.22
const iconSymbolScale = 0.9
const iconMainFill = '#0097ff'
const iconShadowFill = '#152632'

const astraLogoShadowTransform = 'matrix(1.726813,0,0,1.726813,-608.701518,-379.851382)'
const astraLogoShadowLeftTransform = 'matrix(1,0,0,1,-10,3)'
const astraLogoShadowRightTransform = 'matrix(1,0,0,1,0,3)'
const astraLogoMainTransform = 'matrix(1.726813,0,0,1.726813,-660.505902,-397.11951)'
const astraLogoLeftPath = 'M526.083,500.65C529.86,496.662 535.112,494.402 540.605,494.402C553.071,494.402 576.056,494.402 588.831,494.402C594.652,494.402 600.185,496.939 603.984,501.35C610.054,508.396 619.61,519.49 627.207,528.31C633.905,536.085 633.631,547.668 626.573,555.117C603.295,579.689 553.937,631.788 536.916,649.755C533.139,653.742 527.889,656 522.397,656L452,656C440.954,656 432,647.046 432,636C432,626.32 432,615.247 432,607.967C432,602.851 433.96,597.93 437.478,594.215C454.783,575.942 508.184,519.551 526.083,500.65Z'
const astraLogoRightPath = 'M580,389.237C580,378.578 588.641,369.937 599.3,369.937C625.097,369.937 669.782,369.937 688.899,369.937C694.682,369.937 700.183,372.436 703.987,376.792C736.676,414.222 893.163,593.401 921.571,625.929C924.427,629.198 926,633.392 926,637.733C926,637.733 926,637.734 926,637.734C926,648.379 917.371,657.008 906.726,657.008L817.1,657.008C811.318,657.008 805.817,654.51 802.013,650.155C769.332,612.742 612.909,433.673 584.448,401.092C581.58,397.809 580,393.598 580,389.239C580,389.238 580,389.237 580,389.237Z'

function ensureCommand(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
  } catch {
    throw new Error(`Missing required command: ${command}`)
  }
}

function resizePng(sourcePath, outputPath, size) {
  execFileSync('sips', ['-z', String(size), String(size), sourcePath, '--out', outputPath], {
    stdio: 'ignore',
  })
}

function makeCrc32Table() {
  const table = new Uint32Array(256)
  for (let i = 0; i < table.length; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
}

const crc32Table = makeCrc32Table()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readPngRgba(filePath) {
  const buffer = readFileSync(filePath)
  if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`${filePath} is not a PNG file.`)
  }

  let offset = pngSignature.length
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatChunks = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const data = buffer.subarray(dataStart, dataEnd)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data.readUInt8(8)
      colorType = data.readUInt8(9)
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`Unsupported PNG format in ${filePath}; expected 8-bit RGBA.`)
  }

  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  const inflated = inflateSync(Buffer.concat(idatChunks))
  const pixels = Buffer.alloc(width * height * bytesPerPixel)
  let inputOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset]
    inputOffset += 1
    const row = inflated.subarray(inputOffset, inputOffset + stride)
    inputOffset += stride
    const outputOffset = y * stride
    const previousOffset = (y - 1) * stride

    for (let x = 0; x < stride; x += 1) {
      const raw = row[x]
      const left = x >= bytesPerPixel ? pixels[outputOffset + x - bytesPerPixel] : 0
      const up = y > 0 ? pixels[previousOffset + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[previousOffset + x - bytesPerPixel] : 0
      let value = raw

      if (filter === 1) {
        value = raw + left
      } else if (filter === 2) {
        value = raw + up
      } else if (filter === 3) {
        value = raw + Math.floor((left + up) / 2)
      } else if (filter === 4) {
        const predictor = left + up - upLeft
        const pa = Math.abs(predictor - left)
        const pb = Math.abs(predictor - up)
        const pc = Math.abs(predictor - upLeft)
        const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        value = raw + paeth
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter} in ${filePath}.`)
      }

      pixels[outputOffset + x] = value & 0xff
    }
  }

  return { width, height, pixels }
}

function writePngRgba(filePath, width, height, pixels) {
  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  const raw = Buffer.alloc((stride + 1) * height)

  for (let y = 0; y < height; y += 1) {
    const outputOffset = y * (stride + 1)
    raw[outputOffset] = 0
    pixels.copy(raw, outputOffset + 1, y * stride, (y + 1) * stride)
  }

  function chunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii')
    const lengthBuffer = Buffer.alloc(4)
    lengthBuffer.writeUInt32BE(data.length, 0)
    const crcBuffer = Buffer.alloc(4)
    crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
    return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(6, 9)
  ihdr.writeUInt8(0, 10)
  ihdr.writeUInt8(0, 11)
  ihdr.writeUInt8(0, 12)

  writeFileSync(filePath, Buffer.concat([
    pngSignature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

function roundedRectCoverage(x, y, width, height, radius) {
  const clampedX = Math.max(radius, Math.min(width - radius, x))
  const clampedY = Math.max(radius, Math.min(height - radius, y))
  const dx = x - clampedX
  const dy = y - clampedY
  return dx * dx + dy * dy <= radius * radius ? 1 : 0
}

function antiAliasedRoundedRectCoverage(pixelX, pixelY, width, height, radius) {
  const samplesPerAxis = 4
  let covered = 0

  for (let sampleY = 0; sampleY < samplesPerAxis; sampleY += 1) {
    for (let sampleX = 0; sampleX < samplesPerAxis; sampleX += 1) {
      const x = pixelX + ((sampleX + 0.5) / samplesPerAxis)
      const y = pixelY + ((sampleY + 0.5) / samplesPerAxis)
      covered += roundedRectCoverage(x, y, width, height, radius)
    }
  }

  return covered / (samplesPerAxis * samplesPerAxis)
}

function restoreIconBackgroundAlpha(filePath) {
  const image = readPngRgba(filePath)
  const { width, height, pixels } = image
  const inset = Math.round(Math.min(width, height) * iconBackgroundInsetRatio)
  const backgroundWidth = width - (inset * 2)
  const backgroundHeight = height - (inset * 2)
  const radius = Math.min(backgroundWidth, backgroundHeight) * iconCornerRadiusRatio

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const coverage = antiAliasedRoundedRectCoverage(
        x - inset,
        y - inset,
        backgroundWidth,
        backgroundHeight,
        radius,
      )
      if (coverage >= 1) continue

      const offset = ((y * width) + x) * 4
      const alpha = Math.round(coverage * 255)
      pixels[offset] = iconBackground.r
      pixels[offset + 1] = iconBackground.g
      pixels[offset + 2] = iconBackground.b
      pixels[offset + 3] = alpha
    }
  }

  writePngRgba(filePath, width, height, pixels)
}

function writeIcoFile(outputPath, images) {
  const headerLength = 6
  const entryLength = 16
  const directoryLength = headerLength + (images.length * entryLength)
  const header = Buffer.alloc(directoryLength)

  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let imageOffset = directoryLength
  images.forEach(({ size, buffer }, index) => {
    const offset = headerLength + (index * entryLength)
    header.writeUInt8(size >= 256 ? 0 : size, offset)
    header.writeUInt8(size >= 256 ? 0 : size, offset + 1)
    header.writeUInt8(0, offset + 2)
    header.writeUInt8(0, offset + 3)
    header.writeUInt16LE(1, offset + 4)
    header.writeUInt16LE(32, offset + 6)
    header.writeUInt32LE(buffer.length, offset + 8)
    header.writeUInt32LE(imageOffset, offset + 12)
    imageOffset += buffer.length
  })

  writeFileSync(outputPath, Buffer.concat([header, ...images.map((image) => image.buffer)]))
}

try {
  ensureCommand('qlmanage')
  ensureCommand('sips')
  ensureCommand('iconutil')

  mkdirSync(resourcesDir, { recursive: true })

  const sourceSvgPath = join(tempDir, 'astra-icon-source.svg')
  const backgroundInset = iconCanvasSize * iconBackgroundInsetRatio
  const backgroundSize = iconCanvasSize - (backgroundInset * 2)
  const backgroundRadius = backgroundSize * iconCornerRadiusRatio
  const symbolTransform = `translate(${iconCanvasSize / 2} ${iconCanvasSize / 2}) scale(${iconSymbolScale}) translate(${-iconCanvasSize / 2} ${-iconCanvasSize / 2})`

  writeFileSync(sourceSvgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="${iconCanvasSize}" height="${iconCanvasSize}" viewBox="0 0 ${iconCanvasSize} ${iconCanvasSize}" fill="none">
  <rect x="${backgroundInset}" y="${backgroundInset}" width="${backgroundSize}" height="${backgroundSize}" rx="${backgroundRadius}" fill="${iconBackgroundFill}" />
  <g transform="${symbolTransform}">
    <g transform="${astraLogoShadowTransform}">
      <g transform="${astraLogoShadowLeftTransform}">
        <path d="${astraLogoLeftPath}" fill="${iconShadowFill}" />
      </g>
      <g transform="${astraLogoShadowRightTransform}">
        <path d="${astraLogoRightPath}" fill="${iconShadowFill}" />
      </g>
    </g>
    <g transform="${astraLogoMainTransform}">
      <path d="${astraLogoLeftPath}" fill="${iconMainFill}" />
      <path d="${astraLogoRightPath}" fill="${iconMainFill}" />
    </g>
  </g>
</svg>
`)

  execFileSync('qlmanage', ['-t', '-s', String(iconCanvasSize), '-o', tempDir, sourceSvgPath], {
    stdio: 'ignore',
  })

  const masterPngPath = `${sourceSvgPath}.png`
  if (!existsSync(masterPngPath)) {
    throw new Error('Quick Look did not create the source PNG.')
  }

  const resourcePngPath = join(resourcesDir, 'icon.png')
  copyFileSync(masterPngPath, resourcePngPath)
  restoreIconBackgroundAlpha(resourcePngPath)

  const iconsetDir = join(tempDir, 'Astra.iconset')
  mkdirSync(iconsetDir)
  const iconsetEntries = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]

  for (const [filename, size] of iconsetEntries) {
    resizePng(resourcePngPath, join(iconsetDir, filename), size)
  }

  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', join(resourcesDir, 'icon.icns')], {
    stdio: 'ignore',
  })

  const icoImages = []
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const outputPath = join(tempDir, `icon-${size}.png`)
    resizePng(resourcePngPath, outputPath, size)
    icoImages.push({ size, buffer: readFileSync(outputPath) })
  }
  writeIcoFile(join(resourcesDir, 'icon.ico'), icoImages)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
