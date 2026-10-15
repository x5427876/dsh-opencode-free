import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/check-doc-links.mjs', import.meta.url))

async function check(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'opf-doc-links-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0)
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
  return { status: result.status, output: result.stdout + result.stderr }
}

test('local documentation links succeed without accessing external URLs', async (t) => {
  const result = await check(t, {
    'README.md': '[Guide](docs/guide.md) [External](https://invalid.example/missing)\n',
    'docs/guide.md': '# Guide\n[Back](../README.md)\n',
  })
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /2 local links checked/)
})

test('encoded paths and Unicode duplicate headings resolve; missing files and anchors fail', async (t) => {
  const result = await check(t, {
    'README.md': [
      '[First](docs/a%20b.md#%E4%BD%A0%E5%A5%BD-world)',
      '[Second](docs/a%20b.md#你好-world-1)',
      '[Missing heading](docs/a%20b.md#absent)',
      '[Missing file](docs/missing.md)',
    ].join('\n'),
    'docs/a b.md': '## 你好 `World`!\n## 你好 `World`!\n[Self](#你好-world)\n',
  })
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /missing anchor docs\/a%20b\.md#absent/)
  assert.match(result.output, /missing file docs\/missing\.md/)
  assert.match(result.output, /5 local links checked; 2 errors/)
})

test('reference links, setext headings and explicit anchors work while code examples are ignored', async (t) => {
  const result = await check(t, {
    'README.md': [
      '[Guide][guide]',
      '[Section](docs/guide.md#real)',
      '`[Example](missing-inline.md)`',
      '```md',
      '[Example](missing-fenced.md)',
      '```',
      '[Fake heading](docs/guide.md#fake)',
      '[guide]: <docs/guide.md#real> "Guide"',
    ].join('\n'),
    'docs/guide.md': 'Real\n====\n<a id="custom"></a>\n~~~md\n# Fake\n~~~\n[Explicit](#custom)\n',
    '.gitignore': '.artifacts/\n',
    '.artifacts/ignored.md': '[Ignored](missing-ignored.md)\n',
  })
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /missing anchor docs\/guide\.md#fake/)
  assert.match(result.output, /4 local links checked; 1 errors/)
})

test('query strings and parenthesized paths resolve while malformed escapes fail', async (t) => {
  const result = await check(t, {
    'README.md': '[Query](docs/guide.md?plain=1#guide) [Space](<docs/a b.md>) [Parentheses](docs/a_(b).md) [Invalid](docs/%ZZ.md)\n',
    'docs/guide.md': '# Guide\n',
    'docs/a b.md': '# Space\n',
    'docs/a_(b).md': '# Parentheses\n',
  })
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /invalid local link docs\/%ZZ\.md/)
  assert.match(result.output, /4 local links checked; 1 errors/)
})
