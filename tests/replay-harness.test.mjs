import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { completionsText, officialModel } from '../scripts/replay-fixtures.mjs'
import { startUpstream } from '../scripts/replay-upstream.mjs'

const run = promisify(execFile)
const PRELOAD = resolve('scripts/replay-preload.cjs')

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

// The redirect is what keeps the headless replay run offline, so it is tested
// on its own: a child process that talks to opencode.ai must reach the fake.
test('the preload sends opencode.ai traffic to the loopback fake and nowhere else', { skip: !hasOpenssl && 'needs the openssl CLI' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-harness-'))
  const upstream = await startUpstream({ dir, models: [officialModel('replay-free-a')] })
  t.after(async () => { await upstream.close(); await rm(dir, { recursive: true, force: true }) })
  upstream.use(() => completionsText('FROM-FAKE'))
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: upstream.ca, REPLAY_FAKE_PORT: String(upstream.port), NODE_OPTIONS: `--require ${PRELOAD}` }

  await t.test('fetch', async () => {
    const script = "const r = await fetch('https://opencode.ai/inference/v1/models'); console.log((await r.json()).data[0].id)"
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env })
    assert.equal(stdout.trim(), 'replay-free-a')
  })

  await t.test('node:https', async () => {
    const script = "require('node:https').get('https://opencode.ai/inference/v1/models', r => { let b=''; r.on('data', c => b += c); r.on('end', () => console.log(JSON.parse(b).data[0].id)) })"
    const { stdout } = await run(process.execPath, ['-e', script], { env })
    assert.equal(stdout.trim(), 'replay-free-a')
  })

  await t.test('a POST is answered by the installed handler and recorded', async () => {
    const script = "const r = await fetch('https://opencode.ai/inference/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }) }); console.log((await r.text()).includes('FROM-FAKE'))"
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env })
    assert.equal(stdout.trim(), 'true')
    assert.equal(upstream.inference().at(-1).body.model, 'm')
  })

  await t.test('another host is untouched', async () => {
    const before = upstream.requests.length
    const script = "try { await fetch('https://example.invalid/', { signal: AbortSignal.timeout(3000) }) } catch { console.log('unreachable') }"
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env })
    assert.equal(stdout.trim(), 'unreachable')
    assert.equal(upstream.requests.length, before, 'the fake never saw it')
  })
})

test('the preload refuses to run without a redirect target', async () => {
  const env = { ...process.env, NODE_OPTIONS: `--require ${PRELOAD}` }
  delete env.REPLAY_FAKE_PORT
  await assert.rejects(run(process.execPath, ['-e', '0'], { env }), /REPLAY_FAKE_PORT/)
})
