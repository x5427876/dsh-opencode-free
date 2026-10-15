// Compat run core: one DSH version, every Zen free model, through real DSH.
// Everything with a side effect is injected (see `runCompat`), so the whole
// flow is testable without DSH, Zen or a clock. CONTEXT.md: this is the
// compat run, not the plugin's probe.

import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { thinkingLevelMapFor } from '../lib/catalog.js'
import { parseHeadlessOutput, verifyToolEvidence } from './compat-evidence.mjs'

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

  const only = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : undefined
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
    ...(only === undefined ? {} : { model: only }),
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
  const models = live.targets.map(({ id, api }) => ({ id, api, effort: lowestEffort(live.modelsDev[id] ?? {}) }))
  const liveIds = new Set(models.map((model) => model.id))
  if (only !== undefined && !liveIds.has(only)) {
    throw new CompatPreconditionError(
      `--model ${only} is not a free model Zen serves now; choose one of: ${[...liveIds].join(', ')}`,
    )
  }
  const builtinIds = new Set(live.builtinIds)
  const catalogue = {
    error: null,
    onlyLive: models.map((model) => model.id).filter((id) => !builtinIds.has(id)),
    onlyBuiltin: live.builtinIds.filter((id) => !liveIds.has(id)),
    ...live.selection,
  }

  const selected = only === undefined ? models : models.filter((model) => model.id === only)
  const unresolved = (live.selection.unresolved ?? []).filter(row => only === undefined || row.id === only)
  if (selected.length === 0) {
    return await finish({ header, catalogue, warmup: null, models: selected.map(({ id, effort }) => ({ id, effort: effort ?? null, effortNote: NO_LEVELS, keyed: null, tools: null, l0: null, verdict: 'unverified', layer: null, reason: 'official target selection incomplete' })), unverified: selected.map(model => model.id) }, 2, options, deps)
  }
  // The plugin's probe round asks every model that is switched on, so a
  // single-model run switches the others off for the warmup.
  const hidden =
    [...new Set([...live.zenIds, ...live.builtinIds, ...Object.keys(live.modelsDev)])].filter(id => !selected.some(model => model.id === id && model.api !== null))
  const results = []
  let warmup
  try {
    warmup = await warmUp(deps, hidden)
    // Measured 2026-10-03: the first three models in Zen's order stayed 429
    // while the round had just seen five others answer, so the streak rule
    // ended the run before asking any of those five. Models that answered go
    // first, which spends what quota is left where an answer is likely. The
    // streak rule still applies to the rest.
    const answered = (model) => warmup.probe[model.id]?.status === 'ok'
    const ordered = [...selected.filter(answered), ...selected.filter((model) => !answered(model))]
    let streak = 0
    let asked = false
    for (const { id, effort, api } of ordered) {
      const base = { id, effort: effort ?? null, effortNote: effort === undefined ? NO_LEVELS : '', keyed: null, tools: null }
      if (!warmup.ok) {
        results.push({ ...base, verdict: 'unverified', layer: null, reason: 'not run: the warmup failed', l0: null })
        continue
      }
      const probe = warmup.probe[id]
      const l0 = { inPicker: warmup.visible.includes(id), probe: probeRow(probe), pass: warmup.visible.includes(id) && probe?.status === 'ok', code: probe?.code ?? null, http: probe?.http ?? 0 }
      if (api === null) {
        results.push({ ...base, l0, verdict: 'unverified', layer: null, reason: 'unsupported official transport' })
        continue
      }
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
            : 'official free conversational model missing from the DSH catalogue',
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
      let result = { ...base, l0, l1: { pass: verdict.verdict === 'ok', verdict: verdict.verdict, reason: verdict.reason }, verdict: verdict.verdict, layer: verdict.verdict === 'ok' ? 'L1' : 'L0', reason: verdict.reason }
      if (options.tools === true && verdict.verdict === 'ok') result = { ...result, ...(await toolRoundTrip(ask, deps, { model: id, effort })) }
      // Anonymous stays the subject (it is the plugin's promise). A keyed
      // re-run only separates "quota dry or gate changed" from "plugin broken",
      // and sits beside the anonymous verdict instead of replacing it.
      if (key !== undefined && (result.verdict === 'rate-limited' || result.verdict === 'gate-refused')) {
        result = { ...result, keyed: classify(await ask({ model: id, effort, task: L1_TASK, apiKey: key })) }
      }
      streak = result.verdict === 'rate-limited' ? streak + 1 : 0
      if (!l0.pass && result.verdict !== 'plugin-fault') {
        const failure = l0.code === 'quota-exhausted' ? 'rate-limited' : ['anon-gated', 'bad-key'].includes(l0.code) ? 'gate-refused' : l0.code === 'dead' || l0.http >= 500 ? 'upstream-down' : 'unverified'
        result = { ...result, verdict: result.verdict === 'ok' ? failure : result.verdict, reason: `L0 ${l0.probe}${result.reason ? `; ${result.reason}` : ''}` }
      }
      results.push(result)
    }
  } finally {
    await deps.driver.dispose()
  }
  const report = {
    header,
    catalogue,
    warmup: { ok: warmup.ok, error: warmup.error, visible: warmup.visible, runtime: warmup.runtime ?? null, unexpectedTargets: warmup.targets.filter(id => !selected.some(model => model.id === id && model.api !== null)) },
    models: results,
    unverified: results.filter((result) => result.verdict === 'unverified').map((result) => result.id),
  }
  const code = warmup.ok ? exitCodeFor(results) : 1
  return await finish(report, code === 0 && (unresolved.length > 0 || report.warmup.unexpectedTargets.length > 0) ? 2 : code, options, deps)
}

