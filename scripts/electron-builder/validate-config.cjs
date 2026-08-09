#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const expectedExtensions = [
  'mp3',
  'flac',
  'wav',
  'ogg',
  'aac',
  'm4a',
  'opus',
  'wma',
  'aiff',
  'alac',
  'ape',
  'wv'
]

function fail(message) {
  console.error(`[validate-config] ${message}`)
  process.exit(1)
}

const packageJsonPath = path.resolve(__dirname, '../../package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const buildConfig = packageJson.build ?? {}

const nativeFilesPattern = 'native/build/Release/*.node'
const nativeResourceFrom = 'native/build/Release/'
const nativeResourceTo = 'native/'
const nativeResourceFilter = '*.node'

if (!Array.isArray(buildConfig.files) || !buildConfig.files.includes(nativeFilesPattern)) {
  fail(`build.files must include ${nativeFilesPattern}.`)
}

const nativeResourceEntry = Array.isArray(buildConfig.extraResources)
  ? buildConfig.extraResources.find((entry) => (
      entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && entry.from === nativeResourceFrom
      && entry.to === nativeResourceTo
    ))
  : undefined

if (
  !nativeResourceEntry
  || !Array.isArray(nativeResourceEntry.filter)
  || !nativeResourceEntry.filter.includes(nativeResourceFilter)
) {
  fail(
    `build.extraResources must copy ${nativeResourceFrom}${nativeResourceFilter} to ${nativeResourceTo}.`
  )
}

if (buildConfig.fileAssociations !== undefined) {
  fail('build.fileAssociations must not exist; use platform-specific fileAssociations blocks.')
}

const linuxAssociations = buildConfig.linux?.fileAssociations

if (!Array.isArray(linuxAssociations)) {
  fail('build.linux.fileAssociations must be an array.')
}

const linuxExtensions = linuxAssociations.map((association, index) => {
  if (typeof association !== 'object' || association === null || Array.isArray(association)) {
    fail(`build.linux.fileAssociations[${index}] must be an object.`)
  }

  if (typeof association.ext !== 'string') {
    fail(`build.linux.fileAssociations[${index}].ext must be a string.`)
  }

  if (association.ext.includes(',')) {
    fail(`build.linux.fileAssociations[${index}].ext must not contain commas.`)
  }

  return association.ext
})

const sortedActual = [...linuxExtensions].sort()
const sortedExpected = [...expectedExtensions].sort()

if (sortedActual.length !== sortedExpected.length) {
  fail(
    `Linux file association count mismatch. Expected ${sortedExpected.length}, received ${sortedActual.length}.`
  )
}

for (let index = 0; index < sortedExpected.length; index += 1) {
  if (sortedActual[index] !== sortedExpected[index]) {
    fail(
      `Linux file association extensions mismatch. Expected ${sortedExpected.join(', ')}, received ${sortedActual.join(', ')}.`
    )
  }
}

console.log('[validate-config] Packaging config looks valid.')
