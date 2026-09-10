import { readFile, writeFile, rename } from 'fs/promises'
import type { NotchPrefs } from '../../types/notch'
import { normalizeNotchPrefs } from './notchState'

export async function loadNotchPrefs(path: string): Promise<NotchPrefs> {
  try { return normalizeNotchPrefs(JSON.parse(await readFile(path, 'utf8'))) }
  catch { return normalizeNotchPrefs(null) }
}
export async function saveNotchPrefs(path: string, prefs: NotchPrefs): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(normalizeNotchPrefs(prefs), null, 2), 'utf8')
  await rename(`${path}.tmp`, path)
}
