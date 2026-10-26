import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { CompletedStreamingDiagnostics, StratumSegmentDiagnostics } from './services/streamingDiagnostics.ts'

// Use the actual IPC callback and snapshot mapper, without loading Electron.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const mapper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'streamingDiagnosticsSnapshot')!
const registration = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.arguments[0]?.getText(source) === "'audio:getStreamingDiagnostics'") as ts.ExpressionStatement
const handler = (registration.expression as ts.CallExpression).arguments[1]
const javascript = ts.transpileModule(`${mapper.getText(source)}\nconst handler = ${handler.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

test('diagnostics IPC reads only the requesting renderer, bounds requests, and strips private session data', () => {
  const sender = { id: 1 }, other = { id: 2 }
  const diagnostics = new StratumSegmentDiagnostics()
  diagnostics.begin(20, 24, 'opus-64').decoded()
  const session = { id: 7, sender, startTimeSeconds: 20, durationSeconds: 120, decodedFrames: 96000,
    sampleRate: 48000, channels: 2, sourceType: 'subsonic', filePath: 'secret path', loadedBytes: 1000,
    totalBytes: null, failed: false, done: false, cacheLease: null,
    stratum: { playback: { playback: 'secret handle', source: { sha256: 'secret hash', sample_rate: 44100 } }, diagnostics } }
  const active = new Map([[7, session]])
  const completed = new CompletedStreamingDiagnostics()
  const nativeStratum = { diagnostics: (owner: number, id: number) => owner === sender.id && id === 8
    ? { sessionId: 8, transport: 'stratum', state: 'preparing' } : undefined }
  const api = new Function('remoteStreamSessions', 'completedStreamingDiagnostics', 'nativeStratum',
    `${javascript}\nreturn { handler, snapshot: streamingDiagnosticsSnapshot };`)(active, completed, nativeStratum)
  const result = api.handler({ sender }, [7])
  assert.equal(result[0].bufferedEnd, 22)
  assert.equal(result[0].transport, 'stratum')
  assert.equal(result[0].localCacheComplete, false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.deepEqual(api.handler({ sender: other }, [7]), [])
  assert.equal(api.handler({ sender }, [8])[0].transport, 'stratum')
  assert.deepEqual(api.handler({ sender: other }, [8]), [])
  for (const invalid of [null, [7, 8, 9], [-1], [NaN], ['7']]) assert.deepEqual(api.handler({ sender }, invalid), [])
  assert.equal(api.handler({ sender }, [7, 7]).length, 1)
  completed.remember(sender, { ...api.snapshot(session), state: 'complete' })
  active.clear()
  assert.equal(api.handler({ sender }, [7])[0].state, 'complete')
  assert.deepEqual(api.handler({ sender: other }, [7]), [])
})
