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

test('the changelog entry for this release names the pinned DSH', async () => {
  const changelog = await read('CHANGELOG.md')
  const section = changelog.split(/^## \[/m).find((s) => s.startsWith(`${v}]`))
  if (section === undefined) return // [Unreleased] may lead until the release is cut
  assert.ok(section.includes(`Supports DeepSeek Harness \`${dsh}\``), `CHANGELOG ${v} names ${dsh}`)
})
