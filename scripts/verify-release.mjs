import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const repository = 'x5427876/dsh-opencode-free'
const github = `https://api.github.com/repos/${repository}`

function refuse(message, exitCode = 1) {
  const error = new Error(message)
  error.exitCode = exitCode
  throw error
}

async function metadata(url, label) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
  } catch {
    refuse(`${label}: query failed (network or timeout); state is unverified.`, 2)
  }
  if (response.status === 404) refuse(`${label}: not found.`)
  if (!response.ok) refuse(`${label}: HTTP ${response.status}; state is unverified.`, 2)
  try {
    const value = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    refuse(`${label}: invalid metadata; state is unverified.`, 2)
  }
}

async function main() {
  let values
  try {
    values = parseArgs({ options: { version: { type: 'string' }, commit: { type: 'string' }, asset: { type: 'string' } } }).values
  } catch {
    refuse('Usage: pnpm verify:release --version <version> --commit <full-sha> --asset <tarball>', 2)
  }
  const { version, commit, asset } = values
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version ?? '') || !/^[a-f\d]{40}$/i.test(commit ?? '') || !asset) {
    refuse('Usage: pnpm verify:release --version <version> --commit <full-sha> --asset <tarball>', 2)
  }
  let bytes, manifest
  try {
    bytes = readFileSync(asset)
    manifest = JSON.parse(execFileSync('tar', ['-xOf', '-', 'package/package.json'], {
      input: bytes, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    }))
  } catch {
    refuse('Cannot read the local tarball manifest; check the asset and tar installation.', 2)
  }
  if (manifest?.name !== 'dsh-opencode-free' || manifest.version !== version) refuse('Local tarball package/version mismatch.')
  const dsh = manifest.peerDependencies?.['@deepseek-ai/dsh-llm']
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(dsh ?? '')) refuse('Local tarball must pin one exact DSH version.')
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  const tagName = `v${version}`
  const ref = await metadata(`${github}/git/ref/tags/${tagName}`, 'GitHub tag')
  if (ref.ref !== `refs/tags/${tagName}` || ref.object?.type !== 'tag' || !/^[a-f\d]{40}$/.test(ref.object?.sha ?? '')) {
    refuse('Remote tag must be annotated.')
  }
  const tag = await metadata(`${github}/git/tags/${ref.object.sha}`, 'GitHub annotated tag')
  if (tag.tag !== tagName || tag.object?.type !== 'commit' || tag.object?.sha !== commit.toLowerCase()) refuse('Remote tag commit mismatch.')
  const release = await metadata(`${github}/releases/tags/${tagName}`, 'GitHub Release')
  if (release.tag_name !== tagName || release.draft !== false || !release.published_at) refuse('GitHub Release is not published for this tag.')
  if (release.prerelease !== version.includes('-')) refuse('GitHub Release stable/prerelease status mismatch.')
  const host = dsh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const support = new RegExp(`\\b(?:Supports|Requires) DeepSeek Harness\\s+${host}(?![\\w.+-])`, 'i')
  if (typeof release.body !== 'string' || !support.test(release.body.replace(/[`*]/g, ''))) refuse('Release notes must state the exact supported DSH version.')
  const assets = Array.isArray(release.assets) ? release.assets.filter((entry) => entry.name === `dsh-opencode-free-${version}.tgz`) : []
  if (assets.length !== 1 || assets[0].state !== 'uploaded') refuse('Release tarball is missing, duplicated or not uploaded.')
  if (!/^sha256:[a-f\d]{64}$/.test(assets[0].digest ?? '')) refuse('Release asset digest unavailable; state is unverified.', 2)
  if (assets[0].digest !== digest) refuse('Release asset SHA-256 mismatch.')
  const npm = await metadata(`https://registry.npmjs.org/dsh-opencode-free/${version}`, 'npm version')
  if (npm.name !== 'dsh-opencode-free' || npm.version !== version) refuse('npm package/version mismatch.')
  console.log(`Release ${tagName} verified: annotated tag ${commit.toLowerCase()}, DSH ${dsh}, asset SHA-256 matches; npm ${version} available (metadata only).`)
  console.log(`https://github.com/${repository}/releases/tag/${tagName}`)
}

try {
  await main()
} catch (error) {
  console.error(error.exitCode ? error.message : 'Release verification could not finish; state is unverified.')
  process.exitCode = error.exitCode ?? 2
}
