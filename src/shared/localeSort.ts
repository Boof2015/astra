const baseTextCollator = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Reuse locale comparison state across library sort comparisons. */
export function compareBaseLocaleText(a: string, b: string): number {
  return baseTextCollator.compare(a, b)
}
