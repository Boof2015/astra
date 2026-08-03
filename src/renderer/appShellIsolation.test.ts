import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

function functionSource(name: string, nextName: string): string {
  const start = appSource.indexOf(`function ${name}`)
  const nextMarker = nextName.startsWith('export ') ? nextName : `function ${nextName}`
  const end = appSource.indexOf(nextMarker, start + 1)
  assert.notEqual(start, -1, `${name} should exist`)
  assert.notEqual(end, -1, `${nextName} should follow ${name}`)
  return appSource.slice(start, end)
}

test('runtime subscriptions stay below the App shell render boundary', () => {
  const app = functionSource('App', 'export default App')
  const runtimeHooks = [
    'usePointerFocusCleanup()',
    'useKeyboardShortcuts()',
    'useMediaSession()',
    'useDiscordPresence()',
    'useMiniPlayerBridge()',
    'useCompanionApiBridge()',
    'useLyricsPopoutBridge()',
    'useScopePopoutBridge()',
    'useMemoryDiagnosticsBridge()',
    'useCoverArtAccent()',
    'useRuntimeAppIconSync()',
    'useControllerInput()'
  ]

  for (const hook of runtimeHooks) {
    assert.equal(
      app.includes(hook),
      false,
      `${hook} must remain in a headless leaf so its updates cannot rerender App or AnalyzerDeck`
    )
  }

  assert.match(app, /<RuntimeBridges\s*\/>/)
  assert.match(app, /<ActiveViewEligibilityGuard\s*\/>/)
  assert.match(app, /<ControllerRuntime showOverlays=\{(?:true|false)\}\s*\/>/)
  assert.match(app, /<AnalyzerDeck\b/)
  assert.match(app, /<ViewRouter\s*\/>/)
})

test('each runtime hook has its own leaf component', () => {
  const leaves = [
    ['PointerFocusRuntime', 'KeyboardShortcutsRuntime', 'usePointerFocusCleanup()'],
    ['KeyboardShortcutsRuntime', 'MediaSessionRuntime', 'useKeyboardShortcuts()'],
    ['MediaSessionRuntime', 'DiscordPresenceRuntime', 'useMediaSession()'],
    ['DiscordPresenceRuntime', 'MiniPlayerBridgeRuntime', 'useDiscordPresence()'],
    ['MiniPlayerBridgeRuntime', 'CompanionApiBridgeRuntime', 'useMiniPlayerBridge()'],
    ['CompanionApiBridgeRuntime', 'LyricsPopoutBridgeRuntime', 'useCompanionApiBridge()'],
    ['LyricsPopoutBridgeRuntime', 'ScopePopoutBridgeRuntime', 'useLyricsPopoutBridge()'],
    ['ScopePopoutBridgeRuntime', 'MemoryDiagnosticsBridgeRuntime', 'useScopePopoutBridge()'],
    ['MemoryDiagnosticsBridgeRuntime', 'CoverArtAccentRuntime', 'useMemoryDiagnosticsBridge()'],
    ['CoverArtAccentRuntime', 'RuntimeAppIconSync', 'useCoverArtAccent()'],
    ['RuntimeAppIconSync', 'RuntimeBridges', 'useRuntimeAppIconSync()']
  ] as const

  for (const [name, nextName, hook] of leaves) {
    const leaf = functionSource(name, nextName)
    assert.match(leaf, new RegExp(hook.replace(/[()]/g, '\\$&')))
    assert.match(leaf, /return null/)
  }
})
