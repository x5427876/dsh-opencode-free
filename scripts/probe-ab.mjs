// Opt-in, quota-consuming: A/B the probe's output budget against the live tier.
//
// Run after building: node scripts/probe-ab.mjs [maxTokens-heavy maxTokens-light]
//
// Why this exists: PROBE_MAX_TOKENS is 1024 because an older design read an
// empty completion as "dead" (docs/adr/0002-catalogue-source-of-truth.md). The
// current three-state design does NOT — an empty reply is `inconclusive`, which
// leaves the model in the picker exactly where an `ok` would. So the budget may
// now be paying ~64x the inference quota for a badge colour. That is a claim
// about live behaviour, so it needs live evidence, not reasoning.
//
// This script answers three questions and refuses to answer them by inference:
//   1. does the small budget introduce any error the large one did not have?
//   2. does it actually spend fewer OUTPUT TOKENS?   <- the primary gate
//   3. does a known-dead model still read as dead under the small budget?
//
// Gate 2 is primary because that is the whole claimed benefit. The first run of
// this script measured WALL CLOCK and reported "no difference" — which turned
// out to say nothing: a few hundred tokens cannot be resolved inside a
// 490–1441 ms spread dominated by time-to-first-token and queueing on a shared
// bucket. pi-ai already requests `stream_options.include_usage` and hands the
// parsed usage over, so the number that answers the question was available all
// along and was being discarded.
//
// A control model (dead, credential-independent) is the third gate: a lighter
// probe that cannot still see a corpse is not lighter, it is blind.
//
// It deliberately uses the REAL catalogue and the REAL provider path, so each
// model is asked on the channel the catalogue pinned it to. A synthetic model
// record would test the wrong channel and prove nothing.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCatalog } from '../lib/catalog.js'
import {
  builtinFreeModels,
  builtinKnownApis,
  catalogTemplate,
  fetchZenModelIds,
  probeModel,
  zenProvider,
} from '../lib/zen-provider.js'

const heavy = Number(process.argv[2] ?? 1024)
const light = Number(process.argv[3] ?? 16)
const CONTROL = 'deepseek-v4-flash-free'

/** Model-level refusal: the only readings that may ever remove a model. */
const GONE = new Set(['dead'])
const dir = await mkdtemp(join(tmpdir(), 'probe-ab-'))
// Same fallback apply() uses: catalogTemplate() pins one named record, and pi-ai
// renames its builtin set, so a miss must not take the whole run down.
const template = catalogTemplate() ?? builtinFreeModels()[0]
if (template === undefined) throw new Error('no builtin free record to use as a template')
const catalog = createCatalog({
  template,
  builtinBaseline: builtinFreeModels(),
  knownApis: builtinKnownApis(),
  cachePath: join(dir, 'catalog.json'),
  fetchImpl: (url, init) => fetch(url, init),
  listZenIds: async () => await fetchZenModelIds(fetch),
})

console.error('fetching the live catalogue (5.2MB, once)...')
await catalog.forceRefresh()
const all = catalog.effectiveModels()
console.error(`catalogue: ${all.length} models after the Zen gate`)
if (!all.length) throw new Error('empty catalogue; the tier answered nothing')

/* Optional third argument: a comma-separated subset of model ids.
   Every run costs real requests against a shared bucket, so a question that only
   a few models can answer should be asked of those models. The control is added
   back automatically — a run that cannot see a corpse proves nothing. */
const only = (process.argv[4] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '')
const models = only.length === 0 ? all : all.filter((m) => only.includes(m.id) || m.id === CONTROL)
const skipped = only.length === 0 ? 0 : only.filter((id) => !all.some((m) => m.id === id))
if (only.length > 0) {
  console.error(`restricted to ${models.length} models: ${models.map((m) => m.id).join(', ')}`)
  if (skipped.length) console.error(`WARNING not in the catalogue, ignored: ${skipped.join(', ')}`)
}

const provider = zenProvider()

async function run(model, maxTokens) {
  const started = Date.now()
  const outcome = await probeModel(model, { provider, apiKey: 'public', maxTokens })
  return { ...outcome, ms: Date.now() - started }
}

const rows = []
const gone = (r) => GONE.has(r.kind) || (typeof r.http === 'number' && r.http >= 400)
const said = (r) => (typeof r.code === 'string' && r.code !== '' ? r.code : r.kind)
const outputOf = (r) => (typeof r.usage?.output === 'number' ? r.usage.output : undefined)
const median = (xs) =>
  xs.length === 0 ? undefined : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

for (const model of models) {
  const h = await run(model, heavy)
  const l = await run(model, light)
  rows.push({ id: model.id, heavy: h, light: l })
  console.error(
    `  ${model.id.padEnd(30)} heavy ${h.kind}/${h.code ?? '-'} ${String(h.http)} ${String(h.ms).padStart(6)}ms out=${outputOf(h) ?? '?'}` +
      `   light ${l.kind}/${l.code ?? '-'} ${String(l.http)} ${String(l.ms).padStart(6)}ms out=${outputOf(l) ?? '?'}`,
  )
}

