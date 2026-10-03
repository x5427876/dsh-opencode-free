// Compat run core: one DSH version, every Zen free model, through real DSH.
// Everything with a side effect is injected (see `runCompat`), so the whole
// flow is testable without DSH, Zen or a clock. CONTEXT.md: this is the
// compat run, not the plugin's probe.

import { isFree } from '../lib/catalog.js'

/** A precondition failed: nothing was installed and no request was sent. */
export class CompatPreconditionError extends Error {}

/** The peers whose exact pin names the one DSH release a plugin release supports. */
const DSH_PEERS = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai']

export async function runCompat(options, deps) {
  const dsh = typeof options?.dsh === 'string' ? options.dsh.trim() : ''
  if (dsh === '') throw new CompatPreconditionError('--dsh <version> is required; there is no default version')
  // DSH skips a plugin whose peer pin does not match, so any other version
  // would only spend quota on a run that can never load the plugin.
  const peers = deps.pkg.peerDependencies ?? {}
  const mismatched = DSH_PEERS.filter((name) => peers[name] !== dsh)
  if (mismatched.length > 0) {
    const pins = mismatched.map((name) => `${name}@${peers[name] ?? '(missing)'}`).join(', ')
    throw new CompatPreconditionError(
      `package.json pins ${pins}, not DSH ${dsh}; DSH would skip this plugin. Update the peer pin first.`,
    )
  }

  const header = {
    dshVersion: dsh,
    pluginVersion: deps.pkg.version,
    date: deps.now().toISOString(),
    os: deps.osLabel,
    keyed: false,
    tools: options.tools === true,
    path: VERIFICATION_PATH,
  }
  const live = await deps.catalogue()
  const models = live.zenIds.filter((id) => live.modelsDev[id] !== undefined && isFree(live.modelsDev[id]))

  const results = []
  await deps.driver.setup()
  try {
    for (const id of models) {
      const output = await deps.driver.run({ model: id, task: L1_TASK })
      const verdict = classify(output)
      results.push({ id, verdict: verdict.verdict, layer: verdict.verdict === 'ok' ? 'L1' : null, reason: verdict.reason })
    }
  } finally {
    await deps.driver.dispose()
  }
  const report = { header, models: results }
  return { report, exitCode: exitCodeFor(results) }
}

const L1_TASK = 'Reply with OK only.'

/** Printed in every report so a headless pass is never read as a web UI pass. */
const VERIFICATION_PATH =
  'Isolated DSH_HOME, built-in headless profile plus a --patch overlay (webServer on 127.0.0.1, default model). ' +
  'Same PiAiAdapter -> plugin path as the web profile, but not the profile users run: this is not a web UI verification.'

/** One headless run's output -> one verdict. Only the run's own words are read. */
function classify(output) {
  if (output.exitCode === 0 && output.stdout.trim() !== '') return { verdict: 'ok', reason: '' }
  const line = errorLine(output.stderr)
  if (output.exitCode === 0) return { verdict: 'plugin-fault', reason: 'empty reply' }
  return { verdict: 'plugin-fault', reason: line || `exit code ${output.exitCode} with no error line` }
}

/** The last `dsh: CODE: message` line, which is where DSH reports a failed run. */
function errorLine(stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^dsh: [A-Z][A-Z0-9_]+:/.test(line))
  return lines.at(-1) ?? ''
}

function exitCodeFor(results) {
  if (results.some((result) => result.verdict === 'plugin-fault')) return 1
  return 0
}