/**
 * Write the report and hand it back. The JSON always lands in the temp
 * directory; only an explicit --out puts anything (matrix and JSON) into the
 * working tree.
 */
async function finish(report, exitCode, options, deps) {
  const full = { ...report, exitCode, acceptance: { scope: report.header.model === undefined ? 'all-official-free-conversational' : 'selected-model', requiredLayers: ['L0', 'L1', ...(report.header.tools ? ['L2-read', 'L2-shell'] : [])], complete: exitCode === 0, fullModelAcceptance: exitCode === 0 && report.header.tools && report.header.model === undefined } }
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
  2: 'incomplete: upstream, selection, scope or verification evidence remains unresolved',
}

/**
 * What the exit code means for this run. A single-model run never says "every
 * model verified": success applies only to the requested scope and layers.
 */
function resultMeaning(report) {
  const { model } = report.header
  if (model === undefined || report.exitCode !== 0) return EXIT_MEANING[report.exitCode]
  const verdict = report.models[0]?.verdict
  return verdict === 'ok'
    ? 'the selected model verified, no plugin-fault'
    : `the selected model was not verified (${verdict}), no plugin-fault`
}

/** The human-readable matrix. Same facts as the JSON, nothing more. */
function renderMatrix(report) {
  const { header } = report
  const lines = [
    `# Compat run: DSH ${header.dshVersion} + dsh-opencode-free ${header.pluginVersion}`,
    '',
    `- Date: ${header.date}`,
    `- OS: ${header.os}`,
    `- Key: ${header.keyed ? 'yes (OPENCODE_API_KEY set; used only for comparison re-runs)' : 'no (anonymous only)'}`,
    `- Tools (L2): ${header.tools ? 'on' : 'off'}`,
    ...(header.model === undefined
      ? []
      : [`- Model: ${header.model} (single-model run: the other free models were not asked)`]),
    `- Path: ${header.path}`,
    `- Result: exit code ${report.exitCode} — ${resultMeaning(report)}`,
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
    if (report.warmup.unexpectedTargets?.length) lines.push(`- Unexpected probe targets: ${report.warmup.unexpectedTargets.map(cell).join(', ')}`)
  }
  lines.push(`- Required layers: ${report.acceptance.requiredLayers.join(', ')}`, `- Full-model L0/L1/L2 acceptance: ${report.acceptance.fullModelAcceptance ? 'passed' : 'not passed'}`)
  for (const source of report.catalogue.sources ?? []) lines.push(`- Source: ${source.url} (${source.at}, ${source.status})`)
  for (const row of report.catalogue.excluded ?? []) lines.push(`- Excluded: ${cell(row.id)} — ${cell(row.reason)}`)
  for (const row of report.catalogue.unresolved ?? []) lines.push(`- Unresolved: ${cell(row.id)} — ${cell(row.reason)}`)
  lines.push(
    '',
    '| model | verdict | layer | effort | L0 probe | L2 tools | with key | reason |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const model of report.models) {
    const effort = model.effort ?? model.effortNote
    const keyed = model.keyed === null ? '-' : model.keyed.reason ? `${model.keyed.verdict}: ${model.keyed.reason}` : model.keyed.verdict
    const step = (name, result) => `${name} ${result.pass ? 'pass' : 'FAIL'}`
    const tools = model.tools === null ? '-' : `${step('read', model.tools.read)}, ${step(model.tools.shell.tool, model.tools.shell)}`
    const cells = [model.id, model.verdict, model.layer ?? '-', effort, model.l0?.probe ?? '-', tools, keyed, model.reason || '-']
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
async function warmUp(deps, hidden) {
  let runtime
  try {
    runtime = await deps.driver.setup()
  } catch (error) {
    return { ok: false, error: `setup: ${describe(error)}`, visible: [], probe: {}, targets: [] }
  }
  try {
    const round = await deps.driver.warmup(hidden === undefined ? undefined : { hidden })
    return { ok: true, error: null, visible: [...round.visible], probe: { ...round.probe?.results }, targets: [...(round.targets ?? [])], runtime }
  } catch (error) {
    return { ok: false, error: `warmup: ${describe(error)}`, visible: [], probe: {}, targets: [] }
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

/** One request with the 429 back-off applied; returns the final verdict and reply. */
async function attempt(ask, sleep, request) {
  const once = async () => {
    const output = await ask(request)
    return { ...classify(output), stdout: output.stdout, evidence: output.evidence, cwd: output.cwd }
  }
  let verdict = await once()
  for (const wait of RATE_LIMIT_BACKOFF_MS) {
    if (verdict.verdict !== 'rate-limited') break
    await sleep(wait)
    verdict = await once()
  }
  return verdict
}

const READ_FILE = 'compat-read.txt'
const SHELL_FILE = 'compat-shell.txt'
const READ_TASK = `Use the read tool to read the file ${READ_FILE} in the working directory, then reply with its exact contents only.`
/**
 * The shell step prints a hash of a nonce file, never the nonce itself: a
 * nonce written into the prompt could be echoed without running anything.
 */
const SHELL_COMMANDS = {
  pwsh: `(Get-FileHash -Algorithm SHA256 ${SHELL_FILE}).Hash.Substring(0,16)`,
  bash: `sha256sum ${SHELL_FILE} | cut -c1-16`,
  // macOS ships shasum, not sha256sum.
  darwin: `shasum -a 256 ${SHELL_FILE} | cut -c1-16`,
}

/**
 * L2: a `read` step and a shell step, judged separately so the report can say
 * which one broke (file reading, or the shell tool-name mapping). Windows DSH
 * only has `pwsh`, elsewhere `bash`. A step that stays 429 is rate-limited;
 * any other miss is a plugin-fault.
 */
async function toolRoundTrip(ask, deps, base) {
  const tool = deps.platform === 'win32' ? 'pwsh' : 'bash'
  const command = deps.platform === 'darwin' ? SHELL_COMMANDS.darwin : SHELL_COMMANDS[tool]
  const readNonce = nonce()
  await deps.sleep(MODEL_SPACING_MS)
  const read = await toolStep(ask, deps.sleep, { ...base, task: READ_TASK, files: { [READ_FILE]: readNonce } }, readNonce, { tool: 'read', file: READ_FILE })
  const shellNonce = nonce()
  const expected = createHash('sha256').update(shellNonce).digest('hex').slice(0, 16)
  const task = `Use the ${tool} tool to run this exact command, then reply with its output only: ${command}`
  await deps.sleep(MODEL_SPACING_MS)
  const shell = { tool, ...(await toolStep(ask, deps.sleep, { ...base, task, files: { [SHELL_FILE]: shellNonce } }, expected, { tool, command })) }
  const tools = { read, shell }
  if (read.pass && shell.pass) return { tools, verdict: 'ok', layer: 'L2', reason: '' }
  const failures = [
    ...(read.pass ? [] : [{ step: 'read step', ...read }]),
    ...(shell.pass ? [] : [{ step: `shell step (${tool})`, ...shell }]),
  ]
  const verdict = failures.some((failure) => failure.verdict === 'plugin-fault') ? 'plugin-fault' : failures[0].verdict
  const reason = failures.map((failure) => `${failure.step}: ${failure.reason}`).join('; ')
  return { tools, verdict, layer: 'L1', reason }
}

async function toolStep(ask, sleep, request, expected, step) {
  const result = await attempt(ask, sleep, request)
  if (result.verdict === 'rate-limited') return { pass: false, verdict: 'rate-limited', reason: result.reason }
  if (result.verdict !== 'ok') return { pass: false, verdict: result.verdict, reason: result.reason }
  const evidence = verifyToolEvidence(result.evidence, { ...step, cwd: result.cwd ?? process.cwd() }, expected)
  const pass = Object.values(evidence).every(Boolean)
  return { pass, verdict: pass ? 'ok' : 'plugin-fault', reason: pass ? '' : 'host tool execution evidence did not match this step', evidence }
}

function nonce() {
  return randomBytes(8).toString('hex')
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
    const evidence = output.format === 'headless-json' ? parseHeadlessOutput(output.stdout) : undefined
    return { ...output, evidence, stdout: scrub(evidence === undefined ? output.stdout : evidence.text), stderr: scrub(output.stderr) }
  }
}

/** Printed in every report so a headless pass is never read as a web UI pass. */
const VERIFICATION_PATH =
  'Isolated DSH_HOME, built-in headless profile plus a --patch overlay (webServer on 127.0.0.1, default model). ' +
  'Same PiAiAdapter -> plugin path as the web profile, but not the profile users run: this is not a web UI verification.'

/** One headless run's output -> one verdict. Only the run's own words are read. */
function classify(output) {
  // A hang is the stream never ending, which is the plugin/DSH side's to explain.
  if (output.timedOut === true) return { verdict: 'plugin-fault', reason: 'no answer within the driver timeout' }
  if (output.exitCode === 0 && output.evidence?.valid === false) return { verdict: 'plugin-fault', reason: 'invalid headless JSON evidence' }
  if (output.exitCode === 0 && output.stdout.trim() !== '') return { verdict: 'ok', reason: '' }
  const line = errorLine(output.stderr)
  if (output.exitCode === 0) return { verdict: 'plugin-fault', reason: 'empty reply' }
  // Classify with the original line in memory, but never persist its content:
  // upstream and tool-validation errors can echo conversations or arguments.
  const reason = line ? failureSummary(line) : `exit code ${output.exitCode} with no error line`
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

const SAFE_DSH_CODES = new Set(['NO_ADAPTER', 'UNKNOWN_MODEL', 'PROVIDER_ERROR', 'AUTH_FAILED', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'INVALID_INPUT'])

/** Allowlisted signals only; truncating or masking a key is not content redaction. */
function failureSummary(line) {
  const code = /^dsh: ([A-Z][A-Z0-9_]+):/.exec(line)?.[1]
  const status = upstreamStatus(line)
  const parts = [code !== undefined && SAFE_DSH_CODES.has(code) ? `dsh: ${code}` : 'DSH failure']
  if (status !== null) parts.push(`HTTP ${status}`)
  if (/\bModel is unavailable\b/i.test(line)) parts.push('Model is unavailable')
  if (/\bEndpoint is unavailable\b/i.test(line)) parts.push('Endpoint is unavailable')
  if (/FreeTierError/.test(line)) parts.push('FreeTierError')
  return parts.join('; ')
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
  if (results.length === 0 || results.some((result) => result.verdict !== 'ok')) return 2
  return 0
}
