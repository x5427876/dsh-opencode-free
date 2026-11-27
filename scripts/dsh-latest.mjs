// Answers whether DSH's npm `latest` is newer than this package's exact peer pin.
// Prints `none` or `bump <version>`; any failure exits 2 with nothing on stdout,
// so a broken query is never read as "no new version".
import { readFileSync } from 'node:fs'

const DIST_TAGS = 'https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags'
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([\da-z.-]+))?$/i

function unverified(message) {
  const error = new Error(`${message}; DSH latest is unverified.`)
  error.exitCode = 2
  throw error
}

function parse(version) {
  const match = VERSION.exec(version)
  if (!match) return undefined
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] }
}

// Semver precedence: a release outranks its prereleases; numeric identifiers
// compare as numbers and rank below alphanumeric ones.
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const [x, y] = [a.pre[i], b.pre[i]]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)]
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

async function latest() {
  let response
  try {
    response = await fetch(DIST_TAGS, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
  } catch {
    unverified('npm query failed (network or timeout)')
  }
  if (!response.ok) unverified(`npm answered HTTP ${response.status}`)
  let tags
  try {
    tags = await response.json()
  } catch {
    unverified('npm returned invalid metadata')
  }
  const version = tags?.latest
  if (typeof version !== 'string' || !parse(version)) unverified('npm metadata has no valid latest version')
  return version
}

async function main() {
  const pin = JSON.parse(readFileSync('package.json', 'utf8')).peerDependencies?.['@deepseek-ai/dsh-llm']
  if (typeof pin !== 'string' || !parse(pin)) unverified('package.json does not pin one exact DSH version')
  const version = await latest()
  console.log(compare(parse(version), parse(pin)) > 0 ? `bump ${version}` : 'none')
}

try {
  await main()
} catch (error) {
  console.error(error.exitCode ? error.message : 'DSH latest check could not finish; DSH latest is unverified.')
  process.exitCode = 2
}
