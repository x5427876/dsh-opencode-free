import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/verify-release.mjs', import.meta.url))
const commit = '1111111111111111111111111111111111111111'
const tagObject = '2222222222222222222222222222222222222222'
const github = 'https://api.github.com/repos/x5427876/dsh-opencode-free'

async function verify(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'opf-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'package'))
  await writeFile(join(root, 'package/package.json'), JSON.stringify({
    name: 'dsh-opencode-free', version: '0.3.4',
    peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-alpha.3' },
  }))
  const asset = join(root, 'dsh-opencode-free-0.3.4.tgz')
  assert.equal(spawnSync('tar', ['-czf', asset, '-C', root, 'package/package.json']).status, 0)
  const digest = 'sha256:' + createHash('sha256').update(await readFile(asset)).digest('hex')
  const responses = {
    [`${github}/git/ref/tags/v0.3.4`]: { body: { ref: 'refs/tags/v0.3.4', object: { type: 'tag', sha: tagObject } } },
    [`${github}/git/tags/${tagObject}`]: { body: { tag: 'v0.3.4', object: { type: 'commit', sha: commit } } },
    [`${github}/releases/tags/v0.3.4`]: { body: {
      tag_name: 'v0.3.4', draft: false, prerelease: false, published_at: '2026-10-15T00:00:00Z',
      body: 'Requires DeepSeek Harness **0.2.1-alpha.3** exactly.\n\n## Install\nUse the package.',
      assets: [{ name: 'dsh-opencode-free-0.3.4.tgz', state: 'uploaded', digest }],
    } },
    'https://registry.npmjs.org/dsh-opencode-free/0.3.4': { body: { name: 'dsh-opencode-free', version: '0.3.4' } },
  }
  await change(responses, { root, asset })
  await writeFile(join(root, 'responses.json'), JSON.stringify(responses))
  const preload = join(root, 'offline.mjs')
  await writeFile(preload, `
    import { readFileSync } from 'node:fs'
    const responses = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url)))
    globalThis.fetch = async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') throw new Error('Writes forbidden')
      const response = responses[String(url)]
      if (!response || response.networkError) throw new Error('SECRET network diagnostic')
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200 })
    }
  `)
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(preload).href, script,
    '--version', '0.3.4', '--commit', commit, '--asset', asset,
  ], { cwd: root, encoding: 'utf8' })
  return { status: result.status, output: result.stdout + result.stderr }
}

test('a published release passes only with the expected annotated tag, asset and npm version', async (t) => {
  const result = await verify(t)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Release v0\.3\.4 verified/)
  assert.match(result.output, /npm 0\.3\.4 available/)
})

for (const [name, change, status, message] of [
  ['missing tag', (r) => { r[`${github}/git/ref/tags/v0.3.4`].status = 404 }, 1, /GitHub tag: not found/],
  ['lightweight tag', (r) => { r[`${github}/git/ref/tags/v0.3.4`].body.object.type = 'commit' }, 1, /must be annotated/],
  ['wrong commit', (r) => { r[`${github}/git/tags/${tagObject}`].body.object.sha = tagObject }, 1, /commit mismatch/],
  ['missing Release', (r) => { r[`${github}/releases/tags/v0.3.4`].status = 404 }, 1, /GitHub Release: not found/],
  ['draft Release', (r) => { r[`${github}/releases/tags/v0.3.4`].body.draft = true }, 1, /not published/],
  ['wrong release tag', (r) => { r[`${github}/releases/tags/v0.3.4`].body.tag_name = 'v0.3.3' }, 1, /not published/],
  ['wrong prerelease status', (r) => { r[`${github}/releases/tags/v0.3.4`].body.prerelease = true }, 1, /stable\/prerelease status mismatch/],
  ['wrong DSH notes', (r) => { r[`${github}/releases/tags/v0.3.4`].body.body = 'Requires DeepSeek Harness **0.2.1-alpha.30**.' }, 1, /exact supported DSH/],
  ['missing asset', (r) => { r[`${github}/releases/tags/v0.3.4`].body.assets = [] }, 1, /tarball is missing/],
  ['wrong asset hash', (r) => { r[`${github}/releases/tags/v0.3.4`].body.assets[0].digest = 'sha256:' + '0'.repeat(64) }, 1, /SHA-256 mismatch/],
  ['unknown asset hash', (r) => { r[`${github}/releases/tags/v0.3.4`].body.assets[0].digest = null }, 2, /digest unavailable/],
  ['unpublished npm version', (r) => { r['https://registry.npmjs.org/dsh-opencode-free/0.3.4'].status = 404 }, 1, /npm version: not found/],
  ['wrong npm version', (r) => { r['https://registry.npmjs.org/dsh-opencode-free/0.3.4'].body.version = '0.3.3' }, 1, /npm package\/version mismatch/],
  ['registry outage', (r) => { r['https://registry.npmjs.org/dsh-opencode-free/0.3.4'].status = 503 }, 2, /npm version: HTTP 503/],
  ['GitHub authorization or rate limit', (r) => { r[`${github}/git/ref/tags/v0.3.4`] = { status: 403, body: { message: 'SECRET server diagnostic' } } }, 2, /GitHub tag: HTTP 403/],
  ['network failure', (r) => { r[`${github}/git/ref/tags/v0.3.4`].networkError = true }, 2, /network or timeout/],
  ['invalid metadata', (r) => { r[`${github}/git/ref/tags/v0.3.4`].body = 'SECRET invalid metadata' }, 2, /invalid metadata/],
]) {
  test(`${name} cannot be reported as a verified release`, async (t) => {
    const result = await verify(t, change)
    assert.equal(result.status, status, result.output)
    assert.match(result.output, message)
    assert.doesNotMatch(result.output, /Release v0\.3\.4 verified|SECRET/)
  })
}

test('an unreadable tarball fails before remote verification', async (t) => {
  const result = await verify(t, async (_responses, { asset }) => writeFile(asset, 'not a tarball'))
  assert.equal(result.status, 2, result.output)
  assert.match(result.output, /Cannot read the local tarball manifest/)
})

test('missing release inputs produce usage without remote requests', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: pnpm verify:release/)
})
