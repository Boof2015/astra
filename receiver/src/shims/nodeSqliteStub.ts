// undici ships an optional SQLite-backed HTTP cache store that lazily requires `node:sqlite`.
// Vite's CommonJS transform hoists that require into a top-level import, which crashes Node
// versions without the builtin (< 22.13) at startup — before any receiver code runs. The
// receiver never uses undici's cache interceptor, so the builtin is aliased to this stub at
// bundle time (see receiver/vite.config.ts). Constructing it means something actually tried to
// use the cache store — fail loudly rather than pretend.
export class DatabaseSync {
  constructor() {
    throw new Error('node:sqlite is stubbed out of the astra-receiver bundle.')
  }
}

export default { DatabaseSync }
