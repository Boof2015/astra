import { extname } from 'node:path'

const electronStubSource = `
const userDataPath = () => {
  const path = globalThis.__ASTRA_TEST_USER_DATA || process.env.ASTRA_TEST_USER_DATA
  if (!path) throw new Error('ASTRA_TEST_USER_DATA is required for Electron service tests.')
  return path
}

export const app = {
  isReady: () => true,
  getPath: (name) => {
    if (name === 'userData') return userDataPath()
    return userDataPath()
  }
}

export const powerMonitor = {
  isOnBatteryPower: () => false
}
`

function isExtensionlessRelativeSpecifier(specifier) {
  return (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/'))
    && extname(specifier) === ''
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      url: `data:text/javascript,${encodeURIComponent(electronStubSource)}`,
      shortCircuit: true
    }
  }

  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (
      error
      && error.code === 'ERR_MODULE_NOT_FOUND'
      && isExtensionlessRelativeSpecifier(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context)
    }

    throw error
  }
}
