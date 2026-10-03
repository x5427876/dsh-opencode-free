// Compat run core: one DSH version, every Zen free model, through real DSH.
// Everything with a side effect is injected (see `runCompat`), so the whole
// flow is testable without DSH, Zen or a clock. CONTEXT.md: this is the
// compat run, not the plugin's probe.

import { isFree, thinkingLevelMapFor } from '../lib/catalog.js'

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
  let live
  try {
    live = await deps.catalogue()
  } catch (error) {
    // No silent fallback to the builtin list: that would verify yesterday's
    // models and call it today's answer. Nothing ran, so the run is unfinished.
    const report = {
      header,
      catalogue: { error: describe(error), onlyLive: [], onlyBuiltin: [] },
      models: [],
      unverified: [],
    }
    return { report, exitCode: 2 }
  }
  const models = live.zenIds
    .filter((id) => live.modelsDev[id] !== undefined && isFree(live.modelsDev[id]))
    .map((id) => ({ id, effort: lowestEffort(live.modelsDev[id]) }))
  const liveIds = new Set(models.map((model) => model.id))
  const builtinIds = new Set(live.builtinIds)
  const catalogue = {
    error: null,
    onlyLive: models.map((model) => model.id).filter((id) => !builtinIds.has(id)),
    onlyBuiltin: live.builtinIds.filter((id) => !liveIds.has(id)),
  }

  const results = []
  await deps.driver.setup()
  try {
    let streak = 0
    for (const [index, { id, effort }] of models.entries()) {
      const base = { id, effort: effort ?? null, effortNote: effort === undefined ? NO_LEVELS : '' }
      if (streak >= RATE_LIMIT_STREAK) {
        results.push({ ...base, verdict: 'unverified', layer: null, reason: `not run: ${RATE_LIMIT_STREAK} models in a row were rate-limited` })
        continue
      }
      if (index > 0) await deps.sleep(MODEL_SPACING_MS)
      const verdict = await attempt(deps, { model: id, effort, task: L1_TASK })
      results.push({ ...base, verdict: verdict.verdict, layer: verdict.verdict === 'ok' ? 'L1' : null, reason: verdict.reason })
      streak = verdict.verdict === 'rate-limited' ? streak + 1 : 0
    }
  } finally {
    await deps.driver.dispose()
  }
  const report = {
    header,
    catalogue,
    models: results,
    unverified: results.filter((result) => result.verdict === 'unverified').map((result) => result.id),
  }
  return { report, exitCode: exitCodeFor(results) }
}

const L1_TASK = 'Reply with OK only.'
const NO_LEVELS = 'no published levels (無等級可選)'
/** Lowest first; `off` is not a level, it sends no reasoning at all. */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The lowest effort models.dev publishes for this model, read through the
 * plugin's own mapping so the run asks for exactly what the picker offers.
 * `undefined` for a toggle model or one with no list: the default is used.
 */
function lowestEffort(record) {
  const map = thinkingLevelMapFor(record)
  if (map === undefined) return undefined
  return EFFORT_ORDER.find((level) => typeof map[level] === 'string')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
const MODEL_SPACING_MS = 3_000
/** Waits before each retry of a 429; one retry per entry. */
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000]
/** This many rate-limited models in a row means the bucket is dry: stop spending. */
const RATE_LIMIT_STREAK = 3

/** One request with the 429 back-off applied; returns the final verdict. */
async function attempt(deps, request) {
  let verdict = classify(await deps.driver.run(request))
  for (const wait of RATE_LIMIT_BACKOFF_MS) {
    if (verdict.verdict !== 'rate-limited') break
    await deps.sleep(wait)
    verdict = classify(await deps.driver.run(request))
  }
  return verdict
}

/** Printed in every report so a headless pass is never read as a web UI pass. */
const VERIFICATION_PATH =
  'Isolated DSH_HOME, built-in headless profile plus a --patch overlay (webServer on 127.0.0.1, default model). ' +
  'Same PiAiAdapter -> plugin path as the web profile, but not the profile users run: this is not a web UI verification.'

/** One headless run's output -> one verdict. Only the run's own words are read. */
function classify(output) {
  if (output.exitCode === 0 && output.stdout.trim() !== '') return { verdict: 'ok', reason: '' }
  const line = errorLine(output.stderr)
  if (output.exitCode === 0) return { verdict: 'plugin-fault', reason: 'empty reply' }
  const reason = line || `exit code ${output.exitCode} with no error line`
  const status = upstreamStatus(line)
  if (status === 429 || /^dsh: RATE_LIMIT:/.test(line)) return { verdict: 'rate-limited', reason }
  // Before the status checks: Ling's "Endpoint is unavailable" arrives as a 400.
  if (UPSTREAM_DOWN_PATTERN.test(line) || (status !== null && status >= 500)) return { verdict: 'upstream-down', reason }
  if (status === 401 || status === 403) return { verdict: 'gate-refused', reason }
  return { verdict: 'plugin-fault', reason }
}

const UPSTREAM_DOWN_PATTERN = /\b(?:Model|Endpoint) is unavailable\b/i

/** The upstream HTTP status the plugin's guidance appends, e.g. `（上游 HTTP 429）`. */
function upstreamStatus(line) {
  const match = /\bHTTP (\d{3})\b/.exec(line)
  return match === null ? null : Number(match[1])
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
  // "Not broken, but not finished: run again later" (ADR 0003).
  if (results.some((result) => result.verdict === 'rate-limited' || result.verdict === 'unverified')) return 2
  return 0
}
