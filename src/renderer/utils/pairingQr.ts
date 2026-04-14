/*
 * Adapted from Project Nayuki's QR Code generator library (TypeScript).
 * Copyright (c) Project Nayuki. Licensed under the MIT License.
 * https://www.nayuki.io/page/qr-code-generator-library
 */

type Bit = number

const textEncoder = new TextEncoder()

class QrCodeEcc {
  static readonly LOW = new QrCodeEcc(0, 1)
  static readonly MEDIUM = new QrCodeEcc(1, 0)
  static readonly QUARTILE = new QrCodeEcc(2, 3)
  static readonly HIGH = new QrCodeEcc(3, 2)

  private constructor(
    readonly ordinal: number,
    readonly formatBits: number
  ) {}
}

class QrSegmentMode {
  static readonly BYTE = new QrSegmentMode(0x4, [8, 16, 16])

  private constructor(
    readonly modeBits: number,
    private readonly numBitsCharCount: [number, number, number]
  ) {}

  numCharCountBits(version: number): number {
    return this.numBitsCharCount[Math.floor((version + 7) / 17)]
  }
}

class QrSegment {
  static makeBytes(data: ReadonlyArray<number>): QrSegment {
    const bitData: Bit[] = []
    for (const byte of data) appendBits(byte, 8, bitData)
    return new QrSegment(QrSegmentMode.BYTE, data.length, bitData)
  }

  static getTotalBits(segments: ReadonlyArray<QrSegment>, version: number): number {
    let result = 0
    for (const segment of segments) {
      const charCountBits = segment.mode.numCharCountBits(version)
      if (segment.numChars >= (1 << charCountBits)) return Number.POSITIVE_INFINITY
      result += 4 + charCountBits + segment.bitData.length
    }
    return result
  }

  private constructor(
    readonly mode: QrSegmentMode,
    readonly numChars: number,
    private readonly bitData: Bit[]
  ) {}

  getData(): Bit[] {
    return this.bitData.slice()
  }
}

