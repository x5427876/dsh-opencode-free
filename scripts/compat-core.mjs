// Compat run core: one DSH version, every Zen free model, through real DSH.
// Everything with a side effect is injected (see `runCompat`), so the whole
// flow is testable without DSH, Zen or a clock. CONTEXT.md: this is the
// compat run, not the plugin's probe.

import { join } from 'node:path'
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

  // Detected, never an option: a key on the command line ends up in shell history.
  const key = deps.env.OPENCODE_API_KEY?.trim() || undefined
  const ask = redactingDriver(deps.driver, key)
  const header = {
    dshVersion: dsh,
    pluginVersion: deps.pkg.version,
    date: deps.now().toISOString(),
    os: deps.osLabel,
    keyed: key !== undefined,
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
      warmup: null,
      models: [],
      unverified: [],
    }
    return await finish(report, 2, options, deps)
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
  let warmup
  try {
    warmup = await warmUp(deps)
    let streak = 0
    let asked = false
    for (const { id, effort } of models) {
      const base = { id, effort: effort ?? null, effortNote: effort === undefined ? NO_LEVELS : '', keyed: null }
      if (!warmup.ok) {
        results.push({ ...base, verdict: 'unverified', layer: null, reason: 'not run: the warmup failed', l0: null })
        continue
      }
      const l0 = { inPicker: warmup.visible.includes(id), probe: probeRow(warmup.probe[id]) }
      if (!l0.inPicker) {
        // Zen lists it but the picker does not offer it. The plugin drops a
        // model only on a `dead` probe verdict, which upstream has to earn.
        const dead = warmup.probe[id]?.code === 'dead'
        results.push({
          ...base,
          l0,
          verdict: dead ? 'upstream-down' : 'plugin-fault',
          layer: null,
          reason: dead
            ? `warmup probe judged it dead: ${l0.probe}`
            : 'listed by Zen and free on models.dev, but missing from the DSH picker',
        })
        continue
      }
      if (streak >= RATE_LIMIT_STREAK) {
        results.push({ ...base, l0, verdict: 'unverified', layer: 'L0', reason: `not run: ${RATE_LIMIT_STREAK} models in a row were rate-limited` })
        continue
      }
      if (asked) await deps.sleep(MODEL_SPACING_MS)
      asked = true
      const verdict = await attempt(ask, deps.sleep, { model: id, effort, task: L1_TASK })
      // Anonymous stays the subject (it is the plugin's promise). A keyed
      // re-run only separates "quota dry or gate changed" from "plugin broken",
      // and sits beside the anonymous verdict instead of replacing it.
      const keyed =
        key !== undefined && (verdict.verdict === 'rate-limited' || verdict.verdict === 'gate-refused')
          ? classify(await ask({ model: id, effort, task: L1_TASK, apiKey: key }))
          : null
      results.push({ ...base, l0, verdict: verdict.verdict, layer: verdict.verdict === 'ok' ? 'L1' : 'L0', reason: verdict.reason, keyed })
      streak = verdict.verdict === 'rate-limited' ? streak + 1 : 0
    }
  } finally {
    await deps.driver.dispose()
  }
  const report = {
    header,
    catalogue,
    warmup: { ok: warmup.ok, error: warmup.error, visible: warmup.visible },
    models: results,
    unverified: results.filter((result) => result.verdict === 'unverified').map((result) => result.id),
  }
  return await finish(report, warmup.ok ? exitCodeFor(results) : 1, options, deps)
}

/**
 * Write the report and hand it back. The JSON always lands in the temp
 * directory; only an explicit --out puts anything (matrix and JSON) into the
 * working tree.
 */
async function finish(report, exitCode, options, deps) {
  const full = { ...report, exitCode }
  const text = renderMatrix(full)
  const json = `${JSON.stringify(full, null, 2)}\n`
  const stem = `compat-${full.header.dshVersion}-${full.header.date.slice(0, 10)}`
  const files = []
  if (typeof options.out === 'string' && options.out !== '') {
    files.push(join(options.out, `${stem}.md`))
    await deps.writeFile(files.at(-1), text)
    files.push(join(options.out, `${stem}.json`))
    await deps.writeFile(files.at(-1), json)
  } else {
    files.push(join(deps.tmpDir, `${stem}.json`))
    await deps.writeFile(files.at(-1), json)
  }
  return { report: full, exitCode, text, files }
}

