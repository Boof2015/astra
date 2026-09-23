// Color formatting depends on both the palette entry and the final rounded
// alpha. Nearby intensities can select the same entry but different alphas.
export class SpectrumHeatmapColors {
  private palette: Uint8ClampedArray
  private styles = new Map<number, string>()

  constructor(palette: Uint8ClampedArray) {
    this.palette = palette
  }

  reset(palette = this.palette): void {
    this.palette = palette
    this.styles.clear()
  }

  getStyle(index: number, alpha: number): string {
    const key = index * 256 + alpha
    let style = this.styles.get(key)
    if (style === undefined) {
      const offset = index * 4
      const r = this.palette[offset]
      const g = this.palette[offset + 1]
      const b = this.palette[offset + 2]
      style = alpha >= 255
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${Number((alpha / 255).toFixed(3))})`
      this.styles.set(key, style)
    }
    return style
  }
}
