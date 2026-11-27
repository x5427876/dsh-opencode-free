import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = fileURLToPath(new URL('..', import.meta.url))
const STATIC = ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh-TW.md', 'AGENTS.md', 'LICENSE', 'src/client.js']

// Packs a copy of the package, so building it never races tests that load lib/.
async function packedFiles(t, stale) {
  const root = await mkdtemp(join(tmpdir(), 'opf-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of [...STATIC, 'tsconfig.json', 'src']) await cp(join(repo, name), join(root, name), { recursive: true })
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  for (const [name, content] of Object.entries(stale)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), content)
  }
  const run = spawnSync('pnpm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const json = run.stdout.slice(run.stdout.indexOf('{'))
  return JSON.parse(json).files.map(file => file.path).sort()
}

test('the tarball holds the build of the current sources and the static files, nothing left over', async (t) => {
  const modules = (await readdir(join(repo, 'src'))).filter(name => name.endsWith('.ts')).map(name => name.slice(0, -3))
  const expected = [
    ...STATIC,
    ...modules.flatMap(name => [`lib/${name}.js`, `lib/types/${name}.d.ts`]),
  ].sort()
  const files = await packedFiles(t, {
    'lib/zen.js': 'export {}\n',
    'lib/types/zen.d.ts': 'export {}\n',
  })
  assert.deepEqual(files, expected)
})
