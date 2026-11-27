// Moves the exact DSH pin to <version> in every file that names it (standards C1)
// and lets the new DSH packages through pnpm's release-age gate. Dated
// measurements elsewhere keep the version they ran on. The adapter's pi-ai
// range and other peers are not touched: they need a reading of the new
// manifests (see docs/release.md).
import { readFileSync, writeFileSync } from 'node:fs'

const PINNED = ['package.json', 'README.md', 'README.zh-TW.md', 'AGENTS.md', 'docs/compat-run.md', 'src/index.ts']
const WORKSPACE = 'pnpm-workspace.yaml'
const VERSION = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i

function main() {
  const version = process.argv[2] ?? ''
  if (!VERSION.test(version)) throw Object.assign(new Error('Usage: node scripts/dsh-bump.mjs <exact DSH version>'), { exitCode: 2 })
  const pin = JSON.parse(readFileSync('package.json', 'utf8')).peerDependencies?.['@deepseek-ai/dsh-llm']
  if (typeof pin !== 'string' || !VERSION.test(pin)) throw Object.assign(new Error('package.json does not pin one exact DSH version.'), { exitCode: 2 })
  if (pin === version) throw Object.assign(new Error(`DSH is already pinned to ${version}.`), { exitCode: 2 })

  const files = new Map(PINNED.map(name => [name, readFileSync(name, 'utf8')]))
  for (const [name, text] of files) {
    if (!text.includes(pin)) throw Object.assign(new Error(`${name} does not name the pinned DSH ${pin}.`), { exitCode: 2 })
    files.set(name, text.split(pin).join(version))
  }
  const workspace = readFileSync(WORKSPACE, 'utf8').split('\n')
    .map(line => line.includes(`'@deepseek-ai/dsh-`) && line.endsWith(`${pin}'`) ? `${line.slice(0, -1)} || ${version}'` : line)
    .join('\n')
  for (const [name, text] of files) writeFileSync(name, text)
  writeFileSync(WORKSPACE, workspace)
  console.log(`DSH pin moved from ${pin} to ${version}.`)
}

try {
  main()
} catch (error) {
  console.error(error.exitCode ? error.message : `DSH bump failed: ${error.message}`)
  process.exitCode = 2
}
