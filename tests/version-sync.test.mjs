import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// C1: one release supports exactly one DSH version, and every place that names
// it moves together. The pin in package.json is the single source of truth;
// each file below must agree with it, so an upgrade that misses one fails here.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(await read('package.json'))
const dsh = pkg.peerDependencies['@deepseek-ai/dsh-llm']
const v = pkg.version

for (const readme of ['README.md', 'README.zh-TW.md']) {
  test(`${readme} names the pinned DSH and lists this release first`, async () => {
    const text = await read(readme)
    assert.ok(text.includes(`\`${dsh}\``), `${readme} names DSH ${dsh}`)
    const firstRow = text.match(/^\| `\d[^|]*` \| `[^|]+` \|$/m)
    assert.equal(firstRow?.[0], `| \`${v}\` | \`${dsh}\` |`, `${readme} compatibility table leads with ${v}`)
  })
}

test('public release documentation omits internal npm handoff boilerplate', async () => {
  const handoff = /git (?:tag alone does not mean|標籤不代表)|publication is a separate maintainer step|維護者(?:會)?另行發布 npm|發布套件是維護者另行執行的步驟/i
  for (const file of ['README.md', 'README.zh-TW.md']) {
    const text = (await read(file)).replace(/\s+/g, ' ')
    assert.doesNotMatch(text, handoff, `${file} describes the release, not internal publication handoffs`)
  }
})

test('AGENTS.md says which DSH this release supports', async () => {
  assert.ok((await read('AGENTS.md')).includes(`only DeepSeek Harness \`${dsh}\``))
})

test('docs/compat-run.md shows the pinned DSH in its example command', async () => {
  assert.ok((await read('docs/compat-run.md')).includes(`pnpm compat --dsh ${dsh}`))
})

test('src/index.ts header names the pinned DSH', async () => {
  assert.ok((await read('src/index.ts')).includes(`bundle for \`${dsh}\``))
})

test('every DSH package in the release-age exclusions allows the pinned version', async () => {
  const lines = (await read('pnpm-workspace.yaml')).split('\n').filter((l) => /@deepseek-ai\/dsh-[\w-]+@/.test(l))
  assert.ok(lines.length > 0, 'pnpm-workspace.yaml lists DSH packages')
  for (const line of lines) assert.ok(line.includes(dsh), `${line.trim()} allows ${dsh}`)
})

test('release history uses GitHub Releases instead of a local changelog', async () => {
  for (const file of ['README.md', 'README.zh-TW.md']) {
    const text = await read(file)
    assert.ok(text.includes('](https://github.com/x5427876/dsh-opencode-free/releases)'), `${file} links to GitHub Releases`)
    assert.doesNotMatch(text, /\]\([^)]*CHANGELOG\.md\)/i, `${file} has no local changelog link`)
  }
  assert.ok(!pkg.files.includes('CHANGELOG.md'), 'the package does not include a separate changelog')
  await assert.rejects(read('CHANGELOG.md'), { code: 'ENOENT' })
})
