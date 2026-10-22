import packageMetadata from '../../../package.json' with { type: 'json' }

// Bundled from the same package metadata used to version the desktop app.
export const PROVIDER_CLIENT_VERSION = packageMetadata.version
export const PROVIDER_USER_AGENT = `Astra/${PROVIDER_CLIENT_VERSION} (${process.platform}; ${process.arch})`

export function buildProviderRequestHeaders(): Record<string, string> {
  return { 'User-Agent': PROVIDER_USER_AGENT }
}