class QrCode {
  static readonly MIN_VERSION = 1
  static readonly MAX_VERSION = 40
  private static readonly PENALTY_N1 = 3
  private static readonly PENALTY_N2 = 3
  private static readonly PENALTY_N3 = 40
  private static readonly PENALTY_N4 = 10
  private static readonly ECC_CODEWORDS_PER_BLOCK: number[][] = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ]
  private static readonly NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ]

  static encodeBinary(data: ReadonlyArray<number>, errorCorrectionLevel: QrCodeEcc): QrCode {
    return QrCode.encodeSegments([QrSegment.makeBytes(data)], errorCorrectionLevel)
  }

  static encodeSegments(
    segments: ReadonlyArray<QrSegment>,
    errorCorrectionLevel: QrCodeEcc,
    minVersion: number = 1,
    maxVersion: number = 40,
    mask: number = -1,
    boostEcl: boolean = true
  ): QrCode {
    if (
      minVersion < QrCode.MIN_VERSION ||
      minVersion > maxVersion ||
      maxVersion > QrCode.MAX_VERSION ||
      mask < -1 ||
      mask > 7
    ) {
      throw new RangeError('Invalid QR configuration.')
    }

    let version = minVersion
    let dataUsedBits = 0
    for (; version <= maxVersion; version += 1) {
      const dataCapacityBits = QrCode.getNumDataCodewords(version, errorCorrectionLevel) * 8
      const usedBits = QrSegment.getTotalBits(segments, version)
      if (usedBits <= dataCapacityBits) {
        dataUsedBits = usedBits
        break
      }
    }

    if (version > maxVersion) {
      throw new RangeError('Pairing URL is too long for the QR renderer.')
    }

    if (boostEcl) {
      for (const nextLevel of [QrCodeEcc.MEDIUM, QrCodeEcc.QUARTILE, QrCodeEcc.HIGH]) {
        if (dataUsedBits <= QrCode.getNumDataCodewords(version, nextLevel) * 8) {
          errorCorrectionLevel = nextLevel
        }
      }
    }

    const bitBuffer: Bit[] = []
    for (const segment of segments) {
      appendBits(segment.mode.modeBits, 4, bitBuffer)
      appendBits(segment.numChars, segment.mode.numCharCountBits(version), bitBuffer)
      for (const bit of segment.getData()) bitBuffer.push(bit)
    }

    const dataCapacityBits = QrCode.getNumDataCodewords(version, errorCorrectionLevel) * 8
    appendBits(0, Math.min(4, dataCapacityBits - bitBuffer.length), bitBuffer)
    appendBits(0, (8 - (bitBuffer.length % 8)) % 8, bitBuffer)

    for (let padByte = 0xec; bitBuffer.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
      appendBits(padByte, 8, bitBuffer)
    }

    const dataCodewords: number[] = Array.from({ length: bitBuffer.length / 8 }, () => 0)
    bitBuffer.forEach((bit, index) => {
      dataCodewords[index >>> 3] |= bit << (7 - (index & 7))
    })

    return new QrCode(version, errorCorrectionLevel, dataCodewords, mask)
  }

  readonly size: number
  readonly mask: number
  private readonly modules: boolean[][]
  private isFunction: boolean[][]

  private constructor(
    readonly version: number,
    readonly errorCorrectionLevel: QrCodeEcc,
    dataCodewords: ReadonlyArray<number>,
    requestedMask: number
  ) {
    if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION) {
      throw new RangeError('QR version out of range.')
    }
    if (requestedMask < -1 || requestedMask > 7) {
      throw new RangeError('QR mask out of range.')
    }

    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => Array.from({ length: this.size }, () => false))
    this.isFunction = Array.from({ length: this.size }, () => Array.from({ length: this.size }, () => false))

    this.drawFunctionPatterns()
    const allCodewords = this.addEccAndInterleave(dataCodewords)
    this.drawCodewords(allCodewords)

    let bestMask = requestedMask
    if (bestMask === -1) {
      let minPenalty = Number.POSITIVE_INFINITY
      for (let candidateMask = 0; candidateMask < 8; candidateMask += 1) {
        this.applyMask(candidateMask)
        this.drawFormatBits(candidateMask)
        const penalty = this.getPenaltyScore()
        if (penalty < minPenalty) {
          minPenalty = penalty
          bestMask = candidateMask
        }
        this.applyMask(candidateMask)
      }
    }

    this.mask = bestMask
    this.applyMask(this.mask)
    this.drawFormatBits(this.mask)
    this.isFunction = []
  }

  getModule(x: number, y: number): boolean {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x]
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i += 1) {
      this.setFunctionModule(6, i, i % 2 === 0)
      this.setFunctionModule(i, 6, i % 2 === 0)
    }

    this.drawFinderPattern(3, 3)
    this.drawFinderPattern(this.size - 4, 3)
    this.drawFinderPattern(3, this.size - 4)

    const alignmentPatternPositions = this.getAlignmentPatternPositions()
    const numAlign = alignmentPatternPositions.length
    for (let i = 0; i < numAlign; i += 1) {
      for (let j = 0; j < numAlign; j += 1) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === numAlign - 1) ||
          (i === numAlign - 1 && j === 0)
        ) {
          continue
        }
        this.drawAlignmentPattern(alignmentPatternPositions[i], alignmentPatternPositions[j])
      }
    }

    this.drawFormatBits(0)
    this.drawVersion()
  }

  private drawFormatBits(mask: number): void {
    const data = (this.errorCorrectionLevel.formatBits << 3) | mask
    let remainder = data
    for (let i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
    }
    const bits = ((data << 10) | remainder) ^ 0x5412

    for (let i = 0; i <= 5; i += 1) this.setFunctionModule(8, i, getBit(bits, i))
    this.setFunctionModule(8, 7, getBit(bits, 6))
    this.setFunctionModule(8, 8, getBit(bits, 7))
    this.setFunctionModule(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i += 1) this.setFunctionModule(14 - i, 8, getBit(bits, i))

    for (let i = 0; i < 8; i += 1) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i += 1) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i))
    this.setFunctionModule(8, this.size - 8, true)
  }

  private drawVersion(): void {
    if (this.version < 7) return

    let remainder = this.version
    for (let i = 0; i < 12; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    }
    const bits = (this.version << 12) | remainder

    for (let i = 0; i < 18; i += 1) {
      const color = getBit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunctionModule(a, b, color)
      this.setFunctionModule(b, a, color)
    }
  }

  private drawFinderPattern(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) {
          this.setFunctionModule(xx, yy, distance !== 2 && distance !== 4)
        }
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  private setFunctionModule(x: number, y: number, isDark: boolean): void {
    this.modules[y][x] = isDark
    this.isFunction[y][x] = true
  }

  private addEccAndInterleave(data: ReadonlyArray<number>): number[] {
    const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[this.errorCorrectionLevel.ordinal][this.version]
    const blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[this.errorCorrectionLevel.ordinal][this.version]
    const rawCodewords = Math.floor(QrCode.getNumRawDataModules(this.version) / 8)
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
    const shortBlockLen = Math.floor(rawCodewords / numBlocks)
    const blocks: number[][] = []
    const rsDivisor = QrCode.reedSolomonComputeDivisor(blockEccLen)

    for (let blockIndex = 0, dataIndex = 0; blockIndex < numBlocks; blockIndex += 1) {
      const dataBlockLength = shortBlockLen - blockEccLen + (blockIndex < numShortBlocks ? 0 : 1)
      const dataBlock = data.slice(dataIndex, dataIndex + dataBlockLength)
      dataIndex += dataBlock.length
      const ecc = QrCode.reedSolomonComputeRemainder(dataBlock, rsDivisor)
      if (blockIndex < numShortBlocks) dataBlock.push(0)
      blocks.push(dataBlock.concat(ecc))
    }

    const result: number[] = []
    for (let i = 0; i < blocks[0].length; i += 1) {
      blocks.forEach((block, blockIndex) => {
        if (i !== shortBlockLen - blockEccLen || blockIndex >= numShortBlocks) {
          result.push(block[i])
        }
      })
    }

    return result
  }

  private drawCodewords(data: ReadonlyArray<number>): void {
    let bitIndex = 0

    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (!this.isFunction[y][x] && bitIndex < data.length * 8) {
            this.modules[y][x] = getBit(data[bitIndex >>> 3], 7 - (bitIndex & 7))
            bitIndex += 1
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    if (mask < 0 || mask > 7) throw new RangeError('QR mask out of range.')

    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        let invert = false
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0
            break
          case 1:
            invert = y % 2 === 0
            break
          case 2:
            invert = x % 3 === 0
            break
          case 3:
            invert = (x + y) % 3 === 0
            break
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
            break
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0
            break
          case 6:
            invert = ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0
            break
          case 7:
            invert = ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0
            break
          default:
            throw new Error('Unreachable.')
        }
        if (!this.isFunction[y][x] && invert) {
          this.modules[y][x] = !this.modules[y][x]
        }
      }
    }
  }

  private getPenaltyScore(): number {
    let result = 0

    for (let y = 0; y < this.size; y += 1) {
      let runColor = false
      let runLength = 0
      const runHistory = [0, 0, 0, 0, 0, 0, 0]

      for (let x = 0; x < this.size; x += 1) {
        if (this.modules[y][x] === runColor) {
          runLength += 1
          if (runLength === 5) result += QrCode.PENALTY_N1
          else if (runLength > 5) result += 1
        } else {
          this.finderPenaltyAddHistory(runLength, runHistory)
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3
          runColor = this.modules[y][x]
          runLength = 1
        }
      }

      result += this.finderPenaltyTerminateAndCount(runColor, runLength, runHistory) * QrCode.PENALTY_N3
    }

    for (let x = 0; x < this.size; x += 1) {
      let runColor = false
      let runLength = 0
      const runHistory = [0, 0, 0, 0, 0, 0, 0]

      for (let y = 0; y < this.size; y += 1) {
        if (this.modules[y][x] === runColor) {
          runLength += 1
          if (runLength === 5) result += QrCode.PENALTY_N1
          else if (runLength > 5) result += 1
        } else {
          this.finderPenaltyAddHistory(runLength, runHistory)
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3
          runColor = this.modules[y][x]
          runLength = 1
        }
      }

      result += this.finderPenaltyTerminateAndCount(runColor, runLength, runHistory) * QrCode.PENALTY_N3
    }

    for (let y = 0; y < this.size - 1; y += 1) {
      for (let x = 0; x < this.size - 1; x += 1) {
        const color = this.modules[y][x]
        if (
          color === this.modules[y][x + 1] &&
          color === this.modules[y + 1][x] &&
          color === this.modules[y + 1][x + 1]
        ) {
          result += QrCode.PENALTY_N2
        }
      }
    }

    let darkModules = 0
    for (const row of this.modules) {
      darkModules = row.reduce((sum, color) => sum + (color ? 1 : 0), darkModules)
    }

    const totalModules = this.size * this.size
    const k = Math.ceil(Math.abs(darkModules * 20 - totalModules * 10) / totalModules) - 1
    result += k * QrCode.PENALTY_N4
    return result
  }

  private finderPenaltyCountPatterns(runHistory: ReadonlyArray<number>): number {
    const n = runHistory[1]
    const core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n

    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
  }

  private finderPenaltyTerminateAndCount(currentRunColor: boolean, currentRunLength: number, runHistory: number[]): number {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory)
      currentRunLength = 0
    }
    currentRunLength += this.size
    this.finderPenaltyAddHistory(currentRunLength, runHistory)
    return this.finderPenaltyCountPatterns(runHistory)
  }

  private finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]): void {
    if (runHistory[0] === 0) currentRunLength += this.size
    runHistory.pop()
    runHistory.unshift(currentRunLength)
  }

  private getAlignmentPatternPositions(): number[] {
    if (this.version === 1) return []
    const numAlign = Math.floor(this.version / 7) + 2
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos)
    }
    return result
  }

  private static getNumRawDataModules(version: number): number {
    if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION) {
      throw new RangeError('QR version out of range.')
    }

    let result = (16 * version + 128) * version + 64
    if (version >= 2) {
      const numAlign = Math.floor(version / 7) + 2
      result -= (25 * numAlign - 10) * numAlign - 55
      if (version >= 7) result -= 36
    }
    return result
  }

  private static getNumDataCodewords(version: number, errorCorrectionLevel: QrCodeEcc): number {
    return Math.floor(QrCode.getNumRawDataModules(version) / 8) -
      QrCode.ECC_CODEWORDS_PER_BLOCK[errorCorrectionLevel.ordinal][version] *
      QrCode.NUM_ERROR_CORRECTION_BLOCKS[errorCorrectionLevel.ordinal][version]
  }

  private static reedSolomonComputeDivisor(degree: number): number[] {
    if (degree < 1 || degree > 255) {
      throw new RangeError('QR divisor degree out of range.')
    }

    const result = Array.from({ length: degree - 1 }, () => 0)
    result.push(1)

    let root = 1
    for (let i = 0; i < degree; i += 1) {
      for (let j = 0; j < result.length; j += 1) {
        result[j] = QrCode.reedSolomonMultiply(result[j], root)
        if (j + 1 < result.length) result[j] ^= result[j + 1]
      }
      root = QrCode.reedSolomonMultiply(root, 0x02)
    }

    return result
  }

  private static reedSolomonComputeRemainder(data: ReadonlyArray<number>, divisor: ReadonlyArray<number>): number[] {
    const result = divisor.map(() => 0)
    for (const byte of data) {
      const factor = byte ^ result.shift()!
      result.push(0)
      divisor.forEach((coefficient, index) => {
        result[index] ^= QrCode.reedSolomonMultiply(coefficient, factor)
      })
    }
    return result
  }

  private static reedSolomonMultiply(x: number, y: number): number {
    let z = 0
    for (let i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d)
      z ^= ((y >>> i) & 1) * x
    }
    return z
  }
}

function appendBits(value: number, length: number, bitBuffer: Bit[]): void {
  if (length < 0 || length > 31 || value >>> length !== 0) {
    throw new RangeError('Bit value out of range.')
  }
  for (let i = length - 1; i >= 0; i -= 1) {
    bitBuffer.push((value >>> i) & 1)
  }
}

function getBit(value: number, bitIndex: number): boolean {
  return ((value >>> bitIndex) & 1) !== 0
}

export function renderPairingQrSvg(text: string, moduleSize: number = 8, margin: number = 4): string {
  const qr = QrCode.encodeBinary(Array.from(textEncoder.encode(text)), QrCodeEcc.LOW)
  const viewBoxSize = (qr.size + (margin * 2)) * moduleSize
  const pathCommands: string[] = []

  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.getModule(x, y)) continue
      const left = (x + margin) * moduleSize
      const top = (y + margin) * moduleSize
      pathCommands.push(`M${left},${top}h${moduleSize}v${moduleSize}h-${moduleSize}z`)
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" role="img" aria-label="Pair Astra Remote" shape-rendering="crispEdges">`,
    `<rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#ffffff" />`,
    `<path d="${pathCommands.join('')}" fill="#050912" />`,
    '</svg>'
  ].join('')
}
