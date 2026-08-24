const baseTextCollator = new Intl.Collator(undefined, { sensitivity: 'base' })

/**
 * Compare text using the app's case-insensitive locale ordering without
 * rebuilding locale comparison state for every sort comparison.
 */
export function compareBaseLocaleText(a: string, b: string): number {
  return baseTextCollator.compare(a, b)
}
