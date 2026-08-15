export type BinaryClockBit = 0 | 1

const BCD_BIT_WEIGHTS = [8, 4, 2, 1] as const

export function getBinaryClockDigits(date: Date): readonly number[] {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')

  return `${hours}${minutes}${seconds}`.split('').map(Number)
}

export function encodeBinaryClock(date: Date): BinaryClockBit[][] {
  const digits = getBinaryClockDigits(date)
  return BCD_BIT_WEIGHTS.map((weight) => (
    digits.map((digit) => (digit & weight) === weight ? 1 : 0)
  ))
}

export function formatBinaryClockTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}
