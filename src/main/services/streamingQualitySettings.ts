import {
  isStreamingQuality, parseStreamingQualitySettings, streamingQualitySourceKey,
  type StreamingQuality, type StreamingQualitySettings, type StreamingQualitySource
} from '../../types/streamingQuality'

export const STREAMING_QUALITY_SETTINGS_KEY = 'streaming_quality_v1'

interface QualityStorage {
  read(): string | null | undefined
  write(value: string): Promise<unknown>
  sourceExists(source: StreamingQualitySource): boolean
  changed(settings: StreamingQualitySettings, previous: StreamingQualitySettings): void
}

/** Serialize read/modify/write so concurrent edits cannot drop another server's override. */
export class StreamingQualityPreferences {
  private writes: Promise<unknown> = Promise.resolve()
  private storage: QualityStorage
  constructor(storage: QualityStorage) { this.storage = storage }

  read(): StreamingQualitySettings { return parseStreamingQualitySettings(this.storage.read()) }

  update(quality: StreamingQuality | null, source?: StreamingQualitySource): Promise<StreamingQualitySettings> {
    if ((!isStreamingQuality(quality) && !(source && quality === null))) return Promise.reject(new Error('Invalid streaming quality.'))
    let key: string | undefined
    try { if (source) key = streamingQualitySourceKey(source) }
    catch (error) { return Promise.reject(error) }
    const update = this.writes.then(async () => {
      if (source && !this.storage.sourceExists(source)) throw new Error('Streaming server no longer exists.')
      const previous = this.read()
      const settings = { ...previous, overrides: { ...previous.overrides } }
      if (key) {
        if (quality === null) delete settings.overrides[key]
        else settings.overrides[key] = quality
      } else settings.global = quality!
      await this.storage.write(JSON.stringify(settings))
      this.storage.changed(settings, previous)
      return settings
    })
    this.writes = update.catch(() => undefined)
    return update
  }
}
