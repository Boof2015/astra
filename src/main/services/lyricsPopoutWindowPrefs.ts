import { app, screen } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import {
  normalizeLyricsPopoutWindowPrefs,
  type LyricsPopoutWindowPrefs
} from '../../types/lyricsPopout'

const PREFS_FILE_NAME = 'lyrics-popout-window.json'

function prefsPath(): string {
  return join(app.getPath('userData'), PREFS_FILE_NAME)
}

function getDisplayWorkAreas() {
  return screen.getAllDisplays().map((display) => ({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height
  }))
}

export async function loadLyricsPopoutWindowPrefs(): Promise<LyricsPopoutWindowPrefs> {
  try {
    const data = await readFile(prefsPath(), 'utf-8')
    return normalizeLyricsPopoutWindowPrefs(JSON.parse(data), getDisplayWorkAreas())
  } catch {
    return normalizeLyricsPopoutWindowPrefs(null, getDisplayWorkAreas())
  }
}

export async function saveLyricsPopoutWindowPrefs(prefs: LyricsPopoutWindowPrefs): Promise<void> {
  const normalized = normalizeLyricsPopoutWindowPrefs(prefs, getDisplayWorkAreas())
  await writeFile(prefsPath(), JSON.stringify(normalized, null, 2), 'utf-8')
}
