import 'reflect-metadata'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer } from 'node:https'
import { webcrypto } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'
import { inspectManualSidecar } from './stratumManual.ts'

async function certificateFixture(t: TestContext, ip = '127.0.0.1', expired = false) {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=Disposable test proxy', keys: keys as unknown as CryptoKeyPair,
    signingAlgorithm: algorithm, notBefore: new Date(Date.now() - 86400_000),
    notAfter: new Date(Date.now() + (expired ? -3600_000 : 86400_000)),
    extensions: [new x509.BasicConstraintsExtension(true, 0, true),
      new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: ip }])]
  }, webcrypto as unknown as Crypto)
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')
  const key = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  const cert = certificate.toString('pem')
  const directory = await mkdtemp(join(tmpdir(), 'astra-manual-tls-'))
  const rootFile = join(directory, 'test-ca.pem')
  await writeFile(rootFile, cert)
  const requests: string[] = []
  const server = createServer({ key, cert }, (req, res) => {
    requests.push(req.url!)
    assert.equal(req.headers.authorization, undefined)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ service: 'astra-sidecar', installation: 'a'.repeat(32), spkiSha256: 'b'.repeat(64),
      protocol: 'stratum-access-proof-1', audioExperiment: 'stratum-authenticated-audio-1',
      authentication: 'subsonic-token', sessionRenewal: 'fresh-credentials-same-user', ready: true, playback: true }))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = `https://127.0.0.1:${(server.address() as { port: number }).port}/proxy`
  // An isolated Node process gives this fixture its own CA store. Production code
  // and the parent test runner never modify their certificate verification policy.
  const inspectWithTrust = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval',
      `import { inspectManualSidecar } from ${JSON.stringify(new URL('./stratumManual.ts', import.meta.url).href)};
       try { console.log(JSON.stringify(await inspectManualSidecar(${JSON.stringify(address)}, AbortSignal.timeout(3000)))) }
       catch (error) { console.log(JSON.stringify({error:error.message})) }`],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: rootFile }, timeout: 5000 })
    return JSON.parse(stdout)
  }
  return { address, requests, inspectWithTrust }
}

test('a CA-trusted HTTPS proxy needs no manual trust and preserves its base path', async t => {
  const { requests, inspectWithTrust } = await certificateFixture(t)
  const result = await inspectWithTrust()
  assert.equal(result.error, undefined)
  assert.equal(result.requiresTrust, false)
  assert.equal(result.manifest.endpoints[0].trust, 'https_proxy')
  assert.equal(result.manifest.spkiSha256, 'b'.repeat(64), 'Sidecar identity can differ from the proxy certificate')
  assert.deepEqual(requests, ['/proxy/stratum/access/v1/capabilities'])
})

test('a trusted certificate for a different hostname cannot become a self-signed trust proposal', async t => {
  const { requests, inspectWithTrust } = await certificateFixture(t, '192.0.2.1')
  const result = await inspectWithTrust()
  assert.match(result.error, /does not match its address/)
  assert.equal(result.requiresTrust, undefined)
  assert.deepEqual(requests, [], 'no HTTP is sent to the invalid endpoint')
})

test('an expired self-signed certificate needs repair, not first-use acceptance', async t => {
  const { address, requests } = await certificateFixture(t, '127.0.0.1', true)
  await assert.rejects(inspectManualSidecar(address, AbortSignal.timeout(3000)), /certificate has expired/)
  assert.deepEqual(requests, [])
})
