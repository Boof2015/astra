// Production-only benchmark entry points. The regular build never imports the harness.
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = process.cwd()
const output = resolve(root, '.astra-playback-benchmark', process.env.ASTRA_PLAY_BENCH_BUILD ?? 'after')
const baselineRef = process.env.ASTRA_PLAY_BENCH_BASELINE_REF ?? '7e9d3dd'
const baseline = process.env.ASTRA_PLAY_BENCH_BUILD === 'before'
  ? execFileSync('git', ['show', `${baselineRef}:src/renderer/stores/playerStore.ts`], { encoding: 'utf8' })
  : null
function restoreSection(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  const to = code.indexOf(end, from)
  const oldFrom = baseline!.indexOf(start)
  const oldTo = baseline!.indexOf(end, oldFrom)
  if ([from, to, oldFrom, oldTo].some((index) => index < 0)) throw new Error('Queue benchmark baseline markers changed')
  return code.slice(0, from) + baseline!.slice(oldFrom, oldTo) + code.slice(to)
}
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { outDir: resolve(output, 'main') } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(output, 'preload'),
      rollupOptions: { output: {
        banner: `Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resolve(root, '.astra-playback-benchmark/resources'))} });`
      } }
    }
  },
  renderer: {
    plugins: [react(), {
      name: 'click-to-play-benchmark',
      enforce: 'pre',
      transform(code, id) {
        if (baseline && id.endsWith('/src/renderer/stores/playerStore.ts')) {
          code = restoreSection(code, 'export function createQueueEntriesFromPaths(', 'export async function createQueueEntriesFromPathsWithFetch(')
          return restoreSection(code, '    startPlaybackContextByPaths: async (', '    enqueueTrack: (')
        }
        if (id.endsWith('/src/renderer/main.tsx')) {
          return `${code}\nimport ${JSON.stringify(resolve(root, 'scripts/research/click-to-play.renderer.ts'))};`
        }
      }
    }],
    build: { outDir: resolve(output, 'renderer') }
  }
})
