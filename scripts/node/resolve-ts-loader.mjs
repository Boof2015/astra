import { extname } from 'node:path'

function isExtensionlessRelativeSpecifier(specifier) {
  return (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/'))
    && extname(specifier) === ''
}

export async function resolve(specifier, context, nextResolve) {
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