const EXIT_MEANING = {
  0: 'every model verified, no plugin-fault',
  1: 'plugin-fault (or the setup/warmup failed): something on the plugin or DSH side needs fixing',
  2: 'not broken, but not finished: rate-limited or unverified models remain, run again later',
}

/** The human-readable matrix. Same facts as the JSON, nothing more. */
export function renderMatrix(report) {
  const { header } = report
  const lines = [
    `# Compat run: DSH ${header.dshVersion} + dsh-opencode-free ${header.pluginVersion}`,
    '',
    `- Date: ${header.date}`,
    `- OS: ${header.os}`,
    `- Key: ${header.keyed ? 'yes (OPENCODE_API_KEY set; used only for comparison re-runs)' : 'no (anonymous only)'}`,
    `- Tools (L2): ${header.tools ? 'on' : 'off'}`,
    `- Path: ${header.path}`,
    `- Result: exit code ${report.exitCode} — ${EXIT_MEANING[report.exitCode]}`,
    '',
  ]
  if (report.catalogue.error !== null) {
    lines.push(`Live catalogue unavailable, nothing was verified: ${report.catalogue.error}`, '')
  } else {
    lines.push(
      `- Live only (not in the builtin list): ${report.catalogue.onlyLive.join(', ') || '(none)'}`,
      `- Builtin only (not in the live list): ${report.catalogue.onlyBuiltin.join(', ') || '(none)'}`,
    )
  }
  if (report.warmup !== null) {
    lines.push(`- Warmup: ${report.warmup.ok ? 'ok' : `FAILED — ${report.warmup.error}`}`)
  }
  lines.push('', '| model | verdict | layer | effort | L0 probe | with key | reason |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const model of report.models) {
    const effort = model.effort ?? model.effortNote
    const keyed = model.keyed === null ? '-' : model.keyed.reason ? `${model.keyed.verdict}: ${model.keyed.reason}` : model.keyed.verdict
    const cells = [model.id, model.verdict, model.layer ?? '-', effort, model.l0?.probe ?? '-', keyed, model.reason || '-']
    lines.push(`| ${cells.map(cell).join(' | ')} |`)
  }
  lines.push('', `Unverified: ${report.unverified.join(', ') || '(none)'}`, '')
  return lines.join('\n')
}

/** A table cell: no pipes or line breaks from upstream text. */
function cell(value) {
  return String(value).replaceAll('|', '\\|').replace(/\s*\r?\n\s*/g, ' ')
}

/**
 * Install, then let the plugin's own probe round run exactly once. Its result
 * is the L0 data, and because the plugin records the round, the per-model
 * processes that follow do not start another one (one round per local day).
 * A failure here is never a quiet pass: nothing is verified and the run fails.
 */
async function warmUp(deps) {
  try {
    await deps.driver.setup()
  } catch (error) {
    return { ok: false, error: `setup: ${describe(error)}`, visible: [], probe: {} }
  }
  try {
    const round = await deps.driver.warmup()
    return { ok: true, error: null, visible: [...round.visible], probe: { ...round.probe?.results } }
  } catch (error) {
    return { ok: false, error: `warmup: ${describe(error)}`, visible: [], probe: {} }
  }
}

/** One probe-round row (the plugin's panel shape) as report text. */
function probeRow(row) {
  if (row === undefined) return 'not probed'
  if (row.status === 'ok') return 'ok'
  return `failed: ${row.code ?? 'unknown'}${row.http ? ` (HTTP ${row.http})` : ''}`
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
async function attempt(ask, sleep, request) {
  let verdict = classify(await ask(request))
  for (const wait of RATE_LIMIT_BACKOFF_MS) {
    if (verdict.verdict !== 'rate-limited') break
    await sleep(wait)
    verdict = classify(await ask(request))
  }
  return verdict
}

/**
 * The driver, with the key scrubbed from everything it returns. Upstream error
 * text is not safe by default (S2), and a key echoed in it would otherwise
 * reach the reason column. Replaced, not truncated: truncation is not
 * redaction (S1).
 */
function redactingDriver(driver, key) {
  const scrub = (text) => {
    let out = String(text ?? '')
    if (key !== undefined) out = out.replaceAll(key, '***')
    return out.replace(/\bBearer\s+(?!public\b)\S+/gi, 'Bearer ***')
  }
  return async (request) => {
    const output = await driver.run(request)
    return { ...output, stdout: scrub(output.stdout), stderr: scrub(output.stderr) }
  }
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