console.log(
  JSON.stringify({
    heavy,
    light,
    rows: rows.map((r) => ({
      id: r.id,
      heavy: said(r.heavy),
      light: said(r.light),
      httpHeavy: r.heavy.http,
      httpLight: r.light.http,
      msHeavy: r.heavy.ms,
      msLight: r.light.ms,
      outHeavy: outputOf(r.heavy) ?? null,
      outLight: outputOf(r.light) ?? null,
    })),
  }),
  null,
  2,
)

// ── the adoption gates ──────────────────────────────────────────────────────
const regressions = rows.filter((r) => !gone(r.heavy) && gone(r.light))
/* The gate that was MISSING the first two times this ran, and the reason the
   token median could not be trusted on its own.

   `gone()` only recognises dead and 4xx, so a model that answered under the
   heavy budget and fell to `inconclusive` under the light one passed every
   gate — while reporting no usage, which is what made the median look good.
   A budget that makes the two most expensive models stop answering has not
   saved tokens; it has traded tokens for blindness on exactly the models that
   cost most. Measured 2026-09-30: muse-spark 1.2 and 1.3 answered at 1024
   (158 and 69 output tokens) and returned `unknown` with no usage at 16. */
const silenced = rows.filter((r) => r.heavy.kind === 'ok' && r.light.kind !== 'ok')
const heavyOut = rows.map((r) => outputOf(r.heavy)).filter((n) => typeof n === 'number')
const lightOut = rows.map((r) => outputOf(r.light)).filter((n) => typeof n === 'number')
const speedup = rows.map((r) => r.heavy.ms / Math.max(1, r.light.ms))
const control = rows.find((r) => r.id === CONTROL)
const droppedUsage = rows.filter(
  (r) => typeof outputOf(r.heavy) === 'number' && outputOf(r.light) === undefined,
).length
const gates = [
  {
    name: 'light introduces no error the heavy budget did not have',
    pass: regressions.length === 0 || only.length > 0,
    detail:
      (regressions.map((r) => `${r.id}: heavy=${said(r.heavy)} light=${said(r.light)}`).join('; ') ||
        'none') + (only.length > 0 ? '   (not gating: a restricted run is a spot check, not a verdict)' : ''),
  },
  {
    name: 'every model that answered at 1024 still answers at 16',
    pass: silenced.length === 0 || only.length > 0,
    detail:
      (silenced.length === 0
        ? 'no answer lost'
        : silenced
            .map(
              (r) =>
                `${r.id} ${said(r.heavy)}→${said(r.light)} (out ${outputOf(r.heavy) ?? '?'}→${outputOf(r.light) ?? 'none'})`,
            )
            .join('; ')) +
      (only.length > 0 ? '   (not gating: a restricted run is a spot check, not a verdict)' : ''),
  },
  {
    name: `output tokens drop (median ${median(heavyOut) ?? '?'} -> ${median(lightOut) ?? '?'})`,
    // Secondary, and only meaningful once the gate above is clean: a median can
    // be improved simply by the expensive models falling out of the sample.
    pass: heavyOut.length >= 4 && lightOut.length >= 4 && median(lightOut) < median(heavyOut) * 0.8,
    detail: `paired: ${rows
      .filter((r) => typeof outputOf(r.heavy) === 'number' && typeof outputOf(r.light) === 'number')
      .map((r) => `${outputOf(r.heavy)}→${outputOf(r.light)}`)
      .join(
        ' ',
      )}  (n=${heavyOut.length}/${lightOut.length} reported usage; ${droppedUsage} answered heavy but not light)`,
  },
  {
    name: `control ${CONTROL} still reads dead under the light budget`,
    pass: control === undefined ? 'absent' : gone(control.light),
    detail:
      control === undefined
        ? 'not in the catalogue today'
        : `heavy=${said(control.heavy)} light=${said(control.light)}`,
  },
]

console.error('\nadoption gates')
for (const g of gates)
  console.error(
    `  [${g.pass === true ? 'PASS' : g.pass === 'absent' ? 'SKIP' : 'FAIL'}] ${g.name}\n         ${g.detail}`,
  )
console.error(
  `\nwall clock, secondary: median speedup ${median(speedup) === undefined ? '?' : median(speedup).toFixed(2)}x`,
)
const allPass = gates.every((g) => g.pass === true || g.pass === 'absent')
console.error(
  `\n${allPass ? 'GATES PASS' : 'GATES FAIL'} — ${allPass ? 'safe to lower the budget' : 'keep PROBE_MAX_TOKENS as is'}`,
)
process.exitCode = allPass ? 0 : 1
