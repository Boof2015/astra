// Separate build: real application + test driver. Normal builds never import it.
import { resolve, isAbsolute } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const directory = process.env.ASTRA_STRATUM_APP_DIRECTORY
if (!directory || !isAbsolute(directory)) throw new Error('An absolute disposable test directory is required.')
const root = process.cwd()
const output = resolve(directory, 'app')
function replaceOnce(code: string, from: string, to: string) {
  if (code.split(from).length !== 2) throw new Error(`Full-app fixture marker changed: ${from}`)
  return code.replace(from, to)
}
export default defineConfig({
  main: {
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    plugins: [externalizeDepsPlugin(), {
      name: 'stratum-disposable-profile', enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/src/main/index.ts')) return
        code = replaceOnce(code, '  await library.initDatabase()',
          '  await library.initDatabase()\n  await globalThis.__stratumAppSeed(library, { syncSubsonicCatalog, encryptSubsonicSecret })')
        return replaceOnce(code, 'mainWindow = new BrowserWindow({', 'mainWindow = new BrowserWindow({ show: false,')
      }
    }], build: { outDir: resolve(output, 'main') }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: {
    outDir: resolve(output, 'preload'), rollupOptions: { output: {
      banner: `Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resolve(directory, 'resources'))} });`
    } }
  } },
  renderer: { plugins: [react(), {
    name: 'stratum-app-driver', enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/src/renderer/main.tsx')) return `${code}\nimport ${JSON.stringify(resolve(root, 'scripts/stratum/fullAppRenderer.ts'))};`
    }
  }], build: { outDir: resolve(output, 'renderer') } }
})
