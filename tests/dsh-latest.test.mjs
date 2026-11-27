import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/dsh-latest.mjs', import.meta.url))
const tags = 'https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags'

// Runs the script against a package pinned to `pin`, with the registry answering `response`.
async function track(t, pin, response) {
  const root = await mkdtemp(join(tmpdir(), 'opf-dsh-latest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ peerDependencies: { '@deepseek-ai/dsh-llm': pin, '@deepseek-ai/dsh-llm-pi-ai': pin } }))
  await writeFile(join(root, 'response.json'), JSON.stringify(response))
  const preload = join(root, 'offline.mjs')
  await writeFile(preload, `
    import { readFileSync } from 'node:fs'
    const response = JSON.parse(readFileSync(new URL('./response.json', import.meta.url)))
    globalThis.fetch = async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') throw new Error('Writes forbidden')
      if (String(url) !== ${JSON.stringify(tags)} || response.networkError) throw new Error('network down')
      return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), { status: response.status ?? 200 })
    }
  `)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], { cwd: root, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr }
}

test('latest equal to the pin is a no-op', async (t) => {
  const result = await track(t, '0.2.2-rc.5', { body: { latest: '0.2.2-rc.5', next: '0.2.2-rc.5' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'none')
})

test('a newer latest asks for a bump to that version', async (t) => {
  const result = await track(t, '0.2.2-rc.5', { body: { latest: '0.2.2', next: '0.2.2', alpha: '0.2.3-alpha.2' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'bump 0.2.2')
})

test('a newer alpha or other dist-tag does not trigger a bump', async (t) => {
  const result = await track(t, '0.2.2-rc.5', { body: { latest: '0.2.2-rc.5', next: '0.2.3-rc.1', alpha: '0.2.3-alpha.2' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'none')
})

test('a latest older than the pin is a no-op, never a downgrade', async (t) => {
  const result = await track(t, '0.2.2-rc.5', { body: { latest: '0.2.2-rc.4' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'none')
})

for (const [name, response] of [
  ['a network failure', { networkError: true }],
  ['a registry error', { status: 503, body: { error: 'down' } }],
  ['metadata that is not JSON', { body: 'not json' }],
  ['metadata without latest', { body: { next: '0.2.3' } }],
  ['a latest that is not a version', { body: { latest: 'v0.2.3; rm -rf /' } }],
]) {
  test(`${name} exits non-zero instead of reporting no new version`, async (t) => {
    const result = await track(t, '0.2.2-rc.5', response)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /unverified/)
  })
}
