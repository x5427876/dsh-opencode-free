import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = fileURLToPath(new URL('..', import.meta.url))
const script = join(repo, 'scripts/dsh-bump.mjs')
const PINNED = ['package.json', 'README.md', 'README.zh-TW.md', 'AGENTS.md', 'docs/compat-run.md', 'src/index.ts']
const HISTORY = 'docs/protocol-notes.md'
const pin = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).peerDependencies['@deepseek-ai/dsh-llm']

async function bump(t, version) {
  const root = await mkdtemp(join(tmpdir(), 'opf-dsh-bump-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of [...PINNED, 'pnpm-workspace.yaml', HISTORY]) await cp(join(repo, name), join(root, name))
  const result = spawnSync(process.execPath, [script, version], { cwd: root, encoding: 'utf8' })
  const read = (name) => readFile(join(root, name), 'utf8')
  return { ...result, read }
}

test('a bump moves every file that names the pin and keeps dated history', async (t) => {
  const result = await bump(t, '9.8.7-rc.1')
  assert.equal(result.status, 0, result.stderr)
  for (const name of PINNED) {
    const text = await result.read(name)
    assert.ok(!text.includes(pin), `${name} no longer names ${pin}`)
    assert.ok(text.includes('9.8.7-rc.1'), `${name} names the new DSH`)
  }
  const peers = JSON.parse(await result.read('package.json')).peerDependencies
  assert.equal(peers['@deepseek-ai/dsh-llm'], '9.8.7-rc.1')
  assert.equal(peers['@deepseek-ai/dsh-llm-pi-ai'], '9.8.7-rc.1')
  assert.equal(await result.read(HISTORY), await readFile(join(repo, HISTORY), 'utf8'), 'dated measurements keep the version they ran on')
})

test('a bump lets the new DSH packages through the release-age gate', async (t) => {
  const result = await bump(t, '9.8.7-rc.1')
  assert.equal(result.status, 0, result.stderr)
  const lines = (await result.read('pnpm-workspace.yaml')).split('\n')
  const dsh = lines.filter(line => line.includes(`'@deepseek-ai/dsh-`))
  assert.ok(dsh.length > 0)
  for (const line of dsh) assert.ok(line.endsWith(`|| ${pin} || 9.8.7-rc.1'`), line)
  const others = lines.filter(line => !line.includes(`'@deepseek-ai/dsh-`))
  assert.deepEqual(others, (await readFile(join(repo, 'pnpm-workspace.yaml'), 'utf8')).split('\n').filter(line => !line.includes(`'@deepseek-ai/dsh-`)))
})

for (const version of ['', 'latest', '9.8', '9.8.7; rm -rf /']) {
  test(`"${version}" is refused and nothing changes`, async (t) => {
    const result = await bump(t, version)
    assert.equal(result.status, 2)
    for (const name of PINNED) assert.equal(await result.read(name), await readFile(join(repo, name), 'utf8'))
  })
}
