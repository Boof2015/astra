import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

// Bundles the daemon (plus the shared protocol/crypto/discovery modules from ../src) into a
// single Node ESM file. Only the native .node addon stays external — it's loaded at runtime via
// createRequire with a filesystem path. Deploy = dist/astra-receiver.mjs + receiver/native.
export default defineConfig({
  resolve: {
    alias: {
      // undici's optional sqlite cache store — see src/shims/nodeSqliteStub.ts.
      'node:sqlite': join(here, 'src/shims/nodeSqliteStub.ts')
    }
  },
  build: {
    ssr: join(here, 'src/main.ts'),
    target: 'node20',
    outDir: join(here, 'dist'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'astra-receiver.mjs'
      }
    }
  },
  ssr: {
    // Bundle every JS dependency (bonjour-service, undici, @peculiar/x509, reflect-metadata are
    // all pure JS) so the Pi needs no node_modules.
    noExternal: true
  }
})
