import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { StratumPrefetchGate, canPrefetchStratum } from './services/stratumPrefetch.ts'

// Actual main-process policy/position/promotion wiring, without loading Electron.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const nodes = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'stratumPrefetchAllowed'
  || ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.arguments.length > 0 && ts.isStringLiteral(node.expression.arguments[0])
    && ['audio:updateProgressiveStreamPosition', 'audio:activateProgressiveStream'].includes(node.expression.arguments[0].text))
assert.equal(nodes.length, 3)
const javascript = ts.transpileModule(nodes.map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
function harness() {
  const sender = {}, otherSender = {}
  const gate = new StratumPrefetchGate()
  const session = (id: number, slot: string, end: number, decoded = end) => ({ id, slot, sender, sampleRate: 48000,
    startTimeSeconds: 0, consumedFrames: 0, decodedFrames: decoded * 48000, durationSeconds: 200,
    done: false, failed: false, cancelled: false, pendingOutcome: null, rendererReady: false,
    stratum: { playableAhead: (position: number) => end - position } })
  const current = session(1, 'current', 200, 30), next = session(2, 'next', 120, 30)
  const sessions = new Map([[1, current], [2, next]])
  const handlers = new Map<string, Function>()
  const context = { remoteStreamSessions: sessions, canPrefetchStratum, stratumPrefetchGate: gate,
    ipcMain: { on: (name: string, handler: Function) => handlers.set(name, handler) },
    safeSendRemoteLoadProgress() {}, updateLocalProgressiveStreamBackpressure() {}, finalizeRemoteStreamSession() {} }
  const allowed = new Function(...Object.keys(context), javascript + '\nreturn stratumPrefetchAllowed;')(...Object.values(context))
  return { current, next, sessions, sender, otherSender, gate, handlers, allowed }
}

test('main prioritizes contiguous encoded cache instead of mistaking a full PCM window for the entire download', () => {
  const h = harness()
  h.current.stratum.playableAhead = () => 6.4
  h.current.consumedFrames = 117.6 * 48000; h.current.decodedFrames = 124 * 48000
  assert.equal(h.allowed(h.next), false)
  h.current.stratum.playableAhead = () => 40
  assert.equal(h.allowed(h.next), true)
  h.current.stratum.playableAhead = () => 200 - 117.6
  assert.equal(h.allowed(h.next), true)
  h.current.consumedFrames = 198 * 48000; h.current.decodedFrames = 200 * 48000
  h.current.stratum.playableAhead = () => 2
  assert.equal(h.allowed(h.next), true, 'a fully cached final two seconds does not starve the gapless successor')
})

test('main position reports and promotion wake the gate; another sender cannot promote it', async () => {
  const h = harness()
  h.current.stratum.playableAhead = () => 6.4
  const pending = h.gate.wait(() => h.allowed(h.next), new AbortController().signal)
  h.handlers.get('audio:activateProgressiveStream')!({ sender: h.otherSender }, 2)
  assert.equal(h.next.slot, 'next')
  h.handlers.get('audio:activateProgressiveStream')!({ sender: h.sender }, 2)
  await pending
  assert.equal(h.next.slot, 'current')

  h.next.slot = 'next'
  const waiting = h.gate.wait(() => h.allowed(h.next), new AbortController().signal)
  h.current.stratum.playableAhead = () => 40
  h.handlers.get('audio:updateProgressiveStreamPosition')!({ sender: h.sender }, 1, 48000)
  await waiting
  assert.equal(h.current.consumedFrames, 48000)
})
