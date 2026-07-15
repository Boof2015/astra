import { strict as assert } from 'node:assert'
import test from 'node:test'
import { SCOPE_KINDS, type ScopeKind } from '../../../types/scopePopout.ts'
import { NATIVE_ONLY_SCOPES, isNativeOnlyScope } from './nativeOnlyScopes.ts'

// Scopes that render nothing usable without the native DSP addon (no JS fallback) and therefore
// get the "native DSP unavailable" notice.
const NATIVE_ONLY: ScopeKind[] = ['spectrum', 'oscilloscope', 'spectrogram', 'lufsmeter']

// Scopes that still respond to audio without native and keep drawing at reduced quality.
const HAS_JS_FALLBACK: ScopeKind[] = ['vectorscope', 'waveform', 'vumeter']

test('native-only scopes are exactly those without a JS fallback', () => {
  for (const scope of NATIVE_ONLY) {
    assert.equal(isNativeOnlyScope(scope), true, `${scope} should be native-only`)
  }

  for (const scope of HAS_JS_FALLBACK) {
    assert.equal(isNativeOnlyScope(scope), false, `${scope} should keep its JS fallback`)
  }
})

test('classification covers every ScopeKind exactly once', () => {
  // If a new scope is added to SCOPE_KINDS, it must be classified in one of the two lists here
  // (and, if native-only, in NATIVE_ONLY_SCOPES) — this guards against a future scope silently
  // defaulting to "has fallback" and rendering a blank tile with no notice.
  const allScopes: ScopeKind[] = [...NATIVE_ONLY, ...HAS_JS_FALLBACK]
  assert.equal(new Set(allScopes).size, allScopes.length, 'no scope classified twice')
  assert.deepEqual([...allScopes].sort(), [...SCOPE_KINDS].sort(), 'every ScopeKind is classified')
  assert.equal(NATIVE_ONLY_SCOPES.size, NATIVE_ONLY.length)
})
