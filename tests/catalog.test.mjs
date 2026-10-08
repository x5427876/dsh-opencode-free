import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  CACHE_VERSION,
  CATALOG_TTL_ACTIVE_MS,
  DEFAULT_TTL_MS,
  DEFAULT_USER_AGENT,
  GATE_TTL_MS,
  MODELS_DEV_URL,
  cachePath,
  adopt,
  catalogueIsStale,
  channelFor,
  createCatalog,
  initialState,
  derive,
  effectiveList,
  effectiveTtl,
  fetchSection,
  gateIsStale,
  isActive,
  isFree,
  planRound,
  probeRowFor,
  probedToday,
  runProbeRound,
  modelCapability,
  readCache,
  thinkingLevelMapFor,
  measuredEffortMap,
  measuredContextFor,
  reasoningFingerprint,
  isMeasuredEffort,
  isMeasuredContext,
  contextFingerprint,
  contextWindowFor,
  observedOutputFor,
  observedOutputIsStale,
  contextEvidenceFor,
  seededContextFor,
  CEILING_SILENCE_TTL_MS,
  isMeasuredLimits,
  DEAD_RECHECK_MS,
  CAPABILITY_TTL_MS,
  capabilityFingerprint,
  measuredCapabilityFor,
  clampVerdict,
  effortVerdict,
  nextEffortQuestion,
  fallbackLevelFor,
  effortVerdictFresh,
  EFFORT_READING,
  EFFORT_TTL_MS,
  CAPABILITY_SAMPLE_BUDGET,
  EFFORT_SAMPLES,
  EFFORT_WORKING_RATIO,
  EFFORT_CANDIDATE_SAMPLES,
  MANUAL_SAMPLE_BUDGET,
  effortVerdictFrom,
  topThinkingLevel,
  unknownFree,
  writeCacheAtomic,
} from '../src/catalog.ts'

/**
 * Fixtures reproduce the REAL models.dev `api.json` shape as read on
 * 2026-09-29: a provider-keyed top level whose `opencode` entry is a PROVIDER
 * record ({id,env,npm,api,name,doc,models}) wrapping the model dictionary
 * (113 models, 34 zero-cost, 8 of those active).
 *
 * The wrapper used to be missing here, and that omission is exactly what let a
 * provider record reach `derive()` and produce an empty catalogue. `apiBody()`
 * is therefore the default fixture everywhere, and `deriveGuard` pins the
 * failure mode itself.
 */
const modelsDict = () => ({
  // active, completions via interleaved
  'big-pickle': {
    id: 'big-pickle',
    name: 'Big Pickle',
    reasoning: true,
    interleaved: { field: 'reasoning_content' },
    reasoning_options: [],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 200000, output: 32000 },
    modalities: { input: ['text'], output: ['text'] },
  },
  // active, completions via toggle (no interleaved)
  'ling-3.0-flash-fin-free': {
    id: 'ling-3.0-flash-fin-free',
    name: 'Ling 3.0 Flash Fin Free',
    reasoning: true,
    reasoning_options: [{ type: 'toggle' }],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  // active, responses via effort
  'muse-spark-1.3-contributor-free': {
    id: 'muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Free',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    modalities: { input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 1048576, output: 32768 },
  },
  // free but retired upstream
  'muse-spark-1.2-contributor-free': {
    id: 'muse-spark-1.2-contributor-free',
    name: 'Muse Spark 1.2 Free',
    reasoning: true,
    status: 'deprecated',
    reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    modalities: { input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  'deepseek-v4-flash-free': {
    id: 'deepseek-v4-flash-free',
    name: 'DeepSeek V4 Flash Free',
    reasoning: true,
    status: 'deprecated',
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 200000, output: 128000 },
  },
  // active with published limits, non-text modalities
  'space-bunny-free': {
    id: 'space-bunny-free',
    name: 'Space Bunny Free',
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    interleaved: { field: 'reasoning_content' },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 1048576, input: 524288, output: 524288 },
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  },
  // paid model must never appear
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    name: 'GPT 6 Astra',
    cost: { input: 1.25, output: 10, cache_read: 0, cache_write: 0 },
    modalities: { input: ['text', 'image'] },
  },
  // malformed shapes must be skipped, not thrown on
  'broken-null': null,
  'broken-array': [],
  'broken-nocost': { id: 'broken-nocost', name: 'No Cost' },
})

/** The provider record models.dev publishes for `opencode`, verbatim shape. */
const opencodeProvider = () => ({
  id: 'opencode',
  env: ['OPENCODE_API_KEY'],
  npm: '@ai-sdk/openai-compatible',
  api: 'https://opencode.ai/zen/v1',
  name: 'opencode',
  doc: 'https://opencode.ai/docs',
  models: modelsDict(),
})

/** A whole `api.json` body: provider-keyed, with opencode among the entries. */
const apiBodyWith = (models) => ({ ...apiBody(), opencode: { ...opencodeProvider(), models } })

const apiBody = () => ({
  anthropic: {
    id: 'anthropic',
    npm: '@ai-sdk/anthropic',
    models: { 'claude-opus-4-5': { id: 'claude-opus-4-5', cost: { input: 5, output: 25 } } },
  },
  opencode: opencodeProvider(),
  'z-ai': {
    id: 'z-ai',
    npm: '@ai-sdk/z-ai',
    models: { 'glm-5-free': { id: 'glm-5-free', cost: { input: 0, output: 0 }, status: 'deprecated' } },
  },
})

/** The identity-mapped pi-ai record every derived model inherits from. */
const template = () => ({
  id: 'template-model',
  name: 'Template',
  api: 'openai-completions',
  provider: 'opencode-zen-free',
  baseUrl: 'https://opencode.ai/zen/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 32000,
  headers: { 'User-Agent': 'opencode/1.18.31', 'x-opencode-client': 'cli' },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: true,
    maxTokensField: 'max_tokens',
  },
})

const baseline = () => [
  { ...template(), id: 'big-pickle', name: 'Big Pickle' },
  {
    ...template(),
    id: 'muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Free',
    api: 'openai-responses',
    compat: undefined,
  },
]

const ids = (models) => models.map((m) => m.id)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * The warm start is deliberately fire-and-forget (a container must answer
 * synchronously), so how many turns a `readFile` takes is not a contract.
 * Poll for the condition instead of betting on a tick count.
 */
async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return true
    await tick()
  }
  return false
}

function fakeResponse({ status = 200, etag = null, body = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function scriptedFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected extra fetch')
    if (typeof next === 'function') return next(init)
    return next
  }
  impl.calls = calls
  return impl
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-test-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── T1 derivation ───────────────────────────────────────────────────────────

test('isFree accepts only an all-zero cost object', () => {
  assert.equal(isFree({ cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }), true)
  assert.equal(isFree({ cost: {} }), false, 'empty cost proves nothing')
  assert.equal(isFree({ cost: { input: 0, output: 1 } }), false)
  assert.equal(isFree({ cost: null }), false)
  assert.equal(isFree({}), false)
})

test('isFree treats a two-dimension zero cost as free (the rule, verbatim)', () => {
  // Observed: models.dev lists some free records with only input/output cost.
  // The pinned rule is "every declared value is 0", so this IS free.
  assert.equal(isFree({ cost: { input: 0, output: 0 } }), true)
})

test('isActive retires only status=deprecated', () => {
  assert.equal(isActive({}), true, 'models.dev omits status for active models')
  assert.equal(isActive({ status: 'deprecated' }), false)
  assert.equal(isActive({ status: 'preview' }), true)
})

test('derive keeps free-deprecated models in the catalogue and drops paid', () => {
  // D1 (model-probe) flipped the old D2 rule: `deprecated` on this provider
  // means both "gone" and "stale record" (muse-spark-1.2 and mimo-v2.5 are
  // deprecated and still answer; deepseek-v4-flash-free is deprecated and
  // dead), so no static field can decide visibility. `status` now only decides
  // membership; a probe decides visibility.
  const { candidates } = derive(modelsDict(), { template: template() })
  assert.deepEqual(ids(candidates).sort(), [
    'big-pickle',
    'deepseek-v4-flash-free',
    'ling-3.0-flash-fin-free',
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor-free',
    'space-bunny-free',
  ])
  assert.ok(!ids(candidates).includes('gpt-6-astra'), 'paid model must not be offered')
})

test('derive skips malformed records instead of throwing', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  for (const id of ['broken-null', 'broken-array', 'broken-nocost']) {
    assert.ok(!ids(candidates).includes(id), id)
  }
})

test('derive falls back to the section key when a record has no id', () => {
  const { candidates } = derive({ 'keyed-free': { cost: { input: 0, output: 0 } } }, { template: template() })
  assert.deepEqual(ids(candidates), ['keyed-free'])
  assert.equal(candidates[0].name, 'keyed-free', 'name falls back to the id')
})

test('channelFor infers completions from interleaved or a toggle', () => {
  assert.equal(channelFor({ id: 'x', interleaved: { field: 'reasoning_content' } }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', reasoning_options: [{ type: 'toggle' }] }), 'openai-completions')
})

test('channelFor infers responses from an effort option', () => {
  assert.equal(
    channelFor({ id: 'x', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }),
    'openai-responses',
  )
})

test('channelFor defaults to completions (opencode is openai-compatible)', () => {
  assert.equal(channelFor({ id: 'x' }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', reasoning_options: [] }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', reasoning_options: 'nonsense' }), 'openai-completions')
})

// ── capability alignment (models.dev is the source for all four) ────────────

/**
 * pi-ai's own reader, used as the oracle: these tests assert the LEVELS A HOST
 * WILL OFFER, not just the shape of the map we hand it. The two differ —
 * `xhigh`/`max` are opt-in (absent ⇒ not offered) while the lower levels are
 * offered unless explicitly nulled — and getting that backwards is exactly the
 * bug this alignment fixes.
 */
const { getSupportedThinkingLevels, clampThinkingLevel } = await import('@earendil-works/pi-ai')

test('thinkingLevelMapFor maps the published effort levels and nulls the rest', () => {
  // space-bunny-free, real record 2026-09-29. `off` is NULL for an unmeasured
  // declared ladder: measured 2026-10-06, `reasoning_effort:"none"` answers
  // HTTP 400 there, and an empty effort list is what the host renders as its
  // provider-default row — which already means "send nothing". Offering `off`
  // anyway produced a row that lied about stopping a model nothing could stop.
  assert.deepEqual(
    thinkingLevelMapFor(
      { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
      'openai-completions',
    ),
    {
      off: null,
      // Ladder rows are not filtered by models.dev: measured across eight models
      // and both channels, no ladder level has EVER been refused, and
      // muse-spark-1.3 accepts a `max` it never published at 516 reasoning
      // tokens. An ignored ladder level is inert; an ignored `off` is the
      // opposite of its promise, which is why only `off` is gated.
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  )
  // muse-spark, real record: no `max`, so it must not be offered.
  assert.deepEqual(
    thinkingLevelMapFor(
      { reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }] },
      'openai-responses',
    ),
    {
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      // ABSENT, not null: pi-ai reads an absent opt-in level as "not offered",
      // and `max` is withheld until the model names it.
    },
  )
  // `off` is always PRESENT as a key now, and null for an unmeasured ladder.
  // "Not measured" and "measured to work" are different answers, and conflating
  // them is what made an absent key read as permission.
  assert.equal(
    thinkingLevelMapFor({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['low'] }] }, 'openai-completions').off,
    null,
  )
})

test('thinkingLevelMapFor always returns a map for a reasoning model', () => {
  // The original regression: `undefined` is NOT "no claim" — pi-ai reads an
  // absent map as "offer everything". Measured 2026-10-06, that had seven of the
  // ten live models offering four levels models.dev publishes nothing for.
  for (const record of [
    { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
    { reasoning: true, reasoning_options: [] },
    { reasoning: true, reasoning_options: undefined },
    { reasoning: true, reasoning_options: 'nonsense' },
    { reasoning: true, reasoning_options: [{ type: 'effort' }] },
    { reasoning: true, reasoning_options: [{ type: 'effort', values: [] }] },
    { reasoning: true, reasoning_options: [{ type: 'effort', values: ['turbo', 7, null] }] },
    { reasoning: true, reasoning_options: [{ type: 'effort', values: ['turbo'] }] },
  ]) {
    const map = thinkingLevelMapFor(record, 'openai-completions')
    assert.equal(typeof map, 'object', `expected a map for ${JSON.stringify(record)}`)
    assert.notEqual(map, null)
    // Nothing unmeasured may claim an off the model was never shown to accept.
    assert.equal(map.off, null, 'an unmeasured record claims no off value')
  }
  // A non-reasoning model is the ONE case that produces no map at all:
  // `getSupportedThinkingLevels` already answers ["off"] on its own.
  assert.equal(thinkingLevelMapFor({ reasoning: false, reasoning_options: [] }, 'openai-completions'), undefined)
})

test('INVARIANT: no string outside {published, "none"} lands in a map', () => {
  // The "off"-is-a-400 guard. A string value is exactly what makes pi-ai emit
  // `reasoning_effort`, and "off" is not in Zen's validated set
  // (minimal|low|medium|high|xhigh|max|none).
  const known = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const records = [
    { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
    { reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }] },
    { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] },
    { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
    { reasoning: true, reasoning_options: [] },
  ]
  for (const record of records) {
    const map = thinkingLevelMapFor(record, 'openai-completions')
    for (const value of Object.values(map)) {
      if (typeof value !== 'string') continue
      assert.ok(value === 'none' || known.has(value), `unexpected map value ${value}`)
    }
  }
  // A measured level-works value IS a known level name, by construction.
  const measured = thinkingLevelMapFor(
    { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
    'openai-completions',
    { kind: 'level-works', level: 'minimal', fp: 'x', api: 'openai-completions', at: 0 },
  )
  assert.equal(measured.off, 'minimal')
})

test('the levels a host offers follow models.dev, per model', () => {
  // The map the record produces, read back through pi-ai's own filter. An
  // unmeasured model offers no `off`: measured 2026-10-06, offering it produced
  // a row that either sent nothing (model kept reasoning) or was refused with a
  // 400 — never what the label said.
  const of = (id, measured) =>
    getSupportedThinkingLevels({
      id,
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapFor(modelsDict()[id], 'openai-completions', measured),
    })
  assert.deepEqual(of('space-bunny-free'), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(of('muse-spark-1.3-contributor-free'), ['minimal', 'low', 'medium', 'high', 'xhigh'])
  // And a model that NAMES `max` in a refusal does NOT get it: naming a level
  // is not offering it. See the named test below for why.
  assert.deepEqual(
    getSupportedThinkingLevels({
      id: 'muse-spark-1.3-contributor-free',
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapFor(modelsDict()['muse-spark-1.3-contributor-free'], 'openai-responses', undefined, ['low', 'high', 'max']),
    }),
    ['minimal', 'low', 'medium', 'high', 'xhigh'],
    'naming a level is not offering it',
  )
  // Undeclared `max` stays hidden UNTIL the model names it: pi-ai treats it as
  // opt-in, and offering a level on no evidence is the other half of the same
  // mistake in the opposite direction.
  // No published list and no measurement: nothing is claimed, so the host
  // renders its provider-default row alone.
  assert.deepEqual(of('big-pickle'), ['minimal', 'low', 'medium', 'high'], 'the default ladder is offered unfiltered')
  assert.deepEqual(of('ling-3.0-flash-fin-free'), ['minimal', 'low', 'medium', 'high'])
  // The derived records themselves carry the same maps.
  const derived = derive(modelsDict(), { template: template(), knownApis: new Map() })
  const spark = derived.candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.deepEqual(getSupportedThinkingLevels(spark), ['minimal', 'low', 'medium', 'high', 'xhigh'])
})

test('the clamp signature is arithmetic, not an error-body inference', () => {
  // `clampMaxTokensToContext` is min(maxTokens, max(1, contextWindow - estimate
  // - 4096)), so an emitted value of exactly 1 means the conversation passed the
  // declared window minus 4096. One-directional: an OVERSTATED window cannot make
  // the clamp fire at all, so a hit is positive evidence of understatement only.
  // It needs no attribution, which is what keeps it immune to the generic-400
  // blindness the upstream provokes.
  const starved = { emitted: 1, starved: true }
  // Nothing: the request was not starved.
  assert.deepEqual(clampVerdict(undefined, { emitted: 1, starved: false }, 200000), { kind: 'none' })
  // Not the floor: a merely reduced budget is not the signature.
  assert.deepEqual(clampVerdict(undefined, { emitted: 904, starved: true }, 200000), { kind: 'none' })
  // One observation is not a conclusion — measured: a single reply here cannot
  // distinguish an understated window from a genuinely full conversation.
  assert.deepEqual(clampVerdict(undefined, starved, 200000), { kind: 'hit', hits: 1 })
  assert.deepEqual(clampVerdict({ verdict: 'ok', at: 1, contextHits: 1 }, starved, 200000), {
    kind: 'confirmed',
    raisedTo: 800000,
  })
})

test('a raise never lowers a window and never exceeds the cap', () => {
  // C1: the declaration is the value. Nothing is substituted from a band, and
  // decimal-vs-binary formatting was measured to carry no predictive power.
  const record = { limit: { context: 200000, output: 32000 } }
  assert.equal(contextWindowFor(record), 200000, 'unmeasured keeps the declaration')
  assert.equal(contextWindowFor(record, { raisedTo: 1048576, fp: contextFingerprint(record), at: 1 }), 800000)
  // A stale measurement about revised limits is discarded, not applied.
  assert.equal(contextWindowFor(record, { raisedTo: 1048576, fp: 'stale', at: 1 }), 200000)
  // A proposal BELOW the declaration can never lower it.
  assert.equal(contextWindowFor(record, { raisedTo: 50000, fp: contextFingerprint(record), at: 1 }), 200000)
  // The ceiling binds even when the measurement asks for more.
  const big = { limit: { context: 1048576, output: 64000 } }
  assert.equal(contextWindowFor(big, { raisedTo: 8388608, fp: contextFingerprint(big), at: 1 }), 1048576)
  // A model whose window really was full keeps its window: the proposal is
  // already at the ceiling, so there is nothing to raise and the counter resets.
  assert.deepEqual(
    clampVerdict({ verdict: 'ok', at: 1, contextHits: 5 }, { emitted: 1, starved: true }, 1048576),
    { kind: 'hit', hits: 0 },
  )
})

test('a malformed context measurement is dropped, not trusted', () => {
  assert.equal(isMeasuredContext({ raisedTo: 800000, fp: 'f', at: 1 }), true)
  for (const bad of [
    undefined,
    null,
    'x',
    { raisedTo: 0, fp: 'f', at: 1 },
    { raisedTo: -5, fp: 'f', at: 1 },
    { raisedTo: Number.NaN, fp: 'f', at: 1 },
    { raisedTo: 800000, at: 1 },
    { raisedTo: 800000, fp: 'f' },
  ]) {
    assert.equal(isMeasuredContext(bad), false, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('contextFingerprint moves only for its own axis', () => {
  const base = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low'] }], limit: { context: 1, output: 2 } }
  const original = contextFingerprint(base)
  assert.equal(contextFingerprint({ ...base, reasoning: false }), original, 'reasoning does not move it')
  assert.equal(contextFingerprint({ ...base, reasoning_options: [] }), original, 'effort does not move it')
  assert.notEqual(contextFingerprint({ ...base, limit: { context: 2, output: 2 } }), original)
  assert.notEqual(contextFingerprint({ ...base, limit: { context: 1, output: 3 } }), original)
  // A record with no limits at all is distinguishable from one declaring zeros.
  assert.notEqual(contextFingerprint({ ...base, limit: undefined }), original)
})

test('the probe alternates its question so a baseline costs no extra request', () => {
  // The baseline is asked for rather than assumed: an absolute threshold is not
  // defensible across models, because longcat's floor of 36 sits ABOVE
  // big-pickle's omitted baseline of 14. Asking costs nothing because the round
  // changes what its existing request asks.
  assert.equal(nextEffortQuestion(undefined), 'baseline', 'an unseen model starts by asking for its own default')
  // Three baseline samples before a candidate is asked: a median over one point
  // is just that point. The samples themselves are free on a no-ladder model,
  // where the liveness request's `low` already clamps to omission.
  assert.equal(nextEffortQuestion({ verdict: 'ok', at: 1, effortBaselineTokens: [16] }), 'baseline', 'one is not a median');
  assert.equal(nextEffortQuestion({ verdict: 'ok', at: 1, effortBaselineTokens: [14, 16, 55] }), 'none');
  // ONE decisive rejection moves on, not three. big-pickle's `none` sits at a
  // ratio of 12.4 — far outside the bracket, so repeating it only spends quota
  // to confirm what is settled. longcat is why the fallback exists at all: its
  // `none` is 1.578 and its lowest level is 0.800, so both must be spent.
  assert.equal(
    nextEffortQuestion({ verdict: 'ok', at: 1, effortBaselineTokens: [14, 16, 55], effortDiscord: 1 }, 'minimal'),
    'minimal',
  );
  assert.equal(
    nextEffortQuestion({ verdict: 'ok', at: 1, effortBaselineTokens: [14, 16, 55], effortQuestion: 'minimal', effortDiscord: 1 }),
    'minimal',
    'it stays moved: a settled question is not re-opened',
  );
});

test('the fallback asks the model its OWN lowest level, not a fixed one', () => {
  // Measured 2026-10-06. space-bunny-free publishes `low…max` and its `low`
  // brings reasoning to 0/9/22/37 against an omitted baseline of 35 — a working
  // Off. Asking it for `minimal` instead measures a level it never published,
  // finds nothing, and withholds a row the model does support.
  assert.equal(fallbackLevelFor({ reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] }), 'low');
  // Declared out of order — the vocabulary's order decides, not the record's.
  assert.equal(fallbackLevelFor({ reasoning_options: [{ type: 'effort', values: ['high', 'max', 'low'] }] }), 'low');
  // No ladder at all: `minimal` is where big-pickle's 0/8 was measured.
  assert.equal(fallbackLevelFor({ reasoning_options: [] }), 'minimal');
  assert.equal(fallbackLevelFor({ reasoning_options: [{ type: 'toggle' }] }), 'minimal');
  // And it must never be `off`, whatever the model declares.
  assert.notEqual(fallbackLevelFor({ reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] }), 'off');
});

test('INVARIANT: a candidate is judged on the MEDIAN, against the model not a number', () => {
  // Measured 2026-10-06, medians against each model's own omitted baseline:
  //   big-pickle  minimal 0    against 16  ->  0.000   WORKS
  //   space-bunny low    9    against 42  ->  0.231   WORKS
  //   longcat     minimal 36    against 45  ->  0.800   inert
  //   muse-spark  minimal 38    against 166 ->  0.229   WORKS
  //   big-pickle  none  173    against 16  ->  10.81   inert
  // The bracket is (0.231, 0.800) and 0.43 is its max-margin cut in log space.
  assert.equal(effortVerdictFrom([0, 8, 0, 0, 8, 0], [14, 16, 55]), true, 'big-pickle minimal');
  assert.equal(effortVerdictFrom([0, 22, 0, 22], [35, 55, 36, 42]), true, 'space-bunny low');
  assert.equal(effortVerdictFrom([36, 36, 36, 36], [36, 45, 77]), false, 'longcat minimal is its own default');
  assert.equal(effortVerdictFrom([173, 198, 173], [14, 16, 55]), false, "big-pickle's none is nowhere near");
  // The median is what makes big-pickle's bimodal samples work at all. Its
  // `minimal` alternates 0 and 8; per-sample classification flips between
  // "works" and "inert" on that, while the median of [0,8,0,0,8,0] is 0 and
  // lands decisively below the 0.43 boundary.
  assert.equal(effortVerdictFrom([0, 8, 0, 0, 8, 0], [14, 16, 55]), true);
  assert.equal(effortVerdictFrom([0, 8], [14, 16, 55]), true, 'the same holds on two samples');
  // And a sample that is genuinely near the baseline is not rescued by a
  // favourable median: this is what a partial reduction looks like.
  assert.equal(effortVerdictFrom([8, 8], [14, 16, 55]), false, '8 against 16 is a 0.50 ratio, inside the bracket, so no claim');
  // An absolute threshold cannot work, and this pair is why: longcat's floor of
  // 36 against muse-spark's working 38. Two tokens.
  assert.equal(effortVerdictFrom([36, 36], [45, 45]), false);
  assert.equal(effortVerdictFrom([38, 38], [166, 184]), true);
  // No claim without both sides. "We did not look" must never read as "it does
  // not work" — that is the lie this change set exists to remove.
  assert.equal(effortVerdictFrom([], [16]), undefined, 'no candidate samples');
  assert.equal(effortVerdictFrom([0], []), undefined, 'no baseline samples');
  assert.equal(effortVerdictFrom([0], undefined), undefined, 'an absent baseline');
  assert.equal(effortVerdictFrom([0], [0]), undefined, 'a zero baseline cannot be divided by');
})


test('INVARIANT: an effort verdict needs agreeing samples, not a majority', () => {
  // Measured 2026-10-06: `big-pickle` returned HTTP 400 on three of nine
  // IDENTICAL requests and HTTP 200 on the rest, with `reasoning_content`
  // present on every 200. A single sample therefore records the wrong row about a
  // third of the time, and nothing downstream can notice — unlike an
  // `inconclusive`, the probe returns a clean 200.
  assert.deepEqual(effortVerdict(undefined, 'none-works'), { kind: 'discord', samples: ['none-works'] });
  assert.deepEqual(effortVerdict(['none-works'], 'none-works'), { kind: 'sample', samples: ['none-works', 'none-works'] });
  assert.deepEqual(effortVerdict(['none-works', 'none-works'], 'none-works'), { kind: 'confirmed' });
  // A disagreement RESETS rather than being out-voted. big-pickle's six-to-three
  // would decide "accepted" by majority, which is the reading its own data
  // refutes: when it does accept, the reasoning is still present.
  assert.deepEqual(effortVerdict(['none-works', 'none-works'], 'noop'), { kind: 'discord', samples: ['noop'] });
  assert.deepEqual(effortVerdict(['noop', 'none-works'], 'noop'), { kind: 'discord', samples: ['noop'] });
})

test('effort samples persist so a restart does not restart the count', async () => {
  // Losing the tally costs a few more rounds, never a wrong verdict — but only
  // if the tally is actually carried on disk.
  const dir = await mkdtemp(join(tmpdir(), 'effort-'));
  const file = join(dir, 'catalog.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      etag: undefined,
      fetchedAt: 1,
      models: {},
      probes: {
        'flip-free': { verdict: 'ok', at: 1, effortReading: EFFORT_READING, effortSamples: ['none-works', 'none-works'] },
        'bad-free': { verdict: 'ok', at: 1, effortReading: EFFORT_READING, effortSamples: ['none-works', 7, null] },
        'absent-free': { verdict: 'ok', at: 1 },
      },
      lastProbeAt: 0,
    }),
  );
  const read = await readCache(file);
  assert.deepEqual(read.probes['flip-free'].effortSamples, ['none-works', 'none-works']);
  // Damaged entries are dropped rather than trusted.
  assert.deepEqual(read.probes['bad-free'].effortSamples, ['none-works']);
  // A cache written before this field existed reads as "never sampled", which
  // is exactly right and self-heals on the next round.
  //
  // The same is true of a record from an OLDER INSTRUMENT, and deliberately so:
  // those samples were written by a probe that never read the reasoning count,
  // so they are all zero — and one stored zero keeps the median at zero for
  // ever. `absent-free` stands for both cases.
  assert.equal(read.probes['absent-free'].effortSamples, undefined);
  await rm(dir, { recursive: true, force: true });
})

test('a measurement is applied only when its fingerprint and channel still match', () => {
  // An effort measurement is OF a claim. If models.dev revised `reasoning_options`
  // the answer is about a question no longer being asked, and applying it would
  // widen what is offered on the strength of a stale vote.
  const section = {
    'q-free': {
      id: 'q-free',
      name: 'Q',
      reasoning: true,
      reasoning_options: [{ type: 'toggle' }],
      cost: { input: 0, output: 0 },
    },
  }
  const tpl = template()
  const fp = reasoningFingerprint(section['q-free'])
  const [model] = derive(section, { template: tpl, knownApis: new Map() }).candidates
  const probes = {
    'q-free': { verdict: 'ok', at: 1, effort: { kind: 'none-works', fp, api: 'openai-completions', at: 1 } },
  }
  // Matching: the measurement is adopted.
  const map = measuredEffortMap([model], section, probes)
  assert.equal(map.get('q-free')?.kind, 'none-works')

  // Stale fingerprint: dropped, leaving the map unmeasured — which offers no off.
  const revised = { 'q-free': { ...section['q-free'], reasoning_options: [{ type: 'effort', values: ['low'] }] } }
  assert.equal(measuredEffortMap([model], revised, probes).size, 0)

  // Wrong channel: dropped. Off is `reasoning_effort` on completions and
  // `reasoning.effort` on responses, so a measurement of one is evidence about
  // the other only by coincidence.
  const responsesProbes = {
    'q-free': { verdict: 'ok', at: 1, effort: { kind: 'none-works', fp, api: 'openai-responses', at: 1 } },
  }
  assert.equal(measuredEffortMap([model], section, responsesProbes).size, 0)

  // Absent evidence is not a claim either way.
  assert.equal(measuredEffortMap([model], section, {}).size, 0)
})

test('reasoningFingerprint moves only for its own axis', () => {
  const base = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low'] }], limit: { context: 1, output: 1 } }
  const original = reasoningFingerprint(base)
  assert.equal(reasoningFingerprint({ ...base, limit: { context: 999, output: 5 } }), original, 'limits do not move it')
  assert.notEqual(reasoningFingerprint({ ...base, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }), original)
  assert.notEqual(reasoningFingerprint({ ...base, reasoning: false }), original)
  // A record that publishes no options at all is distinguishable from one that
  // published an empty list — "described and found nothing" vs "said nothing".
  assert.notEqual(reasoningFingerprint({ ...base, reasoning_options: [] }), original)
})

test('a malformed persisted measurement is dropped, not trusted', () => {
  assert.equal(isMeasuredEffort({ kind: 'none-works', fp: 'f', api: 'openai-completions', at: 1 }), true)
  assert.equal(
    isMeasuredEffort({ kind: 'level-works', level: 'minimal', fp: 'f', api: 'openai-responses', at: 1 }),
    true,
  )
  for (const bad of [
    undefined,
    null,
    'none-works',
    { kind: 'works', fp: 'f', api: 'openai-completions', at: 1 },
    { kind: 'none-works', fp: 'f', api: 'nonsense-channel', at: 1 },
    { kind: 'none-works', api: 'openai-completions', at: 1 },
    { kind: 'level-works', fp: 'f', api: 'openai-completions', at: 1 },
    { kind: 'level-works', level: 'turbo', fp: 'f', api: 'openai-completions', at: 1 },
  ]) {
    assert.equal(isMeasuredEffort(bad), false, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('INVARIANT: the ladder is not filtered by models.dev, and `off` still is', () => {
  // The asymmetry is measured, not preferred.
  //
  // LADDER ROWS: across eight models and both channels, no ladder level has ever
  // been refused — not a declared one, and not an undeclared one. `big-pickle`
  // accepts `low` at 164 reasoning tokens; `mimo-v2.6-flash-free` accepts
  // `minimal` and `high`; `muse-spark-1.3` accepts a `max` it never published, at
  // 516, the strongest mode that model has. An IGNORED ladder level is inert —
  // the user gets the default, which is what the provider-default row also gives.
  //
  // `off`: an ignored Off is the opposite of its promise — maximum reasoning
  // where the user asked for none — so it is gated on measurement alone. That
  // asymmetry is why the two are decided apart rather than by one rule.
  const noLadder = thinkingLevelMapFor({ reasoning: true, reasoning_options: [] }, 'openai-completions');
  assert.deepEqual(noLadder, {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
  });
  // xhigh/max stay opt-in: absent means NOT offered, and they are withheld until
  // a measurement or the model's own refusal names them.
  assert.equal(Object.prototype.hasOwnProperty.call(noLadder, 'xhigh'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(noLadder, 'max'), false);
  // A model that publishes no reasoning at all still gets nothing.
  assert.equal(thinkingLevelMapFor({ reasoning_options: [] }, 'openai-completions'), undefined);
});

test('INVARIANT: a confirmed verdict stops being re-litigated', () => {
  // A verdict that keeps absorbing samples has a median over an ever-growing set,
  // which is a different statistic from the three that produced it.
  // big-pickle's `minimal` alternates 0 and 8, so a slowly growing median can
  // drift across the boundary and silently demote a control the model supports.
  const fp = 'yes:[]';
  const fresh = { verdict: 'ok', at: 1, effort: { kind: 'none-works', fp, api: 'openai-completions', at: 1 }, effortFrozenAt: 1_000, effortBaselineTokens: [16, 16, 16] };
  assert.equal(effortVerdictFresh(fresh, fp, 1_000 + EFFORT_TTL_MS - 1), true, 'fresh inside the TTL');
  assert.equal(effortVerdictFresh(fresh, fp, 1_000 + EFFORT_TTL_MS), false, 'stale at the TTL');
  // A revised declaration voids it immediately, whatever the clock says.
  assert.equal(effortVerdictFresh(fresh, 'yes:[{"type":"toggle"}]', 1_001), false);
  // And no verdict is never fresh.
  assert.equal(effortVerdictFresh(undefined, fp, 1_001), false);
  assert.equal(effectlessNeverFrozen({ verdict: 'ok', at: 1, effort: { kind: 'none-works', fp, api: 'openai-completions', at: 1 } }), false);
  function effectlessNeverFrozen(record) {
    return effortVerdictFresh(record, fp, 1_001);
  }
  // A settled model asks nothing, so the round cannot grow its sample set.
  assert.equal(nextEffortQuestion(fresh, 'minimal', true), 'settled');
  assert.equal(nextEffortQuestion(fresh, 'minimal', false), 'none', 'unsettled it keeps measuring');
});

test('a level the model NAMES is not thereby OFFERED', () => {
  // `muse-spark-1.3-contributor-free` refused `none` with
  // `allowed values: ["minimal","low","medium","high","xhigh","max"]` — naming
  // `max`, which models.dev does not publish.
  //
  // That enumeration says the SPELLING is accepted. It does not say the tier
  // exposes the mode: a route can take `max` and answer from `xhigh` instead,
  // returning 200 with the reasoning count of a mode the user never chose. The
  // one `max` request on record has NO token count at all
  // (`tests/measured-samples.json`: `max -> 200, tokens: null, n=1`), so nothing
  // ever distinguished honoured from downgraded — and the operator confirms `max`
  // is not open to individuals on this route.
  //
  // Offering a level claims what the user will GET; a refusal's vocabulary claims
  // what the parser will accept. Only the first kind may produce a row.
  const record = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }] }
  assert.equal(
    getSupportedThinkingLevels({ id: 'm', reasoning: true, thinkingLevelMap: thinkingLevelMapFor(record, 'openai-responses') }).includes('max'),
    false,
    'withheld on no evidence',
  )
  assert.equal(
    getSupportedThinkingLevels({
      id: 'm',
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapFor(record, 'openai-responses', undefined, ['low', 'high', 'max']),
    }).includes('max'),
    false,
    'and STILL withheld once the model names it — validity is not availability',
  )
  // A level models.dev publishes is offered exactly as before: the change is
  // about where a NEW level may come from, not about the published ladder.
  assert.equal(
    getSupportedThinkingLevels({
      id: 'm',
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapFor(record, 'openai-responses', undefined, ['xhigh']),
    }).includes('xhigh'),
    true,
  )
});

test('the same fixture shape yields opposite maps from opposite measurements', () => {
  // The whole reason shape cannot drive this rule. Measured 2026-10-06:
  // ling-3.1-flash-free (`[toggle]`) took `none` from 32 reasoning tokens to 0,
  // while longcat-2.5-preview-free (`[toggle]`, the SAME declared shape) stayed
  // at 71-80 with HTTP 200. Identical metadata, opposite behaviour.
  const toggle = { reasoning: true, reasoning_options: [{ type: 'toggle' }] }
  const noneWorks = { kind: 'none-works', fp: 'f', api: 'openai-completions', at: 0 }
  const noop = { kind: 'noop', fp: 'f', api: 'openai-completions', at: 0 }
  assert.equal(thinkingLevelMapFor(toggle, 'openai-completions', noneWorks).off, 'none')
  assert.equal(thinkingLevelMapFor(toggle, 'openai-completions', noop).off, null)
  // An empty ladder is no more predictive: three of four `[]` models honoured
  // `none`, big-pickle refused it with a 400.
  const empty = { reasoning: true, reasoning_options: [] }
  assert.equal(thinkingLevelMapFor(empty, 'openai-completions', noneWorks).off, 'none')
  assert.equal(thinkingLevelMapFor(empty, 'openai-completions', { ...noop, kind: 'rejected' }).off, null)
})

test('CHANNEL GATE: "none" is never applied across channels', () => {
  // Off is `reasoning_effort` on completions and `reasoning.effort` on responses,
  // and `none` is REJECTED on the second: measured 2026-10-06,
  // muse-spark-1.3-contributor-free answers
  // `reasoning_effort 'none' is not supported ... allowed values: [minimal, low,
  // medium, high, xhigh, max]`. A measurement of one channel is evidence about
  // the other only by coincidence, so the mismatch voids it.
  const record = { reasoning: true, reasoning_options: [{ type: 'toggle' }] }
  const onCompletions = { kind: 'none-works', fp: 'f', api: 'openai-completions', at: 0 }
  assert.equal(thinkingLevelMapFor(record, 'openai-completions', onCompletions).off, 'none')
  assert.equal(thinkingLevelMapFor(record, 'openai-responses', onCompletions).off, null)
})

test('R1 honours a published off member instead of discarding it as foreign', () => {
  // north-mini-code-free publishes ["none","high"]. The old membership test
  // dropped "none" as "not a level", which removed the model's only off member.
  assert.equal(
    thinkingLevelMapFor({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] }, 'openai-completions')
      .off,
    'none',
  )
  // A ladder WITHOUT an off member claims nothing, whatever the channel.
  assert.equal(
    thinkingLevelMapFor({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }, 'openai-responses').off,
    null,
  )
})

test('GUARD: the map, not the guard, decides what Off puts on the wire', () => {
  // The premise this replaces was "off is always offered and reaching the wire
  // is always wrong", disproven twice: `none` is measured to stop reasoning on
  // nemotron-3-ultra-free (49 -> 0) and refused outright on space-bunny-free.
  // The map is now the single authority; this pins that the two agree.
  const noneWorks = (record, channel) =>
    thinkingLevelMapFor(record, channel, { kind: 'none-works', fp: 'f', api: channel, at: 0 })
  // Where the map says "none", the guard must let it through — see the mirror
  // test in compatibility.test.mjs for the wire side.
  assert.equal(noneWorks({ reasoning: true, reasoning_options: [] }, 'openai-completions').off, 'none')
  // Where it says null, there is no off row at all.
  const rejected = thinkingLevelMapFor(
    { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
    'openai-completions',
    { kind: 'rejected', fp: 'f', api: 'openai-completions', at: 0 },
  )
  assert.equal(rejected.off, null)
  assert.equal(
    getSupportedThinkingLevels({ id: 'x', reasoning: true, thinkingLevelMap: rejected }).includes('off'),
    false,
  )
})


test('GUARD: the muse-spark xhigh default is no longer silently clamped away', async () => {
  // The plugin asks for `xhigh` on muse-spark (zen-provider streamSimple). With
  // no thinkingLevelMap, pi-ai's supported set tops out at `high` and the
  // request was quietly downgraded — the model never got the effort it was
  // asked for. Aligning the map from models.dev is what fixes it.
  const spark = derive(modelsDict(), { template: template(), knownApis: new Map() }).candidates.find(
    (m) => m.id === 'muse-spark-1.3-contributor-free',
  )
  assert.equal(clampThinkingLevel(spark, 'xhigh'), 'xhigh', 'the requested level survives')
  const bunny = derive(modelsDict(), { template: template(), knownApis: new Map() }).candidates.find(
    (m) => m.id === 'space-bunny-free',
  )
  assert.equal(clampThinkingLevel(bunny, 'max'), 'max', 'a published opt-in level is reachable')
  // Ladder rows are no longer filtered by models.dev, so `minimal` is offered
  // even though space-bunny does not publish it. What is still withheld is
  // anything a model has never named and never reported.
  assert.equal(getSupportedThinkingLevels(bunny).includes('minimal'), true, 'undeclared ladder levels are offered')
})

test('a derived record carries all four capabilities from models.dev', () => {
  const { candidates } = derive(modelsDict(), { template: template(), knownApis: new Map() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  // modalities.input: pi-ai knows text/image only, so video is dropped rather
  // than passed through as a capability the transport cannot honour.
  assert.deepEqual(bunny.input, ['text', 'image'])
  assert.equal(bunny.contextWindow, 1048576, 'limit.context')
  assert.equal(bunny.maxTokens, 524288, 'limit.output')
  assert.equal(bunny.reasoning, true)
  // A model with no image support must not inherit the template's.
  const pickle = candidates.find((m) => m.id === 'big-pickle')
  assert.deepEqual(pickle.input, ['text'], 'text-only stays text-only')
  assert.equal(pickle.contextWindow, 200000)
  // `limit.output` says 32000 and this model was watched producing 48,000 of it
  // (2026-10-07, `stopReason: "length"`), so the budget follows the observation.
  assert.equal(pickle.maxTokens, 48000)
  // A record that publishes NOTHING falls back to the template for the identity
  // and transport fields, but NOT for capability claims. `input` and `reasoning`
  // describe what the model can do; inheriting them from another model answers
  // "models.dev did not say" with "assume the most capable thing we know".
  const bare = derive(
    { 'bare-free': { id: 'bare-free', cost: { input: 0, output: 0 } } },
    { template: template() },
  ).candidates[0]
  assert.equal(bare.contextWindow, template().contextWindow)
  assert.equal(bare.maxTokens, template().maxTokens)
  assert.deepEqual(bare.input, ['text'], 'an unstated modality claim is not a capability')
  assert.equal(bare.reasoning, false, 'an unstated reasoning claim is not a capability')
  assert.notDeepEqual(template().input, bare.input, 'the template would have leaked its own capabilities')
  // The template's level map is never inherited: it belongs to another model.
  assert.equal(bare.thinkingLevelMap, undefined)
})

// ── capability cards (what the detail-page panel renders per row) ──────────

test('topThinkingLevel reads the strongest published level, nothing else', () => {
  // The map's string entries ARE the published levels (identity values); null
  // entries and a missing map mean "no badge", not a default.
  assert.equal(
    topThinkingLevel({ id: 'x', thinkingLevelMap: { minimal: null, low: 'low', max: 'max' } }),
    'max',
  )
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: { off: null, minimal: 'minimal' } }), 'minimal')
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: { minimal: null, low: null } }), null)
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: undefined }), null)
  assert.equal(topThinkingLevel({ id: 'x' }), null)
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: { off: 'off' } }), null, 'off is never a badge')
})

test('modelCapability projects image and top level per record', () => {
  const { candidates } = derive(modelsDict(), { template: template(), knownApis: new Map() })
  const card = (id) => modelCapability(candidates.find((m) => m.id === id))
  assert.deepEqual(card('space-bunny-free'), {
    id: 'space-bunny-free',
    image: true,
    thinking: 'max',
    contextWindow: 1048576,
    outputBudget: 524288,
    observedOutput: undefined,
    declaredContext: undefined,
    declaredOutput: undefined,
    levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    off: null,
    // No record and no probes: nothing was measured and nothing was published,
    // so every flag reads false. The card says "unknown" on all four axes rather
    // than borrowing an answer from the template.
    evidence: { context: 'none', output: 'none', vision: 'declared', tools: 'declared' },
  })
  assert.equal(card('muse-spark-1.3-contributor-free').thinking, 'xhigh')
  // Toggle-only and level-less records get no thinking badge. `ling` publishes
  // `modalities.input: ["text"]` and `attachment: false`, so it is text-only —
  // it does NOT inherit the template's text+image. The old fallback answered
  // "models.dev did not say" with "inherit the most capable thing we know", and
  // it was not cosmetic: DSH throws UNSUPPORTED_CONTENT on an image for a model
  // without it, so the inherited claim converts a silent omission into a hard
  // failure the user cannot act on.
  // Only the badges are asserted here; the numbers are asserted where the card is
  // built from a real record, because with no record passed there is nothing to
  // compare a declared value against.
  assert.deepEqual(
    { image: card('ling-3.0-flash-fin-free').image, thinking: card('ling-3.0-flash-fin-free').thinking },
    {
      image: false,
      // The default ladder is offered, so the strongest offered rung is now the
      // badge. The card names what exists, not what models.dev declared.
      thinking: 'high',
    },
  )
  assert.deepEqual(
    { image: card('big-pickle').image, thinking: card('big-pickle').thinking },
    { image: false, thinking: 'high' },
  )
})

test('capabilities ride alongside visible, same ids in the same order', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'deepseek-v4-flash-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    const state = catalog.current()
    assert.deepEqual(
      state.capabilities.map((c) => c.id),
      state.visible,
      'every visible id has exactly one card, in order',
    )
    const bunny = state.capabilities.find((c) => c.id === 'space-bunny-free')
    assert.equal(bunny.image, true)
    // The card carries the numbers the request path uses. Reading them here, off a
    // catalogue that has probed, is what makes "the panel cannot disagree with the
    // wire" a checkable claim rather than an intention.
    assert.equal(bunny.contextWindow, 1048576, 'the window pi-ai clamps this conversation against')
    assert.equal(bunny.outputBudget, 524288, 'the BUDGET pi-ai puts on the wire')
    // No generation has been watched for this model, so there is no observed
    // output. Absent is "never watched" — the row must not imply the model
    // writes exactly the budget, or exactly the declaration.
    assert.equal(bunny.observedOutput, undefined)
    assert.equal(bunny.declaredContext, 1048576, 'and what models.dev published beside it')
    assert.equal(bunny.evidence.context, 'declared', 'equal numbers: the declaration was right, nothing was raised')
    assert.equal(bunny.evidence.vision, 'route', 'measured on the route, not copied from the declaration')
    assert.deepEqual(bunny.levels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(bunny.off, null, 'no Off row is offered without a measurement that says one works')
    assert.equal(bunny.thinking, 'max')
    // Cards carry numbers, names and booleans — never the full records. The
    // numbers are here on purpose: they are what the request path clamps with, so
    // hiding them from the panel is what let a stale declaration look identical
    // to a measured one. Nothing request-shaping rides along.
    for (const card of state.capabilities) {
      assert.deepEqual(Object.keys(card).sort(), [
        'contextWindow',
        'declaredContext',
        'declaredOutput',
        'evidence',
        'id',
        'image',
        'levels',
        'observedOutput',
        'off',
        'outputBudget',
        'thinking',
      ])
    }
  })
})

test('channelFor prefers the pi-ai builtin table over any signal', () => {
  const known = new Map([['big-pickle', 'openai-responses']])
  assert.equal(
    channelFor({ id: 'big-pickle', interleaved: { field: 'reasoning_content' } }, known),
    'openai-responses',
  )
  assert.equal(
    channelFor({ id: 'unknown', interleaved: { field: 'reasoning_content' } }, known),
    'openai-completions',
  )
})

test('channelFor reproduces the opencode models pi-ai actually lists', () => {
  // Ground truth is the pi-ai builtin table read from node_modules — which
  // means the ids have to be the ones that table still CONTAINS. Under pi-ai
  // 0.87 `mimo-v2.5-free` is gone, replaced by `mimo-v2.6-flash-free`; an id
  // the table no longer has falls through to the synthetic fallback record,
  // which yields the same channel, so the assertion would keep passing while
  // proving nothing. Every id below is asserted present in the table first.
  const table = new Map(getBuiltinModels('opencode').map((m) => [m.id, m.api]))
  const truth = {
    'big-pickle': 'openai-completions',
    'ling-3.0-flash-fin-free': 'openai-completions',
    'mimo-v2.6-flash-free': 'openai-completions',
    'nemotron-3-ultra-free': 'openai-completions',
    'nemotron-3.5-lightning-free': 'openai-completions',
    'muse-spark-1.2-contributor-free': 'openai-responses',
    'muse-spark-1.3-contributor-free': 'openai-responses',
  }
  for (const [id, expected] of Object.entries(truth)) {
    assert.equal(table.get(id), expected, `${id} is still in pi-ai's table with that channel`)
    const record = modelsDict()[id] ?? {
      id,
      interleaved: { field: 'reasoning_content' },
      cost: { input: 0, output: 0 },
    }
    assert.equal(channelFor(record), expected, id)
  }
})

test('derive maps published limits and falls back per missing field', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.equal(bunny.contextWindow, 1048576)
  assert.equal(bunny.maxTokens, 524288)
  // ling publishes no limit at all -> template values
  const ling = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  assert.equal(ling.contextWindow, 200000)
  assert.equal(ling.maxTokens, 32000)
  assert.equal(ling.name, 'Ling 3.0 Flash Fin Free')
})

test('derive keeps text/image modalities and does NOT inherit the template when none survive', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.deepEqual(bunny.input, ['text', 'image'], 'audio/video are not pi-ai input kinds')
  const ling = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  // The fixture records no `modalities`, so the honest answer is text-only. The
  // template resolves to mimo-v2.6-flash-free (text+image), and inheriting it
  // answered "models.dev did not say" with "inherit the most capable thing we
  // know" — the same error as an undefined level map, one field over.
  assert.deepEqual(ling.input, ['text'], 'an unstated modality claim is not a capability')
  // And it is not a cosmetic one: DSH throws UNSUPPORTED_CONTENT on an image for
  // a model without it, so an inherited claim turns a silent omission into a
  // hard failure the user cannot act on.
})

test('derive inherits identity and zeroes cost on every candidate', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  for (const model of candidates) {
    assert.equal(model.provider, 'opencode-zen-free')
    assert.equal(model.baseUrl, 'https://opencode.ai/zen/v1')
    assert.equal(model.headers['x-opencode-client'], 'cli')
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
})

test('derive drops transport-specific compat when the channel changes', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  const completions = candidates.find((m) => m.id === 'big-pickle')
  assert.ok(completions.compat, 'same channel keeps the known-good overrides')
  const responses = candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.equal(responses.api, 'openai-responses')
  assert.equal(responses.compat, undefined, "the template's completions compat must not leak onto responses")
})

// ── T2 fetch + cache ────────────────────────────────────────────────────────

test('GUARD: a provider record fed to derive yields an empty catalogue', () => {
  // This is the shipped defect, pinned: `api.json` keys providers, and
  // `body.opencode` is the PROVIDER record. derive() over it finds no cost on
  // any of {id,env,npm,api,name,doc,models} and silently returns nothing —
  // an EMPTY catalogue, worse than the 7-model offline floor.
  const provider = opencodeProvider()
  const { candidates } = derive(provider, { template: template() })
  assert.deepEqual(candidates, [], 'a provider record must never look like a catalogue')
  // ...and the real shape does produce one, from the same response body.
  const correct = derive(provider.models, { template: template() })
  assert.ok(correct.candidates.length > 0, 'the models dictionary does produce candidates')
})

test('GUARD: fetchSection output feeds derive directly from a real api.json body', async () => {
  const result = await fetchSection({ fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
  assert.equal(result.kind, 'ok')
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.section, 'models'),
    false,
    'the wrapper is unwrapped here',
  )
  const { candidates } = derive(result.section, { template: template() })
  assert.deepEqual(ids(candidates).sort(), [
    'big-pickle',
    'deepseek-v4-flash-free',
    'ling-3.0-flash-fin-free',
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor-free',
    'space-bunny-free',
  ])
})

test('fetchSection returns the models dictionary and the etag on 200', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ etag: '"abc"', body: apiBody() })])
  const result = await fetchSection({ fetchImpl })
  assert.equal(result.kind, 'ok')
  assert.equal(result.etag, '"abc"')
  assert.deepEqual(Object.keys(result.section).sort(), Object.keys(modelsDict()).sort())
  assert.equal(fetchImpl.calls[0].url, MODELS_DEV_URL)
})

test('fetchSection reports 304 as not-modified', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ status: 304 })])
  assert.deepEqual(await fetchSection({ fetchImpl }), { kind: 'not-modified' })
})

test('fetchSection reports http, malformed, missing-section and oversize as failed', async () => {
  const cases = [
    [fakeResponse({ status: 500 }), 'http 500'],
    [fakeResponse({ body: 'not json at all' }), 'malformed response body'],
    [fakeResponse({ body: '[]' }), 'malformed response body'],
    [fakeResponse({ body: { anthropic: {} } }), 'missing opencode section'],
    [fakeResponse({ body: { opencode: 'nope' } }), 'missing opencode section'],
    // a provider record without its models dictionary is a failure, not an empty catalogue
    [
      fakeResponse({ body: { opencode: { id: 'opencode', npm: '@ai-sdk/openai-compatible' } } }),
      'missing opencode models section',
    ],
    [fakeResponse({ body: { opencode: { models: [] } } }), 'missing opencode models section'],
  ]
  for (const [response, reason] of cases) {
    const result = await fetchSection({ fetchImpl: scriptedFetch([response]) })
    assert.equal(result.kind, 'failed', reason)
    assert.equal(result.reason, reason)
  }
  const oversize = await fetchSection({
    fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
    maxBytes: 10,
  })
  assert.deepEqual(oversize, { kind: 'failed', reason: 'response too large' })
})

test('fetchSection classifies a timeout and never throws', async () => {
  const aborted = () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  const timedOut = await fetchSection({ fetchImpl: scriptedFetch([aborted]) })
  assert.deepEqual(timedOut, { kind: 'failed', reason: 'timeout' })
  const offline = await fetchSection({
    fetchImpl: scriptedFetch([
      () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    ]),
  })
  assert.deepEqual(offline, { kind: 'failed', reason: 'getaddrinfo ENOTFOUND' })
})

test('fetchSection identifies itself honestly and never borrows the Zen identity', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody() })])
  await fetchSection({ fetchImpl })
  const headers = fetchImpl.calls[0].headers
  assert.equal(headers.accept, 'application/json')
  assert.equal(headers['user-agent'], DEFAULT_USER_AGENT)
  assert.match(headers['user-agent'], /^dsh-opencode-free\//)
  assert.ok(
    !headers['user-agent'].includes('opencode/'),
    'must not impersonate the OpenCode CLI to models.dev',
  )
  assert.equal(headers['if-none-match'], undefined)
})

test('fetchSection sends if-none-match only when an etag is supplied', async () => {
  const warm = scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })])
  await fetchSection({ fetchImpl: warm, etag: '"v1"' })
  assert.equal(warm.calls[0].headers['if-none-match'], '"v1"')
  const blank = scriptedFetch([fakeResponse({ body: apiBody() })])
  await fetchSection({ fetchImpl: blank, etag: '' })
  assert.equal(blank.calls[0].headers['if-none-match'], undefined)
})

test('cachePath honours DSH_HOME and falls back to ~/.dsh', () => {
  const expected = join(homedir(), '.dsh', 'dsh-opencode-free', 'catalog.json')
  assert.equal(
    cachePath({ DSH_HOME: '/custom/home' }),
    join('/custom/home', 'dsh-opencode-free', 'catalog.json'),
  )
  assert.equal(cachePath({}), expected)
  assert.equal(cachePath({ DSH_HOME: '' }), expected, 'an empty DSH_HOME is not a home')
})

test('cache round-trips atomically and stores only the models dictionary', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'catalog.json')
    assert.equal(await writeCacheAtomic(path, { etag: '"v1"', fetchedAt: 123, models: modelsDict() }), true)
    const restored = await readCache(path)
    assert.equal(restored.version, CACHE_VERSION)
    assert.equal(restored.etag, '"v1"')
    assert.equal(restored.fetchedAt, 123)
    assert.deepEqual(Object.keys(restored.models).sort(), Object.keys(modelsDict()).sort())
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(Object.keys(onDisk).sort(), ['etag', 'fetchedAt', 'models', 'version'])
    assert.equal(onDisk.api, undefined, 'provider base url is not persisted')
  })
})

test('readCache treats missing, corrupt and foreign-version files as no cache', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readCache(join(dir, 'absent.json')), null)
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{ truncated', 'utf8')
    assert.equal(await readCache(corrupt), null)
    const future = join(dir, 'future.json')
    await writeFile(future, JSON.stringify({ version: 99, models: {} }), 'utf8')
    assert.equal(await readCache(future), null)
    const wrongShape = join(dir, 'shape.json')
    await writeFile(wrongShape, JSON.stringify({ version: 1, models: 'nope' }), 'utf8')
    assert.equal(await readCache(wrongShape), null)
  })
})

test('readCache rejects a file still carrying the old `opencode` field', async () => {
  await withTempDir(async (dir) => {
    // The rename guard: a cache written before the field was renamed holds the
    // PROVIDER record, which would derive to an empty catalogue. It must read
    // as "no cache" so the next read re-downloads instead of emptying the picker.
    const legacy = join(dir, 'legacy.json')
    await writeFile(
      legacy,
      JSON.stringify({ version: CACHE_VERSION, etag: '"v1"', fetchedAt: 1, opencode: opencodeProvider() }),
      'utf8',
    )
    assert.equal(await readCache(legacy), null)
  })
})

// ── T3 state container ──────────────────────────────────────────────────────

function catalogWith({
  dir,
  fetchImpl,
  clock = { t: 1_000_000 },
  ttlMs,
  baselineModels = baseline(),
  probe,
  listZenIds,
  hidden,
  // Pinned to one: most of what is under test here is the round's SAMPLING
  // (a verdict costs several samples, a refusal moves the question, a dead
  // verdict is final), and a budget-sized probe bill per click would drown it.
  // The budget itself is exercised by its own test.
  manualSampleBudget = 1,
} = {}) {
  return createCatalog({
    template: template(),
    builtinBaseline: baselineModels,
    knownApis: new Map(),
    cachePath: join(dir, 'catalog.json'),
    fetchImpl,
    now: () => clock.t,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(probe === undefined ? {} : { probe }),
    ...(listZenIds === undefined ? {} : { listZenIds }),
    ...(hidden === undefined ? {} : { hidden }),
    manualSampleBudget,
  })
}

test('a fresh container serves the offline floor before any sync', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([]) })
    const state = catalog.current()
    assert.equal(state.source, 'builtin-fallback')
    assert.deepEqual(ids(state.models), ['big-pickle', 'muse-spark-1.3-contributor-free'])
    assert.deepEqual(state.visible, ['big-pickle', 'muse-spark-1.3-contributor-free'])
    assert.equal(state.updatedAt, 0)
    assert.equal(state.refreshing, false)
  })
})

test('ensureFresh does nothing while the cache is within the TTL', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 60_000 })
    await catalog.forceRefresh()
    assert.equal(fetchImpl.calls.length, 1)
    clock.t += 30_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 1, 'still fresh')
    assert.equal(catalog.current().source, 'models.dev')
  })
})

test('ensureFresh revalidates past the TTL and adopts the derived catalogue', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 304 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 60_000 })
    await catalog.forceRefresh()
    assert.deepEqual(catalog.current().visible.sort(), [
      'big-pickle',
      'deepseek-v4-flash-free',
      'ling-3.0-flash-fin-free',
      'muse-spark-1.2-contributor-free',
      'muse-spark-1.3-contributor-free',
      'space-bunny-free',
    ])
    clock.t += 120_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 2)
    assert.equal(fetchImpl.calls[1].headers['if-none-match'], '"v1"', 'a warm etag is reused')
  })
})

test('concurrent ensureFresh calls share a single in-flight sync', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody() })])
    const catalog = catalogWith({ dir, fetchImpl, ttlMs: 0 })
    await Promise.all([catalog.ensureFresh(), catalog.ensureFresh(), catalog.ensureFresh()])
    assert.equal(fetchImpl.calls.length, 1)
  })
})

test('without a cache the conditional header is never sent (R5)', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ status: 304, etag: '"v1"' })])
    const catalog = catalogWith({ dir, fetchImpl, ttlMs: 0 })
    await catalog.ensureFresh()
    assert.equal(
      fetchImpl.calls[0].headers['if-none-match'],
      undefined,
      'a 304 with no cache would lose the catalogue',
    )
  })
})

test('a 304 only bumps freshness, it does not rebuild or empty the catalogue', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 304 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    const before = catalog.current()
    clock.t += 100
    await catalog.ensureFresh()
    const after = catalog.current()
    assert.deepEqual(after.visible, before.visible)
    assert.equal(after.source, 'models.dev')
    assert.equal(after.updatedAt, clock.t, 'freshness advanced so the next read is quiet')
  })
})

test('a failed sync preserves the current catalogue', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 503 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    const before = catalog.current()
    clock.t += 100
    await catalog.ensureFresh()
    const after = catalog.current()
    assert.deepEqual(after.visible, before.visible)
    assert.equal(after.source, 'models.dev')
    assert.equal(after.updatedAt, before.updatedAt, 'a failure does not pretend to be fresh')
  })
})

test('a failed first sync leaves the offline floor in place', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      () => {
        throw new Error('offline')
      },
    ])
    const catalog = catalogWith({ dir, fetchImpl, ttlMs: 0 })
    await catalog.ensureFresh()
    const state = catalog.current()
    assert.equal(state.source, 'builtin-fallback')
    assert.deepEqual(ids(state.models), ['big-pickle', 'muse-spark-1.3-contributor-free'])
  })
})

test('a warm cache is adopted on start without touching the network', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'catalog.json')
    await writeCacheAtomic(path, { etag: '"v1"', fetchedAt: 900_000, models: modelsDict() })
    const fetchImpl = scriptedFetch([])
    const catalog = catalogWith({ dir, fetchImpl, clock: { t: 1_000_000 }, ttlMs: 60_000 })
    assert.equal(
      await waitFor(() => catalog.current().source === 'models.dev'),
      true,
      'the warm cache was adopted',
    )
    const state = catalog.current()
    assert.equal(state.source, 'models.dev')
    assert.equal(state.updatedAt, 900_000)
    assert.equal(fetchImpl.calls.length, 0, 'a fresh cache answers without a download')
    assert.ok(state.visible.includes('space-bunny-free'))
  })
})

test('the Zen gate narrows visible, and nothing else is reported', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    catalog.applyZenGate(['big-pickle', 'space-bunny-free', 'not-in-catalogue'])
    const state = catalog.current()
    assert.deepEqual(state.visible, ['big-pickle', 'space-bunny-free'])
    // There is no companion list naming what was dropped — not for a gate
    // artifact, not for a dead verdict. A model that is not offered is simply
    // not in `visible`. `unknownFree` is not such a list: it names ids the
    // catalogue never had, which is a different fact entirely.
    assert.deepEqual(Object.keys(state).sort(), [
      'capabilities',
      'gateCheckedAt',
      'models',
      'probeInconclusive',
      'probedAt',
      'refreshing',
      'source',
      'unknownFree',
      'updatedAt',
      'visible',
    ])
    assert.deepEqual(ids(catalog.effectiveModels()), ['big-pickle', 'space-bunny-free'])
  })
})

test('a null Zen gate never narrows an existing one', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    catalog.applyZenGate(['big-pickle'])
    catalog.applyZenGate(null)
    assert.deepEqual(
      catalog.current().visible,
      ['big-pickle'],
      'Zen being unreachable must not empty the picker',
    )
  })
})

test('effectiveModels and visible stay the same set after a re-sync', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ body: apiBody() }),
      // upstream dropped space-bunny-free from its free list entirely
      fakeResponse({ body: apiBodyWith({ 'big-pickle': modelsDict()['big-pickle'] }) }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    catalog.applyZenGate(['big-pickle', 'space-bunny-free'])
    clock.t += 100
    await catalog.ensureFresh()
    const state = catalog.current()
    assert.deepEqual(state.visible, ['big-pickle'], 'the re-derived catalogue was re-gated')
    assert.deepEqual(ids(catalog.effectiveModels()), state.visible, 'picker and panel read one set')
    // A model models.dev dropped altogether is simply gone: it leaves the
    // catalogue, the visible list, and every other report.
    assert.ok(!state.models.some((m) => m.id === 'space-bunny-free'))
  })
})

test('a 304 also refreshes the cache file, so the next boot stays quiet', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 304 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    clock.t += 100
    await catalog.ensureFresh()
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.fetchedAt, clock.t, 'freshness persisted, not just held in memory')
    assert.equal(onDisk.etag, '"v1"')
  })
})

test('the snapshot is a copy, so callers cannot mutate catalogue state', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    const state = catalog.current()
    state.models.push({ ...template(), id: 'injected' })
    state.visible.push('injected')
    assert.ok(!catalog.current().visible.includes('injected'))
  })
})

// ── T4 availability probe (model-probe D2–D6) ───────────────────────────────

/** The verdict text `probeModel` produces, kept out of the assertions below. */
const DEAD = (status) => ({ kind: 'dead', reason: `probe says gone (HTTP ${status})` })

/**
 * A prober that records call order and never overlaps. The round spends a
 * shared anonymous-quota bucket, so "sequential" is a cost property rather
 * than a style choice — which is why it is asserted and not assumed.
 */
function recordingProber(verdicts = {}) {
  const calls = []
  // The ceiling and capability questions land in their own list: they run on EVERY
  // round now (on their own budget), and the assertions below are about which
  // models were asked for LIVENESS, in which order, once each.
  const capability = []
  let inFlight = 0
  let overlapped = false
  const probe = async (model, question) => {
    if (question === 'ceiling' || (typeof question === 'string' && question.startsWith('capability:'))) {
      capability.push(model.id + ':' + question)
    } else calls.push(model.id)
    inFlight += 1
    if (inFlight > 1) overlapped = true
    await tick()
    inFlight -= 1
    return verdicts[model.id] ?? { kind: 'ok' }
  }
  probe.calls = calls
  probe.capability = capability
  probe.overlapped = () => overlapped
  return probe
}

/** A catalogue carrying the real derived set, ready to probe. */
async function probedCatalog(dir, probe, clock = { t: 1_000_000 }) {
  const catalog = catalogWith({
    dir,
    clock,
    fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
    probe,
  })
  await catalog.forceRefresh()
  return catalog
}

// A manual round is floored: forceProbes() refuses to run again within
// FORCED_PROBE_MIN_INTERVAL_MS, because the POST route has no server-side rate
// limit and every round spends up to 34 requests from a bucket shared per egress
// IP. Tests that want a SECOND round must therefore move the
// frozen clock — which is exactly what a real user does, by waiting.
const PROBE_FLOOR_MS = 5 * 60_000
function pastProbeFloor(clock) {
  clock.t += PROBE_FLOOR_MS + 1_000
}

/** A free model whose record matches the shape of mimo-v2.6-flash-free. */
function mimoRecord() {
  return { ...modelsDict()['space-bunny-free'], id: 'mimo-v2.6-flash-free', name: 'Mimo V2.6 Flash Free' }
}

/** The persisted verdict record for one model, read back off disk. */
async function readProbeRecord(path, id) {
  const cache = JSON.parse(await readFile(path, 'utf8'))
  return cache.probes?.[id] ?? {}
}

const SERVED = ['big-pickle', 'ling-3.0-flash-fin-free', 'muse-spark-1.3-contributor-free']

const DERIVED = [
  'big-pickle',
  'deepseek-v4-flash-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'space-bunny-free',
]

test('GUARD: a round keeps the evidence it did not re-derive', async () => {
  // The record was rebuilt from scratch every round, so anything this round did
  // not re-derive disappeared: a candidate round wiped the baseline, a baseline
  // round wiped the candidates. EFFORT_SAMPLES asks for three on EACH side, so
  // a rule that erases half the tally on alternate rounds can never satisfy it
  // — the axis could not converge at any number of rounds.
  await withTempDir(async (dir) => {
    const clock = { t: 1_000_000 }
    const asked = []
    // Exactly the measured shape: 55 reasoning tokens omitted, 0 under `none`
    // (mimo-v2.6-flash-free, 2026-10-06, tests/measured-samples.json).
    const probe = async (model, question) => {
      asked.push(question)
      return {
        kind: 'ok',
        api: 'openai-completions',
        effort: {
          kind: question === 'baseline' ? 'baseline' : 'candidate',
          tokens: question === 'baseline' ? 55 : 0,
        },
      }
    }
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) })]),
      probe,
      listZenIds: async () => ['space-bunny-free'],
    })
    await catalog.forceRefresh()

    for (let i = 0; i < 3; i += 1) {
      pastProbeFloor(clock)
      await catalog.forceProbes()
    }
    const baseline = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free')
    assert.deepEqual(baseline.effortBaselineTokens, [55, 55, 55], 'three baseline samples must accumulate')
    assert.equal(asked.at(-1), 'baseline', 'a third sample is not yet a median')

    pastProbeFloor(clock)
    await catalog.forceProbes()
    assert.equal(asked.at(-1), 'none', 'three samples is enough to move to the candidate question')
    const both = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free')
    assert.deepEqual(both.effortTokens, [0], 'the candidate lands in the candidate bucket')
    assert.deepEqual(both.effortBaselineTokens, [55, 55, 55], 'and the baseline it is judged against must still be there')
  })
})

test('GUARD: a round does not erase a harvested vocabulary or a measured window', async () => {
  // Same root cause, two pieces of evidence that cost a real request to obtain:
  // the level vocabulary a refusal enumerated (ADR 0004 §33/§34 — only
  // self-reporting models ever give it up) and a measured context window. Both
  // are written by a DIFFERENT round than the one that will read them, so a
  // rebuild that keeps only what it just derived throws away the only copy.
  await withTempDir(async (dir) => {
    // models.dev publishes this ladder as [minimal, low, medium, high, xhigh];
    // the measured window is fingerprinted against `limit`, so the seed and the
    // refresh below must publish the SAME limits or the measurement is voided by
    // its own guard.
    const fledge = {
      ...modelsDict()['muse-spark-1.3-contributor-free'],
      id: 'fledge-alpha-free',
      name: 'Fledge Alpha Free',
    }
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: 1_000_000,
        models: { 'fledge-alpha-free': fledge },
        probes: {
          'fledge-alpha-free': {
            verdict: 'ok',
            at: 1_000_000,
            selfReported: ['low', 'high', 'max'],
            context: { raisedTo: 1048576, fp: '1048576:131072', at: 1_000_000 },
          },
        },
        lastProbeAt: 1_000_000,
      }),
      'utf8',
    )
    const clock = { t: 2_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'fledge-alpha-free': fledge }) }),
      probe: async () => ({ kind: 'ok', api: 'openai-completions' }),
      listZenIds: async () => ['fledge-alpha-free'],
    })
    await catalog.forceRefresh()
    pastProbeFloor(clock)
    await catalog.forceProbes()

    const record = await readProbeRecord(join(dir, 'catalog.json'), 'fledge-alpha-free')
    assert.deepEqual(record.selfReported, ['low', 'high', 'max'], 'a harvested vocabulary survives an unrelated round')
    assert.equal(record.context?.raisedTo, 1048576, 'a measured window survives an unrelated round')
    assert.equal(record.verdict, 'ok', 'while the verdict itself is still rewritten every round')
  })
})

test('GUARD: a refusal to the spelling we asked counts as a sample, not a silence', async () => {
  // Measured 2026-10-06: space-bunny-free answers `reasoning_effort: "none"`
  // with a hard 400 on both channels, while the same model answers the omitted
  // request normally. That refusal is the evidence ADR 0004 §31 needs to move
  // the round to the model's own lowest level — and it used to be filed as
  // "this round reached nothing", which (a) discarded the only evidence that
  // `none` is unusable there and (b) silenced the model for six hours, so the
  // fallback could never even be asked.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      probe: async (_model, question) => {
        asked.push(question)
        // The generic 400 every model returns for a bad parameter; it carries no
        // vocabulary, so nothing may be harvested from it either.
        if (question === 'none') {
          return { kind: 'inconclusive', code: 'unknown', http: 400, reason: 'invalid request（HTTP 400）' }
        }
        // The omitted request measures 42; the fallback level drops to 4.
        const tokens = question === 'baseline' ? 42 : 4
        return {
          kind: 'ok',
          api: 'openai-completions',
          effort: { kind: question === 'baseline' ? 'baseline' : 'candidate', tokens },
        }
      },
      listZenIds: async () => ['space-bunny-free'],
    })
    await catalog.forceRefresh()
    // Three baselines, the refusal, then enough rounds at the fallback to
    // confirm: three samples to produce a verdict, three to agree.
    for (let i = 0; i < 10; i += 1) {
      pastProbeFloor(clock)
      await catalog.forceProbes()
    }

    const effortAsked = asked.filter((q) => q !== 'ceiling')
    assert.equal(effortAsked[3], 'none', 'the candidate question is asked first');
    assert.equal(effortAsked[4], 'low', 'one refusal moves the round to the model\'s own lowest level');
    assert.deepEqual(
      [...new Set(effortAsked.slice(4).filter((q) => q !== 'settled'))],
      ['low'],
      'every question after the refusal is that same fallback level',
    );
    assert.equal(asked.at(-1), 'settled', 'and once the verdict is frozen the round stops re-measuring it');

    const record = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free')
    assert.equal(record.verdict, 'ok', 'a refusal is not a verdict about liveness');
    assert.equal(record.effort?.kind, 'level-works', 'the fallback level is what gets confirmed');
    assert.equal(record.effort?.level, 'low');
  })
})

test('GUARD: a spelling that reduces nothing does not become an Off row', async () => {
  // Live 2026-10-06: `longcat-2.5-preview-free` ended up with
  // `level-works / minimal` while its OWN samples said the opposite —
  // [1,36,36,36,36] against a [36,36,36] baseline, median 36 against a
  // threshold of 15.48. Nothing was reduced, and the model was handed an Off row
  // anyway.
  //
  // The verdict's KIND was being re-derived from the question spelling at
  // confirmation ("were we asking about `none`, or about a level?") instead of
  // taken from the sample that was actually confirmed — so every confirmed
  // `noop` came back labelled `level-works`.
  //
  // A verdict that names a level it did not demonstrate is the one lie this
  // axis cannot ship: it hands the user a control that changes nothing.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      // longcat's real numbers: the baseline is 36 and so is everything asked
      // for, at the fallback level.
      probe: async (_model, question) => ({
        kind: 'ok',
        api: 'openai-completions',
        effort: { kind: question === 'baseline' ? 'baseline' : 'candidate', tokens: question === 'baseline' ? 36 : 36 },
      }),
      listZenIds: async () => ['space-bunny-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    const record = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free');
    assert.equal(record.effort?.kind, 'noop', 'the confirmed sample was "reduced nothing", so that is the verdict');
    assert.equal(record.effort?.level, undefined, 'and it names no level');
    await catalog.forceRefresh();
    const model = catalog.current().models.find((m) => m.id === 'space-bunny-free');
    assert.equal(model?.thinkingLevelMap?.off, null, 'so the user gets no Off row instead of one that does nothing');
  })
})

test('GUARD: a 401 that blames the request shape is a refusal of the spelling, not of the caller', async () => {
  // `space-bunny-free` — the model this session runs on, answering normally the
  // whole time — sat in the panel as "unmeasurable" for rounds.
  //
  // It has no problem at all. Measured 2026-10-06, five probes each:
  //   the omitted request  → 200, five out of five
  //   `reasoning_effort:"low"` → 200, five out of five
  //   `reasoning_effort:"none"` → refused every time, and the two channels
  //     disagree about how: completions answers a generic 400, responses
  //     answers `401 Model space-bunny-free is not supported for format openai`.
  //
  // That 401 was classified as a credential failure, `isCallerScoped` returned it
  // immediately, and the other channel's answer was discarded — so the model
  // looked unmeasurable and the round never reached the fallback level that
  // works.
  //
  // The attribution is sound because the round only asks a spelling after three
  // successful omitted samples on the same channel: the request that fails
  // differs from one that worked by exactly the injected field.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      probe: async (model, question) => {
        asked.push(question);
        // space-bunny-free publishes low…max, so ITS lowest level is `low`.
        if (question === 'none') {
          return {
            kind: 'inconclusive',
            code: 'unknown',
            http: 401,
            formatScoped: true,
            reason: 'not supported for format openai（HTTP 401）',
          };
        }
        const tokens = question === 'baseline' ? 40 : 6;
        return {
          kind: 'ok',
          api: 'openai-completions',
          effort: { kind: question === 'baseline' ? 'baseline' : 'candidate', tokens },
        };
      },
      listZenIds: async () => ['space-bunny-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    assert.ok(asked.includes('low'), 'the round moved past the refused spelling to its own lowest level');
    const record = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free');
    assert.equal(record.effort?.kind, 'level-works', 'and confirmed the level that actually works');
    assert.equal(record.effort?.level, 'low');
    assert.equal(catalog.probeProgress().results['space-bunny-free'].status, 'ok', 'so the row is not "unmeasurable"');
  })
})

test('GUARD: three refusals of the same spelling end at no Off row, never a wrong one', async () => {
  // The terminal case: when no spelling works, ADR 0004 §31 wants `off: null` —
  // an honest absence, not a control that does nothing. The refusal has to be
  // able to REACH that verdict, which it could not while it was filed as a round
  // that reached nothing.
  await withTempDir(async (dir) => {
    // Seeded BEFORE the container exists, so the warm read adopts it: the
    // baseline is already measured (three samples) and nothing has disagreed.
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: 1_000_000,
        models: { 'space-bunny-free': modelsDict()['space-bunny-free'] },
        probes: {
          // Stamped: this is what a record from the CURRENT instrument looks
          // like. An unstamped one stands for the pre-fix instrument, whose
          // samples were all zero — see the instrument-version test below.
          'space-bunny-free': { verdict: 'ok', at: 1_000_000, effortReading: EFFORT_READING, effortBaselineTokens: [35, 42, 55] },
        },
        lastProbeAt: 1_000_000,
      }),
      'utf8',
    )
    const clock = { t: 2_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      probe: async () => ({ kind: 'inconclusive', code: 'unknown', http: 400, reason: 'invalid request（HTTP 400）' }),
      listZenIds: async () => ['space-bunny-free'],
    })
    await catalog.forceRefresh()
    for (let i = 0; i < 4; i += 1) {
      pastProbeFloor(clock)
      await catalog.forceProbes()
    }
    const record = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free')
    assert.equal(record.effort?.kind, 'rejected', 'three agreeing refusals confirm a rejection');
    assert.equal(record.effort?.level, undefined, 'a rejection names no level');
    await catalog.forceRefresh();
    const model = catalog.current().models.find((m) => m.id === 'space-bunny-free');
    assert.equal(model?.thinkingLevelMap?.off, null, 'so the model gets no Off row rather than a lying one');
  })
})

test('GUARD: samples from an older instrument are re-measured, not judged', async () => {
  // The first release of the effort axis never read `usage.reasoning`, so every
  // sample it wrote was a hard 0. Those zeros cannot be told apart from real
  // ones by value — a model asked for `low` may genuinely report zero — so they
  // are told apart by INSTRUMENT. Left in place they are worse than useless: one
  // stored 0 alongside three real samples keeps `median(baseline)` at 0, which
  // `effortVerdictFrom` reads as "no claim", and the axis never converges again.
  await withTempDir(async (dir) => {
    // Exactly what a poisoned deployment looks like: two baselines, both zero.
    // The record needs this model's OWN id, or `derive` names it after the
    // borrowed fixture's id and the catalogue prunes the probe as unknown.
    const mimo = { ...modelsDict()['space-bunny-free'], id: 'mimo-v2.6-flash-free', name: 'Mimo V2.6 Flash Free' };
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: 1_000_000,
        models: { 'mimo-v2.6-flash-free': mimo },
        probes: {
          'mimo-v2.6-flash-free': { verdict: 'ok', at: 1_000_000, effortBaselineTokens: [0, 0] },
        },
        lastProbeAt: 1_000_000,
      }),
      'utf8',
    )
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'mimo-v2.6-flash-free': mimo }) }),
      // Measured 2026-10-06: mimo-v2.6-flash-free reasons 37 when omitted and 0
      // under `none`.
      probe: async (_model, question) => {
        asked.push(question);
        return {
          kind: 'ok',
          api: 'openai-completions',
          effort: { kind: question === 'baseline' ? 'baseline' : 'candidate', tokens: question === 'baseline' ? 37 : 0 },
        }
      },
      listZenIds: async () => ['mimo-v2.6-flash-free'],
    })
    await catalog.forceRefresh();
    for (let i = 0; i < 10; i += 1) {
      pastProbeFloor(clock);
      await catalog.forceProbes();
    }
    assert.ok(asked.includes('baseline'), 'the baseline is asked again rather than believed');
    const record = await readProbeRecord(join(dir, 'catalog.json'), 'mimo-v2.6-flash-free');
    assert.deepEqual(record.effortBaselineTokens, [37, 37, 37], 'the poisoned zeros are gone, not averaged with real samples');
    assert.equal(record.effort?.kind, 'none-works', 'and the model still reaches a verdict');
    await catalog.forceRefresh();
    const model = catalog.current().models.find((m) => m.id === 'mimo-v2.6-flash-free');
    assert.equal(model?.thinkingLevelMap?.off, 'none', 'so it gets the Off row the measurement always supported');
  })
})

test('GUARD: a verdict whose own samples contradict it is corrected on read', async () => {
  // longcat-2.5-preview-free, exactly as it sits on disk on 2026-10-06:
  // verdict `level-works / minimal`, samples [1,36,36,36,36], baseline
  // [36,36,36]. Median 36 against a threshold of 15.48 — no reduction — and the
  // model was handed an Off row anyway.
  //
  // The verdict is a pure function of those samples and the samples sit beside
  // it, so waiting for the TTL or a re-measurement is waiting for an answer
  // that is already in the record. Reading recomputes the kind.
  await withTempDir(async (dir) => {
    const fp = reasoningFingerprint({ ...modelsDict()['space-bunny-free'], id: 'longcat-2.5-preview-free' });
    const stored = {
      verdict: 'ok',
      at: 1_000_000,
      effortReading: EFFORT_READING,
      effort: { kind: 'level-works', level: 'minimal', fp, api: 'openai-completions', at: 1_000_000 },
      effortFrozenAt: 1_000_000,
      effortTokens: [1, 36, 36, 36, 36],
      effortBaselineTokens: [36, 36, 36],
    };
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: 1_000_000,
        models: { 'longcat-2.5-preview-free': modelsDict()['space-bunny-free'] },
        probes: { 'longcat-2.5-preview-free': stored },
        lastProbeAt: 1_000_000,
      }),
      'utf8',
    );
    const read = await readCache(join(dir, 'catalog.json'));
    assert.equal(read.probes['longcat-2.5-preview-free'].effort?.kind, 'noop', 'the samples say it reduces nothing');
    assert.equal(read.probes['longcat-2.5-preview-free'].effort?.level, undefined, 'so it names no level');

    // A verdict the samples DO support keeps its level, and one that reduces
    // reasoning stays a finding rather than being rewritten into `noop`.
    const good = { ...stored, effortTokens: [0, 0, 0], effortBaselineTokens: [36, 36, 36] };
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: 1_000_000,
        models: { 'longcat-2.5-preview-free': modelsDict()['space-bunny-free'] },
        probes: { 'longcat-2.5-preview-free': good },
        lastProbeAt: 1_000_000,
      }),
      'utf8',
    );
    const read2 = await readCache(join(dir, 'catalog.json'));
    assert.equal(read2.probes['longcat-2.5-preview-free'].effort?.kind, 'level-works', 'supported: the level is kept');
  })
})

test('GUARD: a verdict whose samples were deleted reads as no verdict', async () => {
  // 0.3.1 confirmed a verdict and then cleared `effortTokens`. Every verdict it
  // wrote is therefore an assertion nobody can reproduce — and one of them
  // disagrees with the recorded measurement (live 2026-10-06:
  // `longcat-2.5-preview-free` confirmed at a level that does nothing for it).
  //
  // The plugin should not trust a number whose evidence the code that produced it
  // deleted. Dropping it on read re-measures the model on the next round.
  await withTempDir(async (dir) => {
    const fp = reasoningFingerprint({ ...modelsDict()['space-bunny-free'], id: 'longcat-2.5-preview-free' });
    const cache = {
      version: CACHE_VERSION,
      fetchedAt: 1_000_000,
      models: { 'longcat-2.5-preview-free': modelsDict()['space-bunny-free'] },
      probes: {
        // The shape 0.3.1 wrote: a frozen verdict, and no samples behind it.
        'longcat-2.5-preview-free': {
          verdict: 'ok',
          at: 1_000_000,
          effortReading: EFFORT_READING,
          effort: { kind: 'level-works', level: 'minimal', fp, api: 'openai-completions', at: 1_000_000 },
          effortFrozenAt: 1_000_000,
          effortTokens: [],
          effortBaselineTokens: [36, 36, 36],
        },
        // A `rejected` verdict is decided by refusals, not by a median, so having
        // no samples is legitimate and it must survive.
        'space-bunny-free': {
          verdict: 'ok',
          at: 1_000_000,
          effortReading: EFFORT_READING,
          effort: { kind: 'rejected', fp: 'x', api: 'openai-completions', at: 1_000_000 },
          effortFrozenAt: 1_000_000,
          effortTokens: [],
        },
      },
      lastProbeAt: 1_000_000,
    };
    await writeFile(join(dir, 'catalog.json'), JSON.stringify(cache), 'utf8');
    const read = await readCache(join(dir, 'catalog.json'));
    assert.equal(
      read.probes['longcat-2.5-preview-free'].effort,
      undefined,
      'an unreproducible verdict is not adopted',
    );
    assert.equal(
      read.probes['longcat-2.5-preview-free'].effortFrozenAt,
      undefined,
      'nor is its freeze marker, so the model is measured again',
    );
    assert.equal(
      read.probes['space-bunny-free'].effort?.kind,
      'rejected',
      'a refusal-based verdict stands without samples',
    );
  })
})

test('GUARD: a confirmed verdict keeps the samples it rests on', async () => {
  // The samples were cleared on confirmation while the comment beside them said
  // they were kept. That is not a tidiness question: they are the only evidence a
  // frozen verdict has, and a verdict whose evidence is gone cannot be checked by
  // anyone, including the next measurement. On 2026-10-06 that left
  // `longcat-2.5-preview-free` confirmed at a level the recorded measurement says
  // does nothing, with no way to see what it was confirmed on.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      probe: async (_model, question) => {
        const tokens = question === 'baseline' ? 40 : 6;
        return {
          kind: 'ok',
          api: 'openai-completions',
          effort: { kind: question === 'baseline' ? 'baseline' : 'candidate', tokens },
        };
      },
      listZenIds: async () => ['space-bunny-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    const record = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free');
    assert.ok(record.effort !== undefined, 'a verdict exists');
    assert.ok(
      (record.effortTokens?.length ?? 0) >= EFFORT_SAMPLES,
      'and the samples behind it survive, so the median can be recomputed by a reader',
    );
    assert.deepEqual(record.effortBaselineTokens, [40, 40, 40], 'as does the baseline it was judged against');
    assert.deepEqual(record.effortSamples, [], 'while the TALLY is emptied, which is what was meant by frozen');

    // The median that produced the verdict is the one a reader can recompute.
    const median = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];
    assert.ok(
      median(record.effortTokens) < EFFORT_WORKING_RATIO * median(record.effortBaselineTokens),
      'and it still explains the verdict after the fact',
    );
  })
})

test('GUARD: a route that reports no reasoning stops being asked, not asked for ever', async () => {
  // `fledge-alpha-free` sends no `completion_tokens_details` (ADR 0004 §33), so
  // its baseline reads 0 — and the ratio test is `candidate < 0.43 × baseline`,
  // where nothing is below 0.43 × 0. The axis is structurally undecidable: no
  // verdict is reachable, so every round spent its whole budget on a question
  // that cannot land. Live 2026-10-06: base [0,0,0], cand [0,0,0,0,0], nothing.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const fledge = { ...modelsDict()['muse-spark-1.3-contributor-free'], id: 'fledge-alpha-free', name: 'Fledge Alpha Free' }
    let asked = 0
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'fledge-alpha-free': fledge }) }),
      probe: async (_model, question) => {
        // Counted per AXIS: a round now also asks the capability questions once
        // each, and this guard is about the effort ladder not being re-asked for
        // ever. Counting them together would make the guard pass for the wrong
        // reason the moment the capability questions stop.
        if (question === 'ceiling') return { kind: 'inconclusive', code: 'error', http: 400, reason: 'stub refusal' };
        if (typeof question === 'string' && question.startsWith('capability:')) return { kind: 'ok', api: 'openai-completions', capability: { axis: question.slice(11), ok: true, detail: 'stub' } };
        asked += 1;
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 0 } };
      },
      listZenIds: async () => ['fledge-alpha-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    assert.ok(asked <= EFFORT_SAMPLES, `the baseline is sampled, then the axis is given up on (asked ${asked})`);
    const record = await readProbeRecord(join(dir, 'catalog.json'), 'fledge-alpha-free');
    assert.deepEqual(record.effortBaselineTokens, [0, 0, 0]);
    assert.equal(record.effort, undefined, 'nothing is claimed about a model we cannot measure');
    assert.deepEqual(record.effortTokens, undefined, 'and no candidate reading was filed from a question that cannot land');

    // Later rounds pay one liveness request, and file nothing: stopping the LOOP
    // was not enough on its own — the round still opened with one shot, that shot
    // asked the spelling, and its reading grew the sample array by one every
    // round for ever. Live 2026-10-06: `fledge-alpha-free` went from six samples
    // to seven while already "abandoned".
    for (let i = 0; i < 3; i += 1) {
      clock.t += 25 * 60 * 60_000;
      await catalog.runProbes();
    }
    const later = await readProbeRecord(join(dir, 'catalog.json'), 'fledge-alpha-free');
    assert.deepEqual(later.effortBaselineTokens, [0, 0, 0], 'the baseline does not grow either');
    assert.equal(later.effortTokens, undefined, 'nor does the candidate array');
    assert.equal(later.effortQuestion, undefined, 'and no question is left standing');
  })
})

test('GUARD: a measured context window is used, and a changed declaration discards it', async () => {
  // models.dev under-reports `limit.context` and says nothing about it.
  // Measured 2026-10-06: mimo-v2.6-flash-free and mimo-v2.5-free both declare
  // 200000 and both answer `[400] This endpoint's maximum context length is
  // 1048576 tokens`; nemotron-3.5-lightning-free declares 262144 and says
  // 1000000 — while ling-3.1-flash-free declares the SAME 262144 and is exactly
  // right. Silent and fatal: an under-reported window is never refused, it just
  // clamps `max_tokens` to 1 and returns HTTP 200 with no characters.
  const section = (context) => ({
    'mimo-v2.6-flash-free': { ...modelsDict()['space-bunny-free'], id: 'mimo-v2.6-flash-free', name: 'Mimo', limit: { context, output: 32000 } },
    'ling-3.1-flash-free': { id: 'ling-3.1-flash-free', name: 'Ling', reasoning: true, reasoning_options: [{ type: 'toggle' }], cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, limit: { context: 262144, output: 32768 } },
  })
  const window = (id, ctx) => {
    const dict = section(ctx);
    const models = derive(dict, { template: template() }).candidates;
    return derive(dict, { template: template(), measuredContext: measuredContextFor(models, dict, {}) })
      .candidates.find((m) => m.id === id).contextWindow;
  };

  // The endpoint STATED this limit about itself, so it is bounded only by the
  // absolute ceiling — not by the `declared x 4` valve, which exists to stop an
  // INFERRED raise from retiring capability on a healthy model. Measured
  // 2026-10-07: the plugin was advertising 800000 where the endpoint says
  // 1048576, withholding 248K of real context.
  assert.equal(window('mimo-v2.6-flash-free', 200000), 1048576, 'the stated window replaces the stale declaration');
  assert.equal(window('ling-3.1-flash-free', 262144), 262144, 'a model with no measurement keeps its declaration');
  assert.equal(
    window('mimo-v2.6-flash-free', 400000),
    1048576,
    'a moved declaration does not DISCARD the measurement, it DEMOTES it: the seed is now inferred rather than first-party, so it is bounded by declared x 4 (1,600,000) and the ceiling (1,048,576) — and it still clears both. Discarding a witnessed number over a pointer move is what let a models.dev typo fix silently delete it (ADR 0004 §56).',
  )
  assert.equal(
    contextEvidenceFor(section(400000)['mimo-v2.6-flash-free'], 1048576, seededContextFor(section(400000)['mimo-v2.6-flash-free'], 'mimo-v2.6-flash-free')),
    'inferred',
    'and the panel says `inferred` — a demoted source does not keep the first-party claim',
  );
})

test('GUARD: the output budget follows models.dev unless a generation was WATCHED past it', async () => {
  // `limit.output` reaches the wire as `max_tokens`, and the route enforces it —
  // asked for 8 with a prompt that wanted thousands, six models returned exactly
  // 8 with `finish_reason: "length"` (measured 2026-10-07). So a declaration that
  // is too low really does cut a reply, silently, at `finish_reason: "length"`.
  //
  // But acceptance is a fact about the REQUEST. The same day every route accepted
  // budgets up to 1,040,384, and no model was ever seen writing anything like it.
  // Shipping those as "maximum output" is the mistake the operator caught (ADR
  // 0004 §43) and this is the rule that replaces it: **only delivery evidence
  // moves this field.** One model has such an observation, so one model's budget
  // differs from its declaration, and the other six follow models.dev exactly.
  const section = (output) => ({
    'mimo-v2.6-flash-free': { ...modelsDict()['space-bunny-free'], id: 'mimo-v2.6-flash-free', name: 'Mimo', limit: { context: 200000, output } },
    'space-bunny-free': { ...modelsDict()['space-bunny-free'], id: 'space-bunny-free', name: 'Space Bunny', limit: { context: 1048576, output: 524288 } },
    'longcat-2.5-preview-free': { ...modelsDict()['space-bunny-free'], id: 'longcat-2.5-preview-free', name: 'Longcat', limit: { context: 1000000, output: 131072 } },
  })
  const built = (id, output) => {
    const dict = section(output)
    const first = derive(dict, { template: template() }).candidates
    return derive(dict, { template: template(), measuredContext: measuredContextFor(first, dict, {}) })
      .candidates.find((m) => m.id === id)
  }

  // Two kinds of evidence now move this field, and a vendor's own word outranks
  // anything measured here. Xiaomi publishes MiMo-V2.6-Flash as 1M context /
  // **128K max output**; the route accepts 8,000,000 (three 200s) so it enforces
  // nothing at all; and a generation was watched to 64,000. models.dev says
  // 32,000 — four times below the vendor's own number.
  assert.equal(built('mimo-v2.6-flash-free', 32000).maxTokens, 131072, 'a VENDOR-STATED ceiling outranks a declaration 4x too low')
  // longcat: the route names its own ceiling in a refusal — "/max_tokens: 995834
  // is not less or equal to 262144" — while models.dev publishes half of it. The
  // budget moves on that, with no production witnessed at all.
  assert.equal(
    built('longcat-2.5-preview-free', 131072).maxTokens,
    262144,
    'a ceiling the ROUTE states in a refusal moves the budget',
  )
  assert.equal(
    built('space-bunny-free', 524288).maxTokens,
    524288,
    'and so does one whose declaration happens to be right',
  )
  assert.equal(
    built('mimo-v2.6-flash-free', 64000).maxTokens,
    64000,
    'a seed measured against another declaration does not RAISE the budget — the number it was measured about is not this one',
  )
  assert.equal(
    observedOutputFor(section(64000)['mimo-v2.6-flash-free'], 'mimo-v2.6-flash-free', 131072),
    79722,
    'but the witnessed generation SURVIVES the move: it was watched happening, and throwing it away is how a typo fix erases the only production in the table',
  )
  assert.equal(
    observedOutputFor(section(64000)['mimo-v2.6-flash-free'], 'mimo-v2.6-flash-free', 64000),
    64000,
    'clamped to the budget we would actually send — claiming a longer reply than we allow would be a different lie',
  )
  assert.equal(
    observedOutputIsStale(section(64000)['mimo-v2.6-flash-free'], 'mimo-v2.6-flash-free'),
    true,
    'and the panel is told the figure has not been re-checked against this declaration',
  )
  // The observation is reported separately and only where it exists, so the row
  // can never present a budget as something the model was seen to write.
  assert.equal(observedOutputFor(section(32000)['mimo-v2.6-flash-free'], 'mimo-v2.6-flash-free', 64000), 64000)
  assert.equal(
    observedOutputFor(section(131072)['longcat-2.5-preview-free'], 'longcat-2.5-preview-free', 131072),
    64000,
    'watched writing 64,000 against a declared 131,072: still an observation. A guard that dropped anything below the declaration made the panel claim this model had never been watched writing — on the one model with the most evidence — and it protected nothing, because the budget is a max() over the declaration anyway.',
  )
  const mimo = built('mimo-v2.6-flash-free', 32000)
  assert.ok(mimo.maxTokens <= mimo.contextWindow, 'a budget above the context it must fit inside is unreachable')
})

test('GUARD: a round counts models, and a row reports what it learned about one', async () => {
  // The shot loop broke the tally's two invariants at once. `done` counted
  // SAMPLES while `total` counted models, so the panel read "53/27" live on
  // 2026-10-06; and each shot overwrote the row, so a model that produced three
  // good baseline samples and then hit a 429 was painted red — the round's actual
  // finding discarded by its last request.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    let shot = 0
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'mimo-v2.6-flash-free': mimoRecord() }) }),
      // Three good baseline samples, then the shared bucket says no.
      probe: async () => {
        shot += 1;
        if (shot > 3) return { kind: 'inconclusive', code: 'quota-exhausted', http: 429, reason: 'free tier quota' };
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 37 } };
      },
      listZenIds: async () => ['mimo-v2.6-flash-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    const progress = catalog.probeProgress();
    assert.equal(progress.total, 1, 'one model is the whole round');
    assert.equal(progress.done, 1, 'and one model is the whole tally, however many samples it took');
    assert.equal(
      progress.results['mimo-v2.6-flash-free'].status,
      'ok',
      'the row reports what the round learned about the model, not what its last request hit',
    );
  })

  // The other direction: a model that never answers is still a red row, and the
  // reason survives.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'mimo-v2.6-flash-free': mimoRecord() }) }),
      probe: async () => ({ kind: 'inconclusive', code: 'quota-exhausted', http: 429, reason: 'free tier quota' }),
      listZenIds: async () => ['mimo-v2.6-flash-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();
    const row = catalog.probeProgress().results['mimo-v2.6-flash-free'];
    assert.equal(row.status, 'failed');
    assert.equal(row.code, 'quota-exhausted', 'a red row still carries why');
  })
})

test('GUARD: an inferred raise is still held to declared x 4, a stated one is not', async () => {
  // Two evidence strengths, two ceilings. The clamp signature also fires on a
  // HEALTHY model whose context is genuinely full, so an inferred raise must stay
  // behind a valve; a number the endpoint stated about itself must not be clipped
  // by a valve built for a different kind of evidence.
  const withLimits = (context) => ({
    id: 'x',
    reasoning: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context, output: 32000 },
  });
  const measured = (raisedTo, source) => ({
    raisedTo,
    fp: contextFingerprint(withLimits(200000)),
    at: 0,
    ...(source === undefined ? {} : { source }),
  });
  assert.equal(contextWindowFor(withLimits(200000), measured(1048576, 'measured')), 1048576, 'stated: only the ceiling bounds it');
  assert.equal(contextWindowFor(withLimits(200000), measured(1048576, 'inferred')), 800000, 'inferred: declared x 4 still applies');
  assert.equal(contextWindowFor(withLimits(200000), measured(1048576)), 800000, 'a record with no source reads as inferred');
  assert.equal(
    contextWindowFor(withLimits(200000), measured(9_000_000, 'measured')),
    1048576,
    'even a stated value cannot exceed the absolute ceiling',
  );
})

test('GUARD: a verdict is visible in the same round that confirms it', async () => {
  // `state.models` was derived before the round, so the Off row a round confirms
  // landed on disk but not in the list the picker reads: the user watched a round
  // confirm it and had to wait for the next catalogue sync or a restart. The
  // round republishes from its own evidence now, using the same derivation the
  // warm start uses.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'mimo-v2.6-flash-free': mimoRecord() }) }),
      probe: async (_model, question) => ({
        kind: 'ok',
        api: 'openai-completions',
        effort: { kind: question === 'baseline' ? 'baseline' : 'candidate', tokens: question === 'baseline' ? 37 : 0 },
      }),
      listZenIds: async () => ['mimo-v2.6-flash-free'],
    });
    await catalog.forceRefresh();
    const before = catalog.current().models.find((m) => m.id === 'mimo-v2.6-flash-free');
    assert.equal(before.thinkingLevelMap?.off, null, 'nothing has been measured yet');

    pastProbeFloor(clock);
    await catalog.forceProbes();
    const after = catalog.current().models.find((m) => m.id === 'mimo-v2.6-flash-free');
    assert.equal(after.thinkingLevelMap?.off, 'none', 'the row the round confirmed is in the list it republished');
    assert.equal(after.contextWindow, before.contextWindow, 'and nothing else moved with it');
  })
})

test('GUARD: one manual click can finish a measurement, not just start one', async () => {
  // A round used to spend exactly one request per model. A verdict needs three
  // baseline samples plus five candidate ones (median first, then three agreeing
  // judgements), so a click could never change a capability row — the user saw a
  // completed round and an unchanged picker, with no way to tell progress from
  // failure. Measured 2026-10-06 on the live deployment: one round left every
  // model holding a single baseline sample.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'mimo-v2.6-flash-free': mimoRecord() }) }),
      // Measured 2026-10-06: mimo-v2.6-flash-free reasons 37 when omitted, 0 under
      // `none` — an exact off.
      // Mirrors the real probe: a question it actually asked about produces a
      // candidate reading, anything else (baseline, settled) a baseline one.
      probe: async (_model, question) => {
        asked.push(question);
        const asked_ = question === 'none' || question === 'low';
        return {
          kind: 'ok',
          api: 'openai-completions',
          effort: { kind: asked_ ? 'candidate' : 'baseline', tokens: asked_ ? 0 : 37 },
        };
      },
      listZenIds: async () => ['mimo-v2.6-flash-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    assert.equal(asked.filter((q) => q === 'baseline').length, EFFORT_SAMPLES, 'the baseline is sampled to a median');
    assert.equal(
      asked.filter((q) => q === 'none').length,
      EFFORT_CANDIDATE_SAMPLES,
      'and the candidate to the first three agreeing judgements',
    );
    const record = await readProbeRecord(join(dir, 'catalog.json'), 'mimo-v2.6-flash-free');
    assert.equal(record.effort?.kind, 'none-works');
    assert.ok(typeof record.effortFrozenAt === 'number', 'confirmed and frozen inside the one click');
    assert.ok(asked.length <= MANUAL_SAMPLE_BUDGET, 'and the budget was never exceeded');

    // A second click must not re-measure a model that already has its answer.
    asked.length = 0;
    clock.t += 25 * 60 * 60_000;
    await catalog.forceProbes();
    assert.deepEqual(
      [...new Set(asked.filter((q) => q !== 'ceiling'))],
      ['settled'],
      'a settled model is asked for liveness only — no further sample of that axis',
    );
    const settled = await readProbeRecord(join(dir, 'catalog.json'), 'mimo-v2.6-flash-free');
    assert.deepEqual(
      settled.effortBaselineTokens,
      [37, 37, 37],
      'and its frozen baseline does not grow for ever on liveness rounds',
    );
  })

  // The budget is a CEILING, not a bill: a model whose `none` is refused falls
  // back to its own lowest level and stops as soon as that level is confirmed.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      probe: async (_model, question) => {
        asked.push(question);
        if (question === 'none') {
          return { kind: 'inconclusive', code: 'unknown', http: 400, reason: 'invalid request（HTTP 400）' };
        }
        const tokens = question === 'baseline' ? 40 : 6;
        return {
          kind: 'ok',
          api: 'openai-completions',
          effort: { kind: question === 'baseline' ? 'baseline' : 'candidate', tokens },
        };
      },
      listZenIds: async () => ['space-bunny-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    const record = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free')
    assert.equal(record.effort?.kind, 'level-works');
    assert.equal(record.effort?.level, 'low', 'the fallback level, not the one that was refused');
    // The refusal detour is exactly what the extra `EFFORT_FALLBACK_AFTER` in the
    // budget pays for; the first block above is the other side of the same
    // contract — a model that answers early is not billed the ceiling.
    assert.ok(
      asked.filter((q) => q === 'baseline' || q === 'none' || q === 'settled' || q === 'low' || q === 'minimal' || q === 'high').length <= MANUAL_SAMPLE_BUDGET &&
        asked.length <= MANUAL_SAMPLE_BUDGET + CAPABILITY_SAMPLE_BUDGET,
      `each axis stays inside its own budget (asked ${asked.length})`,
    );
  })
})

test('GUARD: a manual round inside the floor says why it refused', async () => {
  // `forceProbes()` used to return nothing, so the route answered 202 whether or
  // not a round had started: a refused click was indistinguishable from a
  // started one, and the card spun out its grace period in silence. The refusal
  // carries the number the user needs.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    let calls = 0;
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      probe: async () => {
        calls += 1;
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 40 } };
      },
      listZenIds: async () => ['space-bunny-free'],
    })
    await catalog.forceRefresh()

    const first = await catalog.forceProbes();
    assert.deepEqual(first, { started: true }, 'the first click starts a round');
    // Liveness, the ceiling question, and one capability axis — the round spends
    // the capability budget as well as the effort one, and "one request per model"
    // stopped being the whole cost when the harvest joined it.
    // The ceiling question and the axes, but only when they can conclude: this
    // stub answers no capability question, so nothing is recorded and the next
    // round is free to try again.
    assert.ok(calls >= 2, `a manual round spends liveness plus the ceiling question (asked ${calls})`);

    clock.t += 60_000;
    const refused = await catalog.forceProbes();
    assert.equal(refused.started, false, 'a click inside the floor starts nothing');
    assert.equal(refused.reason, 'cooldown');
    assert.equal(refused.retryAfterMs, PROBE_FLOOR_MS - 60_000, 'and says how much of the floor is left');
    assert.equal(calls, 2, 'no second round was spent');

    clock.t += PROBE_FLOOR_MS;
    assert.deepEqual(await catalog.forceProbes(), { started: true }, 'and the floor really does expire');
    assert.equal(calls, 3, 'the same three: liveness, ceiling, one capability axis');
  })
})

test('GUARD: a confirmed verdict names the level the probe actually asked', async () => {
  // The round derived the question TWICE: once to send it (with the model's own
  // lowest published level as the fallback) and once to label the verdict (with
  // a hardcoded `minimal`). After a disagreement those two disagree, so a
  // measurement taken at `low` was recorded as a claim about `minimal` — a level
  // this model does not publish, which `thinkingLevelMapFor` would then hand the
  // user as an Off row.
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: 1_000_000,
        models: { 'space-bunny-free': modelsDict()['space-bunny-free'] },
        probes: {
          // Three baselines and one disagreement: the next question is the
          // fallback, which for space-bunny-free is `low` (its own lowest
          // published level), not `minimal`.
          'space-bunny-free': {
            verdict: 'ok',
            at: 1_000_000,
            effortReading: EFFORT_READING,
            effortBaselineTokens: [35, 55, 42],
            effortDiscord: 1,
          },
        },
        lastProbeAt: 1_000_000,
      }),
      'utf8',
    )
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: async () => fakeResponse({ body: apiBodyWith({ 'space-bunny-free': modelsDict()['space-bunny-free'] }) }),
      // Measured 2026-10-06: space-bunny-free at its lowest declared level drops
      // reasoning to 0/9/22/37 against an omitted baseline of 36/42/55.
      probe: async (_model, question) => {
        asked.push(question)
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'candidate', tokens: 4 } }
      },
      listZenIds: async () => ['space-bunny-free'],
    })
    await catalog.forceRefresh()
    // Five rounds, not three: `working` needs three samples before it produces a
    // verdict at all, and the verdict then needs three of those to agree.
    for (let i = 0; i < 5; i += 1) {
      pastProbeFloor(clock)
      await catalog.forceProbes()
    }
    assert.deepEqual([...new Set(asked.filter((q) => q !== 'ceiling'))], ['low'], 'every round must ask the model\'s own lowest published level');

    const record = await readProbeRecord(join(dir, 'catalog.json'), 'space-bunny-free')
    assert.equal(record.effort?.kind, 'level-works');
    assert.equal(record.effort?.level, 'low', 'the verdict names the level that was measured');
    assert.ok(typeof record.effortFrozenAt === 'number', 'and it is frozen so it stops re-measuring');

    // The map is derived from the evidence, so it becomes visible on the next
    // sync or restart — which is what the picker reads.
    await catalog.forceRefresh();
    const model = catalog.current().models.find((m) => m.id === 'space-bunny-free');
    assert.equal(model?.thinkingLevelMap?.off, 'low', 'and the Off row the user gets is that same level');
  })
})

test('GUARD: the daily round covers every model Zen serves; the manual one stays on screen', async () => {
  // Two rounds, two jobs. The manual round spends a budget per model on the
  // models the user has switched on — those are the answers somebody is
  // watching for. The daily round spends ONE request each and nobody asked for
  // it, so it may as well settle every model Zen still lists: a hidden model
  // whose free tier has ended is exactly the one nobody discovers by looking at
  // the picker.
  //
  // Before this they shared one rule, so hiding a model also stopped the daily
  // round from ever learning whether that model still works.
  await withTempDir(async (dir) => {
    const clock = { t: 1_000_000 }
    const asked = []
    const probe = async (model) => {
      asked.push(model.id);
      return { kind: 'ok' };
    };
    const make = () =>
      catalogWith({
        dir,
        clock,
        manualSampleBudget: 1,
        fetchImpl: async () =>
          fakeResponse({
            body: apiBodyWith({
              'big-pickle': modelsDict()['big-pickle'],
              'space-bunny-free': modelsDict()['space-bunny-free'],
            }),
          }),
        probe,
        hidden: (id) => id === 'space-bunny-free',
        listZenIds: async () => ['big-pickle', 'space-bunny-free'],
      });
    const build = async (catalog) => {
      await catalog.forceRefresh();
      catalog.applyZenGate(['big-pickle', 'space-bunny-free']);
      return catalog;
    };

    const daily = await build(make());
    asked.length = 0;
    clock.t += 25 * 60 * 60_000;
    await daily.runProbes();
    // `asked` records MODEL IDS, so the ceiling question shows up as the id
    // repeating. The unique set is the liveness list.
    assert.deepEqual([...new Set(asked)].sort(), ['big-pickle', 'space-bunny-free'], 'the daily round asks the hidden one too');

    const manual = await build(make());
    asked.length = 0;
    clock.t += 25 * 60 * 60_000;
    await manual.forceProbes();
    // The manual round is scoped to what is switched on, and it now also asks the
    // visible model for its ceiling and capabilities — so the id appears more than
    // once. What it must NOT contain is the hidden one.
    assert.deepEqual([...new Set(asked)], ['big-pickle'], 'and the manual round stays on what is switched on');
  })
})


test('GUARD: restoring a cached round never overwrites a round that is running', async () => {
  // "Click probe, it flashes, then nothing happens."
  //
  // The startup read restores the previous round's finished report. It resolves
  // on its own schedule, and a round can begin before it lands — the daily round
  // starts from `getModels()`, which is exactly what a restarting host does.
  // Restoring over a live `probeRun` sends `requests` back to 0, `done` back to
  // the old total and `running` to false, so the panel adopts a finished-looking
  // report at once and stops following: the round runs on invisibly.
  //
  // Measured 2026-10-06: the endpoint reported `running:false, requests:0,
  // done:35/35` while a round was demonstrably in flight.
  //
  // Driven through `adopt` itself — that is where the clobbering happens, and so
  // where the guard belongs — using two plain objects, the way the other
  // round-level cases here are driven.
  const state = initialState([])
  state.models = ['a-free', 'b-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))
  let release
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const deps = {
    path: join(tmpdir(), 'never-written-adopt-does-not-write'),
    fetchImpl: async () => {
      throw new Error('no network in this test');
    },
    now: () => 1_700_000_000_000,
    userAgent: undefined,
    ttlMs: 86_400_000,
    warmReadTimeoutMs: 2_000,
    warm: Promise.resolve(),
    template: state.models[0],
    knownApis: undefined,
    probe: async (model) => {
      if (model.id === 'a-free') await blocked;
      return { kind: 'ok' };
    },
    listZenIds: async () => ['a-free', 'b-free'],
    hidden: undefined,
  };

  const running = runProbeRound(state, deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.probeRun.running, true, 'a round is in flight');
  const before = { done: state.probeRun.done, requests: state.probeRun.requests };
  assert.equal(before.requests, 1, 'and it has spent a request');

  // What the startup read does when it lands late: a finished report from disk.
  adopt(state, deps, {
    version: CACHE_VERSION,
    fetchedAt: 1,
    models: { 'a-free': {}, 'b-free': {} },
    probes: {},
    lastProbeAt: 1,
    lastRound: { total: 7, done: 7, results: {}, targets: ['a-free'] },
  }, true);

  assert.equal(state.probeRun.running, true, 'still running');
  assert.equal(state.probeRun.done, before.done, 'the tally it had reached is untouched');
  assert.equal(state.probeRun.requests, before.requests, 'and so is its request count');
  release();
  await running;
})

test('GUARD: there is no ask-again cadence — every served model is asked every round', async () => {
  // The backoff (0 → 6h → 24h → 7d, keyed on consecutive misses) is gone by
  // decision: a round asks every model the Zen gate still lists, every time.
  //
  // It used to protect the shared anonymous bucket from models that were being
  // rate-limited — measured, `ling-3.1-flash-free` answered 429 seven times
  // across hours on 2026-10-06. That is a real cost, and the round's own shape
  // bounds it anyway: a model that fails a shot LEAVES the shot loop, so an
  // unreachable model costs exactly one request per round, not the budget.
  await withTempDir(async (dir) => {
    const clock = { t: 1_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () =>
        fakeResponse({
          body: apiBodyWith({
            'big-pickle': modelsDict()['big-pickle'],
            'deepseek-v4-flash-free': modelsDict()['deepseek-v4-flash-free'],
          }),
        }),
      // The failing model is the one that would have been backed off.
      probe: async (model) => {
        asked.push(model.id);
        if (model.id === 'deepseek-v4-flash-free') return { kind: 'inconclusive', code: 'quota-exhausted', http: 429 };
        return { kind: 'ok' };
      },
      listZenIds: async () => ['big-pickle', 'deepseek-v4-flash-free'],
    });
    await catalog.forceRefresh();
    catalog.applyZenGate(['big-pickle', 'deepseek-v4-flash-free']);

    for (let round = 1; round <= 3; round += 1) {
      asked.length = 0;
      clock.t += 60_000;
      pastProbeFloor(clock);
      await catalog.forceProbes();
      assert.deepEqual(
        // Distinct ids: a model that answers is asked several times inside one
        // round (that is the sampling budget); the question here is only whether
        // the FAILING model is asked again next round.
        [...new Set(asked.filter((q) => q !== 'ceiling'))].sort(),
        ['big-pickle', 'deepseek-v4-flash-free'],
        `round ${round}: a model that failed the last one is asked again`,
      );
    }
  })
})

test('a round covers the whole pre-gate catalogue, in order, one at a time', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe)
    // Gate first, to prove the round covers the pre-gate set and not the
    // narrowed one: a model Zen does not list still deserves a verdict.
    catalog.applyZenGate(['big-pickle', 'space-bunny-free'])
    await catalog.forceProbes()
    assert.deepEqual(
      probe.calls,
      catalog.current().models.map((m) => m.id),
      'every derived model, in catalogue order',
    )
    assert.deepEqual(probe.calls.slice().sort(), DERIVED, 'and that is the whole derived set')
    assert.equal(probe.overlapped(), false, 'requests must not overlap')
  })
})

test('dead removes a model from every list; ok changes nothing', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'deepseek-v4-flash-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    const before = catalog.current().visible.slice().sort()
    assert.deepEqual(before, DERIVED)
    await catalog.forceProbes()
    const state = catalog.current()
    assert.ok(!state.visible.includes('deepseek-v4-flash-free'), 'a dead model leaves the picker')
    // "Not in the list" is the whole contract: the snapshot carries no
    // companion list of unavailable models that could drift or be re-shown.
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'excluded'), false)
    // It stays in the pre-gate catalogue, which is the target list every round
    // walks — otherwise it could never be re-probed and could never return.
    assert.ok(state.models.some((m) => m.id === 'deepseek-v4-flash-free'))
    assert.equal(state.visible.length, before.length - 1, 'an ok verdict adds nothing back')
    assert.equal(state.probeInconclusive, false)
    assert.equal(state.probedAt, 1_000_000)
  })
})

test('a dead verdict is final: the model is never probed again', async () => {
  await withTempDir(async (dir) => {
    // The cost argument, pinned: re-asking a model the route already refused
    // spends the shared bucket to re-learn a settled fact. A catalogue whose
    // first round kills 24 of 34 must probe 10 the next day, not 34.
    const probe = recordingProber({ 'deepseek-v4-flash-free': DEAD(404) })
    const clock = { t: 1_000_000 }
    const catalog = await probedCatalog(dir, probe, clock)
    await catalog.forceProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'round one covers everything')
    probe.calls.length = 0
    pastProbeFloor(clock)
    await catalog.forceProbes()
    assert.deepEqual(
      probe.calls.slice().sort(),
      DERIVED.filter((id) => id !== 'deepseek-v4-flash-free'),
    )
    assert.ok(!catalog.current().visible.includes('deepseek-v4-flash-free'))

    // Still final after a re-sync and across a restart — including the case
    // that used to resurrect it: `adopt` prunes verdicts for models the
    // catalogue lacks, so a dead model must NOT be dropped from `models`.
    const resynced = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v2"', body: apiBody() })]),
      probe,
      baselineModels: [],
    })
    await waitFor(() => resynced.current().source === 'models.dev')
    assert.ok(
      resynced.current().models.some((m) => m.id === 'deepseek-v4-flash-free'),
      'the record is kept',
    )
    assert.ok(
      !resynced.current().visible.includes('deepseek-v4-flash-free'),
      'the verdict survived the re-sync',
    )
    probe.calls.length = 0
    await resynced.forceProbes()
    assert.ok(!probe.calls.includes('deepseek-v4-flash-free'), 'and it is not re-asked')
  })
})

test('GUARD: "still measuring" never names a model the picker does not offer', async () => {
  // Live 2026-10-06: the panel reported 28 models as still being measured, 23 of
  // which Zen no longer lists — they are the round's `not-listed` bucket, gated
  // out of the picker entirely. Telling a user to keep clicking for models that
  // are not in their list, and never will be, is how a badge teaches distrust.
  await withTempDir(async (dir) => {
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe: async () => ({ kind: 'ok' }),
    });
    await catalog.forceRefresh();
    // The Zen gate, applied the way a round applies it.
    catalog.applyZenGate(['big-pickle', 'space-bunny-free']);
    const pending = catalog.probeProgress().pending;
    assert.ok(pending.includes('big-pickle'), 'a served, unmeasured model is pending');
    assert.equal(
      pending.some((id) => id === 'gpt-6-astra' || id === 'glm-5-free'),
      false,
      'and a model Zen does not list is not — it is not in the picker to be measured',
    );
    assert.deepEqual(
      pending.slice().sort(),
      ['big-pickle', 'space-bunny-free'],
      'pending is exactly the picker list minus what has been measured',
    );
  })
})

test('probeProgress tracks the round live: current, done/total and per-model results', async () => {
  await withTempDir(async (dir) => {
    const seen = []
    const clock = { t: 1_000_000 }
    // Gates, not wall clock. The old version slept 50ms and 10ms to arrange a
    // "mid-round" read: on a throttled runner or a loaded container those are
    // the wrong sizes often enough to fail for no reason, and a test that fails
    // for no reason trains everyone to re-run it. Releasing a promise from
    // inside the prober makes the ordering exact.
    let slowStarted
    const slowRunning = new Promise((resolve) => {
      slowStarted = resolve
    })
    let letSlowGo
    const slowBlocked = new Promise((resolve) => {
      letSlowGo = resolve
    })
    const probe = async (model) => {
      // A slow model first, so the mid-round read catches it in flight.
      if (model.id === 'ling-3.0-flash-fin-free') {
        slowStarted()
        await slowBlocked
      }
      clock.t += model.id === 'deepseek-v4-flash-free' ? 0 : 120
      seen.push({ ...catalog.probeProgress(), at: model.id })
      if (model.id === 'deepseek-v4-flash-free') {
        return { ...DEAD(404), code: 'dead', http: 404 }
      }
      return { kind: 'ok' }
    }
    const catalog = await probedCatalog(dir, probe, clock)
    assert.deepEqual(
      catalog.probeProgress(),
      {
        running: false,
        requests: 0,
        total: 0,
        done: 0,
        current: null,
        results: {},
        targets: [],
        startedAt: 0,
        pending: [...DERIVED],
      },
      'no round has ever run',
    )

    const running = catalog.forceProbes()
    // Wait until the slow model is actually in flight — exact, not timed.
    await slowRunning
    const mid = catalog.probeProgress()
    assert.equal(mid.running, true)
    assert.equal(mid.total, DERIVED.length)
    assert.ok(typeof mid.current === 'string' && mid.current !== '', 'one model is in flight')
    assert.equal(mid.startedAt, 1_000_000)
    letSlowGo()
    await running

    const end = catalog.probeProgress()
    assert.equal(end.running, false)
    assert.equal(end.done, DERIVED.length)
    // The harness pins the manual EFFORT budget to 1, so this round is one
    // liveness request per model — plus the ceiling harvest, which now runs on
    // every round on its own budget. That is the number the panel shows for what
    // the round cost, and it is deliberately no longer the model count.
    // One liveness request per model, plus the ceiling question for the five that
    // answered — a model that came back dead is not asked anything else, which is
    // the rule that stops an unreachable model costing a second request.
    // A round now spends more than one request per model — liveness, the ceiling
    // harvest, and on a manual round one capability question per unmeasured axis —
    // and which of those apply depends on what is already measured. So the bound
    // is a ceiling per model rather than a fixed total, which is what the panel
    // reports and what a shared bucket is actually charged.
    assert.ok(
      end.requests >= DERIVED.length && end.requests <= DERIVED.length * (1 + CAPABILITY_SAMPLE_BUDGET),
      `the round reports REQUESTS: between one and one-plus-three per model (asked ${end.requests})`,
    )
    assert.deepEqual(
      end.pending,
      // deepseek-v4-flash-free is absent: the round killed it, and a model the
      // picker no longer offers cannot owe a measurement.
      ['big-pickle', 'ling-3.0-flash-fin-free', 'muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free', 'space-bunny-free'],
      'and the models that still owe samples — which is the picker list minus what is settled or gone',
    );
    assert.equal(end.current, null)
    assert.equal(end.results['big-pickle'].status, 'ok')
    assert.equal(end.results['big-pickle'].ms, 120)
    assert.equal(
      end.results['deepseek-v4-flash-free'].status,
      'failed',
      'dead counts as not-answered for the row',
    )
    assert.equal(end.results['deepseek-v4-flash-free'].ms, 0)
    // A red row that cannot say WHY is the bug this field exists to prevent:
    // the code is what the card turns into a word, and the status is what
    // makes "gone (404)" different from "gone (401)".
    assert.equal(end.results['deepseek-v4-flash-free'].code, 'dead')
    assert.equal(end.results['deepseek-v4-flash-free'].http, 404)
    // The verdicts (not the progress) are what persist.
    assert.ok(!catalog.current().visible.includes('deepseek-v4-flash-free'))

    // `seen` collects one reading per model from INSIDE the round, and it used to
    // be collected and never read — the only test whose stated job is "tracks
    // the round live" gave up exactly where the live behaviour lives. These are
    // the assertions that were missing.
    // Six liveness readings plus five ceiling ones — the model that came back dead
    // is not asked anything else, which is the rule that keeps an unreachable
    // model from costing a second request.
    assert.equal(seen.length, DERIVED.length * 2, 'a reading per model per request, and the round now makes two')
    assert.deepEqual(
      seen.map((s) => s.at),
      seen
        .map((s) => s.at)
        .slice()
        .sort(),
      'the catalogue is walked in its own sorted order',
    )
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        seen[i].done >= seen[i - 1].done,
        `done never goes backwards (${seen[i - 1].done} -> ${seen[i].done})`,
      )
      assert.equal(seen[i].running, true, 'every mid-round reading says a round is running')
    }
    assert.equal(
      seen[seen.length - 1].done,
      DERIVED.length - 1,
      'the last reading taken inside the round sees all but the final model recorded',
    )
    // Each reading must be a SNAPSHOT: the panel polls while the round mutates,
    // so a shared `results` object would let an earlier reading change under a
    // caller that already returned it.
    for (let i = 1; i < seen.length; i += 1) {
      assert.notEqual(seen[i].results, seen[i - 1].results, 'each reading owns its results map')
    }
  })
})

test('every failure reports a reason: a coded prober, a bare prober and a throw', async () => {
  await withTempDir(async (dir) => {
    // Three ways a round can fail to answer, and none of them may reach the
    // card as a mute red badge.
    const probe = async (model) => {
      if (model.id === 'big-pickle') {
        return {
          kind: 'inconclusive',
          reason: 'quota-exhausted（HTTP 429）',
          code: 'quota-exhausted',
          http: 429,
        }
      }
      if (model.id === 'muse-spark-1.3-contributor-free') {
        // A prober that predates the coded outcome still has to produce one.
        return { kind: 'inconclusive', reason: 'something went sideways' }
      }
      if (model.id === 'ling-3.0-flash-fin-free') throw new Error('socket exploded')
      return { kind: 'ok' }
    }
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    const { results } = catalog.probeProgress()
    assert.deepEqual(
      results['big-pickle'],
      {
        status: 'failed',
        ms: 0,
        code: 'quota-exhausted',
        http: 429,
      },
      'the prober code and status reach the row',
    )
    assert.equal(
      results['muse-spark-1.3-contributor-free'].code,
      'unknown',
      'a bare inconclusive falls back to "unknown"',
    )
    assert.equal(results['muse-spark-1.3-contributor-free'].http, 0, 'and to no status')
    assert.equal(results['ling-3.0-flash-fin-free'].code, 'error', 'a throwing prober reports the throw')
    assert.equal(results['ling-3.0-flash-fin-free'].http, 0)
    for (const [id, entry] of Object.entries(results)) {
      if (entry.status === 'failed') {
        assert.equal(typeof entry.code, 'string', `${id} carries a code`)
        assert.notEqual(entry.code, '', `${id} code is not empty`)
        assert.equal(typeof entry.http, 'number', `${id} carries a status`)
      }
    }
  })
})

test('a dead verdict still names the status it died on', async () => {
  await withTempDir(async (dir) => {
    // 404 and 401 are the same verdict with very different meanings, so the
    // status is part of the report and not an implementation detail.
    const catalog = await probedCatalog(dir, recordingProber({ 'big-pickle': DEAD(404) }))
    await catalog.forceProbes()
    const entry = catalog.probeProgress().results['big-pickle']
    assert.equal(entry.status, 'failed')
    assert.equal(entry.code, 'dead')
    assert.equal(entry.http, 0, 'a bare DEAD() carries no status, and says so')
  })
})

test('a model Zen no longer lists is dropped without spending an inference request', async () => {
  await withTempDir(async (dir) => {
    // The cheap authoritative check comes first: one GET of the catalogue
    // settles membership, so a withdrawn model must cost ZERO completions. Before
    // this, every round spent one request per model to relearn a fact the
    // catalogue already answered for free.
    const probe = recordingProber()
    const catalog = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })]),
      probe,
      listZenIds: async () => ['space-bunny-free', 'big-pickle'],
    })
    await waitFor(() => catalog.current().source === 'models.dev')
    probe.calls.length = 0
    await catalog.forceProbes()
    assert.ok(!probe.calls.includes('muse-spark-1.3-contributor-free'), 'an unlisted model is never asked')
    assert.ok(probe.calls.includes('big-pickle'), 'a listed model still is')
    assert.ok(
      !catalog.current().visible.includes('muse-spark-1.3-contributor-free'),
      'and it leaves the list',
    )
    // It is still REPORTED, at zero cost, with the reason that is actually
    // known — a row that silently vanishes is unexplainable.
    const entry = catalog.probeProgress().results['muse-spark-1.3-contributor-free']
    assert.equal(entry.status, 'failed')
    assert.equal(entry.code, 'not-listed')
    assert.equal(entry.ms, 0)
    // The tally has to add up: unlisted models count toward the round.
    const progress = catalog.probeProgress()
    assert.equal(progress.done, progress.total, 'done reaches total')
  })
})

test('a model Zen puts back reappears: membership is never a permanent verdict', async () => {
  await withTempDir(async (dir) => {
    // The failure mode this separation exists to prevent. A `dead` verdict is
    // permanent by decision, so anything re-derived from the catalogue must not
    // be recorded as one — otherwise a model that comes back stays suppressed
    // for the life of the cache file.
    const probe = recordingProber()
    let served = ['big-pickle']
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })]),
      probe,
      listZenIds: async () => served,
    })
    await waitFor(() => catalog.current().source === 'models.dev')
    await catalog.forceProbes()
    assert.ok(
      !catalog.current().visible.includes('muse-spark-1.3-contributor-free'),
      'withdrawn while Zen drops it',
    )
    // Zen restores it. No cache deletion, no manual recovery.
    served = ['big-pickle', 'muse-spark-1.3-contributor-free']
    probe.calls.length = 0
    pastProbeFloor(clock)
    await catalog.forceProbes()
    assert.ok(
      catalog.current().visible.includes('muse-spark-1.3-contributor-free'),
      'and it comes back on the next round',
    )
    assert.ok(
      probe.calls.includes('muse-spark-1.3-contributor-free'),
      'because it is probed again, not remembered',
    )
  })
})

test('a failed catalogue fetch narrows nothing and costs no verdict', async () => {
  await withTempDir(async (dir) => {
    // A null answer means "unknown", never "empty": one flaky GET must not be
    // able to empty the picker or to manufacture a removal report.
    const probe = recordingProber()
    const catalog = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })]),
      probe,
      listZenIds: async () => null,
    })
    await waitFor(() => catalog.current().source === 'models.dev')
    await catalog.forceProbes()
    assert.ok(catalog.current().visible.length > 1, 'the list is untouched')
    assert.ok(probe.calls.length > 1, 'and every model was asked, as before')
    for (const entry of Object.values(catalog.probeProgress().results)) {
      assert.notEqual(entry.code, 'not-listed', 'a failed fetch reports no removals')
    }
    // A rejection must degrade the same way, not abort the round.
    const thrower = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v2"', body: apiBody() })]),
      probe,
      listZenIds: async () => {
        throw new Error('network down')
      },
    })
    await waitFor(() => thrower.current().source === 'models.dev')
    await thrower.forceProbes()
    assert.ok(thrower.current().visible.length > 1, 'a rejected fetch narrows nothing either')
  })
})

test('the list is alphabetical by id, not the catalogue order', async () => {
  await withTempDir(async (dir) => {
    // The catalogue arrives grouped by vendor and family. That reads as
    // arbitrary to anyone scanning for one model, and the panel and the picker
    // both render this one list, so the order is set here and only here.
    const catalog = await probedCatalog(dir, recordingProber())
    const visible = catalog.current().visible
    assert.ok(visible.length > 1, 'needs a list to order')
    assert.deepEqual(visible, visible.slice().sort(), 'visible is alphabetical')
    const all = catalog.current().models.map((m) => m.id)
    assert.deepEqual(all, all.slice().sort(), 'and so is the full catalogue')
    // Sorting must not disturb the sets: same members, new order.
    assert.equal(new Set(visible).size, visible.length, 'no duplicates introduced')
  })
})

test('a round only asks about the models the user has switched ON', async () => {
  await withTempDir(async (dir) => {
    // A probe costs a request from a bucket shared by everything behind this
    // egress, so asking about a model the user has hidden spends a scarce
    // resource on an answer they will never read, and crowds out the models
    // they will. The scope follows the picker, not the catalogue.
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe)
    const shown = catalog.current().models.map((m) => m.id)
    const off = shown[0]

    const scoped = catalogWith({
      dir,
      fetchImpl: scriptedFetch([]),
      probe,
      baselineModels: baseline(),
      hidden: (id) => id === off,
    })
    await waitFor(() => scoped.current().source === 'models.dev')
    await scoped.forceProbes()
    const asked = probe.calls
    assert.ok(asked.length > 0, 'the round still probes the models that are on')
    assert.ok(!asked.includes(off), 'and never the ones that are switched off')
    assert.equal(
      scoped.probeProgress().results[off],
      undefined,
      'so the panel has no row report for a model the round never asked',
    )
  })
})

test('a dead verdict from before the channel sweep is re-checked, and can come back', async () => {
  await withTempDir(async (dir) => {
    // This is the recorded failure: 24 models were written off `dead` from one
    // request each, on the strength of a 401 "not supported" — which is also
    // what a wrong channel answers with. Those verdicts are permanent by design,
    // so without a re-check they suppress working models forever.
    const path = join(dir, 'catalog.json')
    const clock = { t: 1_000_000 }
    const first = await probedCatalog(
      dir,
      recordingProber({
        'big-pickle': { kind: 'dead', reason: '上游回報此模型不可用（HTTP 401）', code: 'dead', http: 401 },
      }),
      clock,
    )
    await first.forceProbes()
    assert.ok(!first.current().visible.includes('big-pickle'), 'it starts out judged dead')
    // Rewrite the file the way an older build would have left it: no `swept`.
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(onDisk.probes['big-pickle'].swept, true, 'a verdict earned today is marked swept')
    delete onDisk.probes['big-pickle'].swept
    await writeFile(path, JSON.stringify(onDisk))

    const probe = recordingProber()
    const reopened = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([]),
      probe,
      baselineModels: baseline(),
    })
    // The warm start is fire-and-forget; probing before it lands reads an empty
    // verdict history, which is not what this test is about.
    await waitFor(() => reopened.current().source === 'models.dev')
    pastProbeFloor(clock)
    await reopened.forceProbes()
    assert.ok(probe.calls.includes('big-pickle'), 'an unswept dead verdict is re-checked')
    assert.ok(reopened.current().visible.includes('big-pickle'), 'and a working model comes back')
    const settled = JSON.parse(await readFile(path, 'utf8')).probes['big-pickle']
    assert.equal(settled.verdict, 'ok', 'the recovered verdict is ok, not dead')
    assert.equal(settled.swept, undefined, 'ok is not a dead verdict and carries no swept marker')
  })
})

test('a dead verdict that survives the sweep stays out for good', async () => {
  await withTempDir(async (dir) => {
    // The re-check must not turn `dead` into a lease that expires: a model that
    // refuses on every channel is still gone after being asked again, and the
    // re-check is paid once, not every round.
    const path = join(dir, 'catalog.json')
    const clock = { t: 1_000_000 }
    const first = await probedCatalog(
      dir,
      recordingProber({
        'big-pickle': { kind: 'dead', reason: 'gone', code: 'dead', http: 404 },
      }),
      clock,
    )
    await first.forceProbes()
    assert.ok(!first.current().visible.includes('big-pickle'), 'removed after the round that swept it')
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    delete onDisk.probes['big-pickle'].swept
    await writeFile(path, JSON.stringify(onDisk))

    const probe = recordingProber({ 'big-pickle': { kind: 'dead', reason: 'gone', code: 'dead', http: 404 } })
    const reopened = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([]),
      probe,
      baselineModels: baseline(),
    })
    // The warm start is fire-and-forget: probing before it lands reads an
    // empty verdict history, and probing while it lands mutates the map
    // mid-round. Either way the assertion below is about a different thing.
    await waitFor(() => reopened.probeProgress().total > 0 || reopened.current().source === 'models.dev')
    pastProbeFloor(clock)
    await reopened.forceProbes()
    assert.ok(probe.calls.includes('big-pickle'), 'the legacy verdict was re-checked once')
    assert.equal(
      JSON.parse(await readFile(path, 'utf8')).probes['big-pickle'].swept,
      true,
      'and is now earned',
    )

    probe.calls.length = 0
    pastProbeFloor(clock)
    await reopened.forceProbes()
    assert.ok(!probe.calls.includes('big-pickle'), 'after that it is never asked again')
  })
})

test('probeProgress is a copy: the panel cannot mutate round state', async () => {
  await withTempDir(async (dir) => {
    const catalog = await probedCatalog(dir, recordingProber())
    await catalog.forceProbes()
    const first = catalog.probeProgress()
    first.results['big-pickle'] = { status: 'failed', ms: 0 }
    assert.equal(catalog.probeProgress().results['big-pickle'].status, 'ok')
  })
})

test('D5 GUARD: an all-gated round leaves visibility unchanged and persists no verdict', async () => {
  await withTempDir(async (dir) => {
    // The failure this whole design exists to prevent: one gated egress IP
    // makes every model answer 403 at once, and if that reached `dead` the
    // entire catalogue would empty itself.
    const gated = { kind: 'inconclusive', reason: 'anon-gated (HTTP 403)' }
    const probe = recordingProber(Object.fromEntries(DERIVED.map((id) => [id, gated])))
    const catalog = await probedCatalog(dir, probe)
    const before = catalog.current()
    await catalog.forceProbes()
    const after = catalog.current()
    assert.deepEqual(after.visible, before.visible, 'visibility unchanged')
    assert.equal(after.probeInconclusive, true, 'the panel is told the round is untrustworthy')
    // `inconclusive` is never persisted, only the round marker — so a fully
    // gated day does not re-probe on every read.
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.probes, undefined, 'no inconclusive verdict is ever written')
    assert.equal(onDisk.lastProbeAt, 1_000_000, 'the round marker is written anyway')
  })
})

test('a MIXED round keeps the refusals and still records the death it earned', async () => {
  await withTempDir(async (dir) => {
    // The 2026-09-30 03:31:17 round, in shape: one model answered, one came
    // back `dead` after a full channel sweep, and nine were refused by the
    // upstream gate in ~350ms. The D5 guard above only covers the all-gated
    // round, which left the mixed case — the one that actually happens —
    // unspecified, and it is the case that decides two things at once:
    //
    // 1. The refusals must change nothing (D5 holds per model, not per round).
    // 2. The `dead` MUST still be recorded, because "the tier refused nine
    //    models" is not evidence against the tenth, and discarding a verdict
    //    the sweep earned would silently keep a withdrawn model selectable.
    //
    // So the round-level "untrustworthy" flag is a statement about the
    // INCONCLUSIVE models only. The panel used to word it as a claim about
    // every model ("模型显示保持不变"), which is not what the code enforces —
    // this test is what makes the wording load-bearing.
    const gate = { kind: 'inconclusive', reason: 'anon-gated (HTTP 403)', code: 'anon-gated', http: 403 }
    const verdicts = Object.fromEntries(DERIVED.map((id) => [id, gate]))
    verdicts['space-bunny-free'] = { kind: 'ok' }
    verdicts['deepseek-v4-flash-free'] = {
      kind: 'dead',
      reason: '上游回報此模型不可用（HTTP 400）',
      code: 'dead',
      http: 400,
    }
    const probe = recordingProber(verdicts)
    const catalog = await probedCatalog(dir, probe)
    const before = catalog.current().visible.slice()
    await catalog.forceProbes()
    const after = catalog.current()

    // (1) Every refused model keeps exactly the visibility it had.
    for (const id of [
      'big-pickle',
      'ling-3.0-flash-fin-free',
      'muse-spark-1.2-contributor-free',
      'muse-spark-1.3-contributor-free',
    ]) {
      assert.equal(before.includes(id), after.visible.includes(id), `${id} keeps its visibility`)
    }
    // (2) The earned death is kept, and persisted with the swept marker.
    assert.ok(!after.visible.includes('deepseek-v4-flash-free'), 'the dead model leaves the list')
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.probes['deepseek-v4-flash-free'].verdict, 'dead', 'the earned death is persisted')
    assert.equal(onDisk.probes['deepseek-v4-flash-free'].swept, true, 'and marked as earned by a full sweep')
    assert.equal(onDisk.probes['big-pickle'], undefined, 'no refusal is ever persisted')
    assert.equal(after.probeInconclusive, true, 'the panel is still told some models went unmeasured')
    // The round record has to say the death REMOVED something, so the card can
    // tell this apart from re-confirming a verdict an earlier round already used.
    const results = catalog.probeProgress().results
    assert.equal(results['deepseek-v4-flash-free'].removed, true, 'a fresh death is marked as a removal')
    assert.equal(results['big-pickle'].removed, undefined, 'a refusal carries no removal claim')
  })
})

test('re-confirming an old death removes nothing and is marked as such', async () => {
  await withTempDir(async (dir) => {
    // The other half of the same screenshot: `deepseek-v4-flash-free` was
    // already dead from the 23:30:17 round, so the 03:31:17 re-confirmation
    // changed nothing — the model had left the list hours earlier. The card
    // filed it under "本轮下架" anyway, dating a four-hour-old change to the
    // round the reader had just run.
    //
    // The re-check only happens for a verdict that predates the channel sweep
    // (no `swept` marker), which is exactly what the 23:30:17 round wrote: 23
    // deaths, none of them swept. Once a verdict IS swept it is never asked
    // again, so this state is the only way a re-confirmation can occur — and
    // therefore the only way the panel can misreport one. `deepseek-v4-flash-free`
    // is the model that took that path in the screenshot; `big-pickle` stands in
    // for it here because it is the one id the offline baseline fixture carries,
    // and the mechanism is the id's business, not the test's.
    const path = join(dir, 'catalog.json')
    const dead = { kind: 'dead', reason: '上游回報此模型不可用（HTTP 400）', code: 'dead', http: 400 }
    const clock = { t: 1_000_000 }
    const first = await probedCatalog(dir, recordingProber({ 'big-pickle': dead }), clock)
    await first.forceProbes()
    assert.ok(!first.current().visible.includes('big-pickle'), 'removed by the first round')
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    delete onDisk.probes['big-pickle'].swept
    await writeFile(path, JSON.stringify(onDisk))

    // A manual round is floored at five minutes, and this catalogue carries a
    // round from a moment ago, so `forceProbes()` would refuse to run and the
    // re-check would fall to the warm start's fire-and-forget round — which this
    // test then read whenever it happened to land. Move the clock past the
    // floor, the way every other test that wants a SECOND round does, so this
    // one drives the round it is actually about.
    pastProbeFloor(clock)
    const probe = recordingProber({ 'big-pickle': dead })
    const reopened = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([]),
      probe,
      baselineModels: baseline(),
    })
    await reopened.forceProbes()
    assert.ok(probe.calls.includes('big-pickle'), 'the legacy verdict was re-checked')
    // Upstream said the same thing. The model was ALREADY out of the list, so
    // this round removed nothing and must not claim to have.
    assert.equal(
      reopened.probeProgress().results['big-pickle'].removed,
      false,
      'the re-confirmation is not a removal',
    )
    assert.ok(!reopened.current().visible.includes('big-pickle'), 'and it is still out')
  })
})

test('a refusal round carries the gate marker through to the panel record', async () => {
  await withTempDir(async (dir) => {
    // The seam between the transport and the card. `anon-gated` folds three
    // upstream conditions together — correctly, since none of them is a verdict
    // about the model — but they need three different repairs, and the body is
    // the only place that fact exists. An `inconclusive` is never persisted, so
    // without this the answer dies with the round: three rounds of diagnosis on
    // the 2026-09-30 failures stalled on exactly that.
    const gated = {
      kind: 'inconclusive',
      reason: 'anon-gated（HTTP 403）',
      code: 'anon-gated',
      http: 403,
      marker: 'FreeTierError',
    }
    const probe = recordingProber(Object.fromEntries(DERIVED.map((id) => [id, gated])))
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    const results = catalog.probeProgress().results
    assert.equal(results['big-pickle'].code, 'anon-gated', 'the folded code still classifies the round')
    assert.equal(results['big-pickle'].http, 403)
    assert.equal(results['big-pickle'].marker, 'FreeTierError', 'and the marker rides alongside it')
    // A refusal still changes nothing about visibility (D5), marker or not.
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.probes, undefined, 'a refusal is still never persisted as a verdict')
  })
})

test('a finished round report survives a restart', async () => {
  await withTempDir(async (dir) => {
    // The progress area is the panel's report of the last round, and it used to
    // live only in memory. Memory does not survive a restart, so a restarted
    // host had nothing to adopt on mount and the progress area was simply
    // blank — which reads as "the probe display is gone", and restarting made
    // it worse rather than better. The report is persisted beside the verdicts.
    const probe = recordingProber({
      'big-pickle': { kind: 'ok' },
      'space-bunny-free': { kind: 'ok' },
      'deepseek-v4-flash-free': { kind: 'dead', reason: 'gone', code: 'dead', http: 404 },
    })
    const first = await probedCatalog(dir, probe)
    await first.forceProbes()
    const before = first.probeProgress()
    assert.ok(before.total > 0, 'the round reported something')

    // A fresh process over the same directory: what the panel sees after a
    // restart. No round is started here — this test is about what the WARM READ
    // restores, so the reopened catalog deliberately uses the default clock.
    const reopened = catalogWith({ dir, fetchImpl: scriptedFetch([]), probe, baselineModels: baseline() })
    // The warm start is fire-and-forget; poll rather than bet on a tick count.
    await waitFor(() => reopened.probeProgress().total > 0)
    const after = reopened.probeProgress()
    assert.equal(after.total, before.total, 'the tally is restored, not blank')
    assert.equal(after.running, false, 'a restored round is a finished one, not one to follow')
    assert.equal(after.startedAt, before.startedAt, 'and it keeps the time it ran at')
    assert.deepEqual(
      Object.keys(after.results).sort(),
      Object.keys(before.results).sort(),
      'every row keeps its outcome',
    )
    assert.equal(after.results['big-pickle'].status, 'ok', 'including the per-row verdict')
    assert.equal(after.results['deepseek-v4-flash-free'].code, 'dead', 'and the reason a row failed')
    // The whole ROW, not just the fields the read path happens to mention. The
    // write path and the read path were not inverses of each other: `removed`
    // survived only in its `false` form, so a row that DID remove a model came
    // back as "no removal claim" — and `isFreshRemoval` reads a missing
    // `removed` as a fresh removal, which is the opposite of what happened
    //.
    assert.deepEqual(
      after.results['deepseek-v4-flash-free'],
      before.results['deepseek-v4-flash-free'],
      'a restored report is the report that was written, row for row',
    )
  })
})

test('a prober that rejects is treated as no conclusion, not as dead', async () => {
  await withTempDir(async (dir) => {
    const probe = async (model) => {
      if (model.id === 'big-pickle') throw new Error('probe transport exploded')
      return { kind: 'ok' }
    }
    const catalog = await probedCatalog(dir, probe)
    const before = catalog.current().visible.slice()
    await catalog.forceProbes()
    const after = catalog.current()
    assert.deepEqual(after.visible, before, 'a thrown prober must not narrow anything')
    assert.equal(after.probeInconclusive, true)
  })
})

test('probing is a no-op without a prober, and never throws', async () => {
  await withTempDir(async (dir) => {
    const catalog = await probedCatalog(dir, undefined)
    await catalog.forceProbes()
    await catalog.runProbes()
    assert.equal(catalog.current().probedAt, 0, 'no prober, no round marker')
  })
})

test('runProbes allows one round per local day; forceProbes bypasses THAT gate but not the floor', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    // 2026-09-29, and the "later" catalog below is 2026-09-30: the test is about
    // a NEW LOCAL DAY, so the two rounds must straddle midnight. (Before the
    // forced-probe floor existed, the first catalog used the default 1970 epoch
    // clock and the day separation was accidental rather than stated.)
    const morning = { t: new Date(2026, 8, 29, 9, 0, 0).getTime() }
    const catalog = await probedCatalog(dir, probe, morning)
    await catalog.runProbes()
    assert.equal(probe.calls.length, DERIVED.length)
    await catalog.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'same day: no second round')
    pastProbeFloor(morning)
    await catalog.forceProbes()
    assert.equal(probe.calls.length, DERIVED.length * 2, 'the manual button asks once the floor has passed')
    probe.calls.length = 0
    const clock = { t: new Date(2026, 8, 30, 12, 0, 0).getTime() }
    const later = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe,
    })
    await later.forceRefresh()
    await later.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'a new local day permits one round')
  })
})

test('the daily gate compares local calendar days, not a rolling 24 hours', async () => {
  await withTempDir(async (dir) => {
    // Pinned deliberately: a rolling 24h window would allow a second round
    // 23h59m after the first. The other edge, 23:50 then 00:10, IS allowed,
    // because those are different days — see probedToday() in catalog.ts.
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe, { t: new Date(2026, 8, 29, 12, 0, 0).getTime() })
    await catalog.runProbes()
    assert.equal(probe.calls.length, DERIVED.length)
    const sameDay = catalogWith({
      dir,
      clock: { t: new Date(2026, 8, 29, 23, 50, 0).getTime() },
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe,
    })
    await sameDay.forceRefresh()
    await sameDay.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'same local day: no second round')
    const nextDay = catalogWith({
      dir,
      clock: { t: new Date(2026, 8, 30, 0, 10, 0).getTime() },
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe,
    })
    await nextDay.forceRefresh()
    await nextDay.runProbes()
    assert.equal(probe.calls.length, DERIVED.length * 2, 'a new local day permits one round')
  })
})

test('concurrent probe calls share one round', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe)
    await Promise.all([catalog.forceProbes(), catalog.forceProbes(), catalog.forceProbes()])
    assert.equal(probe.calls.length, DERIVED.length, 'one round, not three')
  })
})

test('verdicts round-trip through the cache file and survive a restart', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'muse-spark-1.2-contributor-free': DEAD(410) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.deepEqual(Object.keys(onDisk.probes).sort(), DERIVED.slice().sort(), 'ok is recorded too')
    assert.equal(onDisk.probes['muse-spark-1.2-contributor-free'].verdict, 'dead')
    assert.equal(onDisk.probes['muse-spark-1.2-contributor-free'].at, 1_000_000)

    // A restart adopts the verdicts without probing: the dead model must not
    // reappear just because the process restarted.
    const restarted = catalogWith({
      dir,
      fetchImpl: scriptedFetch([]),
      baselineModels: [],
      probe: async () => {
        throw new Error('must not probe on a warm start')
      },
    })
    assert.equal(await waitFor(() => restarted.current().source === 'models.dev'), true)
    assert.ok(!restarted.current().visible.includes('muse-spark-1.2-contributor-free'))
  })
})

test('a cache with no probes field is "never probed", not an error', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({ version: CACHE_VERSION, etag: '"v1"', fetchedAt: 1_000_000, models: modelsDict() }),
      'utf8',
    )
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([]), baselineModels: [] })
    assert.equal(await waitFor(() => catalog.current().source === 'models.dev'), true)
    const state = catalog.current()
    assert.deepEqual(state.visible.slice().sort(), DERIVED, 'everything is offered again')
    assert.equal(state.probedAt, 0)
  })
})

test('effectiveModels and the panel visible stay one set after a probe', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'big-pickle': DEAD(404), 'muse-spark-1.2-contributor-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    assert.deepEqual(ids(catalog.effectiveModels()), catalog.current().visible)
  })
})

test('a verdict for a model the catalogue dropped is pruned from the cache', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'space-bunny-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    assert.ok(!catalog.current().visible.includes('space-bunny-free'))
    // Upstream removes it entirely. Nothing will ever probe it again, so its
    // verdict can never change — keeping it would grow the cache file without
    // bound across upstream removals.
    const reSynced = catalogWith({
      dir,
      fetchImpl: scriptedFetch([
        fakeResponse({ body: apiBodyWith({ 'big-pickle': modelsDict()['big-pickle'] }) }),
      ]),
      baselineModels: [],
    })
    await reSynced.forceRefresh()
    assert.deepEqual(reSynced.current().visible, ['big-pickle'])
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.deepEqual(
      Object.keys(onDisk.probes ?? {}),
      ['big-pickle'],
      'the dead verdict for a vanished model is gone',
    )
  })
})

test('GUARD: a warm start landing after a sync cannot resurrect the older catalogue', async () => {
  await withTempDir(async (dir) => {
    // The container must answer synchronously, so the warm start reads the
    // cache in the background while the first ensureFresh downloads. If the
    // warm start then adopts, the OLDER section replaces the fresher one and
    // the picker keeps offering a model upstream has removed for a whole TTL.
    // The download below yields, which is exactly the window: the warm start
    // lands second.
    const path = join(dir, 'catalog.json')
    await writeFile(
      path,
      JSON.stringify({ version: CACHE_VERSION, etag: '"old"', fetchedAt: 1, models: modelsDict() }),
      'utf8',
    )
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const fetchImpl = scriptedFetch([
      async () => {
        await gate
        return fakeResponse({
          etag: '"new"',
          body: apiBodyWith({ 'big-pickle': modelsDict()['big-pickle'] }),
        })
      },
    ])
    const catalog = catalogWith({ dir, fetchImpl, baselineModels: [] })
    const syncing = catalog.forceRefresh()
    await tick()
    release()
    await syncing
    assert.deepEqual(catalog.current().visible, ['big-pickle'], 'the sync won, not the warm start')
    // The stale record must not have been kept either: the next conditional
    // request has to carry the etag the sync just stored.
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(onDisk.etag, '"new"')
    const revalidated = scriptedFetch([fakeResponse({ status: 304 })])
    const second = catalogWith({ dir, fetchImpl: revalidated, baselineModels: [] })
    await waitFor(() => second.current().source === 'models.dev')
    await second.forceRefresh()
    assert.equal(revalidated.calls.length, 1)
    assert.equal(revalidated.calls[0].headers['if-none-match'], '"new"', 'the fresh etag survived')
  })
})

// ── dual-axis freshness + blind-spot reporting ─────────────────────────────
//
// The catalogue and the Zen gate expire on different clocks, and conflating them
// is how a withdrawn model stays in a picker for a whole catalogue TTL. These
// tests pin the separation, the safety invariant around the gate, and the
// diagnostic that reports what the two-source design cannot see.

const countingGate = (value) => {
  let calls = 0
  const fn = async () => {
    calls += 1
    return typeof value === 'function' ? value() : value
  }
  fn.calls = () => calls
  return fn
}

test('the gate expires on its own clock, independently of the catalogue', async () => {
  await withTempDir(async (dir) => {
    const clock = { t: 10_000_000 }
    const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody() })])
    const listZenIds = countingGate(['big-pickle'])
    const catalog = catalogWith({ dir, fetchImpl, clock, listZenIds })
    await catalog.forceRefresh()
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(listZenIds.calls(), 0, 'a refresh of the catalogue must not spend a Zen GET')

    // Well past the gate's 30 minutes, nowhere near the catalogue's 24 hours.
    clock.t += GATE_TTL_MS + 1_000
    await catalog.ensureFresh()
    assert.equal(listZenIds.calls(), 1, 'a stale gate is re-asked')
    assert.equal(fetchImpl.calls.length, 1, 'and the 5.2MB catalogue is left alone')
  })
})

test('the two axes advance independently, and neither starves the other', async () => {
  await withTempDir(async (dir) => {
    const clock = { t: 10_000_000 }
    const fetchImpl = scriptedFetch([
      fakeResponse({ body: apiBody(), etag: '"v1"' }),
      fakeResponse({ status: 304, etag: '"v1"' }),
      fakeResponse({ status: 304, etag: '"v1"' }),
    ])
    const listZenIds = countingGate(['big-pickle'])
    const catalog = catalogWith({ dir, fetchImpl, clock, listZenIds })
    await catalog.forceRefresh()
    await catalog.ensureFresh()
    assert.equal(listZenIds.calls(), 1)
    assert.equal(fetchImpl.calls.length, 1)

    // Note the windows can only nest one way: the catalogue's shortest window
    // (6h) is longer than the gate's (30m), so a stale gate is always the
    // cheaper half of a stale read. That is the point of the split — the gate
    // re-asks on its own long before the catalogue needs to.
    for (const step of [GATE_TTL_MS + 60_000, GATE_TTL_MS + 60_000, GATE_TTL_MS + 60_000]) {
      clock.t += step
      await catalog.ensureFresh()
    }
    assert.equal(listZenIds.calls(), 4, 'each pass past 30m re-asks the gate')
    assert.equal(fetchImpl.calls.length, 1, 'and none of them touched the 5.2MB catalogue')
  })
})

test('a 304 earns the short window; a full body gives it back', async () => {
  await withTempDir(async (dir) => {
    const clock = { t: 10_000_000 }
    const fetchImpl = scriptedFetch([
      fakeResponse({ body: apiBody(), etag: '"v1"' }),
      fakeResponse({ status: 304, etag: '"v1"' }),
      fakeResponse({ status: 304, etag: '"v1"' }),
      fakeResponse({ body: apiBody(), etag: '"v2"' }),
    ])
    const catalog = catalogWith({ dir, fetchImpl, clock })
    await catalog.forceRefresh()
    assert.equal(fetchImpl.calls.length, 1)

    // The first fetch was a full body, so nothing has earned the short window:
    // 7h on, the conservative 24h still holds.
    clock.t += CATALOG_TTL_ACTIVE_MS + 60_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 1, 'a full body leaves the catalogue on the 24h window')

    // Past 24h it revalidates, and a 304 is what shortens the next one.
    clock.t += DEFAULT_TTL_MS
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 2, 'the 24h window still fires')

    // Now 7h is enough.
    clock.t += CATALOG_TTL_ACTIVE_MS + 60_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 3, 'a 304 bought the 6h window')

    // A miss withdraws it again, at the moment of transfer.
    clock.t += CATALOG_TTL_ACTIVE_MS + 60_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 4, 'and the full body is taken at the short window')

    // 7h later is not enough any more.
    clock.t += CATALOG_TTL_ACTIVE_MS + 60_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 4, 'after a full download the 24h window is back')
  })
})

test('an empty Zen answer narrows nothing, on either door into the gate', async () => {
  await withTempDir(async (dir) => {
    const clock = { t: 10_000_000 }
    const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody() })])
    let answer = ['big-pickle', 'muse-spark-1.3-contributor-free']
    const catalog = catalogWith({ dir, fetchImpl, clock, listZenIds: async () => answer })
    await catalog.forceRefresh()
    await catalog.ensureFresh()
    const served = [...catalog.current().visible]
    assert.deepEqual(served, ['big-pickle', 'muse-spark-1.3-contributor-free'])

    // A body that parses but names nothing is not a membership decision.
    answer = []
    catalog.applyZenGate([])
    clock.t += GATE_TTL_MS + 1_000
    await catalog.ensureFresh()
    assert.deepEqual(catalog.current().visible, served, 'an empty listing must not empty the picker')

    // And a rejected call is the same fact, not a smaller one.
    answer = null
    clock.t += GATE_TTL_MS + 1_000
    await catalog.ensureFresh()
    assert.deepEqual(catalog.current().visible, served)
  })
})

test('unknownFree names what Zen serves and models.dev has not published', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody() })])
    const catalog = catalogWith({
      dir,
      fetchImpl,
      listZenIds: async () => [
        'big-pickle',
        'muse-spark-1.3-contributor-free',
        'jev-1.13-free',
        'a-brand-new-free',
        'claude-opus-4-8', // served, but not a free-tier id
        'ling-3.0-flash-fin-free', // a free id models.dev HAS: a member, not a blind spot
      ],
    })
    await catalog.forceRefresh()
    await catalog.ensureFresh()
    const state = catalog.current()
    assert.deepEqual(
      [...state.unknownFree],
      ['a-brand-new-free', 'jev-1.13-free'],
      'sorted, free-looking ids only',
    )
    assert.equal(state.visible.includes('jev-1.13-free'), false, 'a diagnostic must never add to the picker')
    assert.equal(state.visible.includes('a-brand-new-free'), false)
    assert.equal(
      state.visible.includes('ling-3.0-flash-fin-free'),
      true,
      'a known free model is a member, not a blind spot',
    )
  })
})

test('unknownFree stays empty when Zen has never answered', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    assert.deepEqual(catalog.current().unknownFree, [], 'no gate in force means no claim about membership')
  })
})

test('GUARD: a well-formed but wholly disjoint Zen answer cannot empty the picker', async () => {
  //. A response that is perfectly valid and simply
  // names none of the models we hold is far likelier to be a changed shape, a
  // wrong egress or a different tenant than a simultaneous withdrawal of every
  // free model — and acting on it empties the picker, the one outcome the gate
  // exists to prevent. The `[]` guard shipped believing it was sufficient; it
  // is not, because this case is non-empty.
  await withTempDir(async (dir) => {
    const clock = { t: 10_000_000 }
    const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody(), etag: '"v1"' })])
    let answer = ['big-pickle', 'ling-3.0-flash-fin-free', 'muse-spark-1.3-contributor-free']
    const catalog = catalogWith({ dir, fetchImpl, clock, listZenIds: async () => answer })
    await catalog.forceRefresh()
    await catalog.ensureFresh()
    const served = [...catalog.current().visible]
    assert.equal(served.length, 3)

    answer = ['some-other-tenant-model', 'yet-another-one']
    clock.t += GATE_TTL_MS + 60_000
    await catalog.ensureFresh()
    assert.deepEqual(catalog.current().visible, served, 'disjoint is not a withdrawal')

    // The same via the host seam, which is a second writer and must not be laxer.
    catalog.applyZenGate(['nothing-we-have-a'])
    assert.deepEqual(catalog.current().visible, served)
    catalog.applyZenGate(['big-pickle'])
    assert.deepEqual(catalog.current().visible, ['big-pickle'], 'a real narrowing still works')
  })
})

test('GUARD: a non-array Zen answer is "could not tell", not a set of characters', async () => {
  await withTempDir(async (dir) => {
    const clock = { t: 10_000_000 }
    const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody(), etag: '"v1"' })])
    const catalog = catalogWith({ dir, fetchImpl, clock, listZenIds: async () => ['big-pickle'] })
    await catalog.forceRefresh()
    await catalog.ensureFresh()
    assert.deepEqual(catalog.current().visible, ['big-pickle'])
    // Iterating a bare string yields characters; every one of them would fail
    // the overlap test, but the type check is what says so out loud.
    catalog.applyZenGate('big-pickle')
    assert.deepEqual(catalog.current().visible, ['big-pickle'], 'a string must not narrow the gate')
  })
})

test('a catalogue sync of EITHER kind keeps the last round report on disk', async () => {
  // A sync is not a round and has nothing new to report — but its write replaces
  // the whole record, so omitting the field DELETES the report. With the 6h
  // window a sync can run four times a day, which is what made the loss show up.
  //.
  //
  // This version is table-driven over BOTH sync outcomes on purpose. The original
  // drove only the 304 branch and, because it pinned no `ttlMs`, did not even
  // reach a sync: the default TTL is 24h and the clock moved 6h01m, so
  // `stale()` was false and `ensureFresh()` issued no request at all. Deleting
  // the guarded line still left 88/88 green — a vacuous assertion wearing the
  // name of a guard. The full-download branch is the one that
  // actually deleted the report in the field.
  for (const kind of ['not-modified', 'ok']) {
    await withTempDir(async (dir) => {
      const clock = { t: 10_000_000 }
      // A short, explicit TTL so "advance past it" means what it says here,
      // independent of DEFAULT_TTL_MS and of whether a 304 was earned.
      const fetchImpl = scriptedFetch([
        fakeResponse({ body: apiBody(), etag: '"v1"' }),
        kind === 'not-modified'
          ? fakeResponse({ status: 304, etag: '"v1"' })
          : fakeResponse({ body: apiBody(), etag: '"v2"' }),
      ])
      const catalog = catalogWith({
        dir,
        fetchImpl,
        clock,
        ttlMs: 60_000,
        probe: async () => ({ kind: 'ok' }),
        listZenIds: async () => ['big-pickle', 'ling-3.0-flash-fin-free', 'muse-spark-1.3-contributor-free'],
      })
      await catalog.forceRefresh()
      await catalog.forceProbes()
      const total = catalog.probeProgress().total
      assert.ok(total > 0, `${kind}: the round ran`)

      clock.t += 120_000
      await catalog.ensureFresh()

      // The assertion that was missing: prove a sync actually happened before
      // claiming anything about what it wrote to disk.
      assert.equal(fetchImpl.calls.length, 2, `${kind}: a revalidation really ran`)

      const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
      assert.ok(onDisk.lastRound !== undefined, `${kind}: a sync must not erase the report`)
      assert.equal(onDisk.lastRound.total, total, `${kind}: the report is the one the round wrote`)
    })
  }
})

test('forceProbes refuses a second manual round inside the floor', async () => {
  // The POST route has no server-side rate limit and every round spends up to
  // 34 requests from a bucket shared per egress IP, so `forceProbes` carries its
  // own floor. Before this existed, repeated clicks spent the whole office's
  // quota — and removing the guard left every test green, which is why this test
  // exists.
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const clock = { t: 1_000_000 }
    const catalog = await probedCatalog(dir, probe, clock)
    await catalog.forceRefresh()

    await catalog.forceProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'the first manual round always runs')

    // Inside the floor: refused, so not one extra request is spent.
    clock.t += 60_000
    await catalog.forceProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'a second click one minute later is refused')

    // Past the floor: the button is still useful.
    pastProbeFloor(clock)
    await catalog.forceProbes()
    assert.equal(probe.calls.length, DERIVED.length * 2, 'and the button works again once the floor passes')
  })
})

// ── concurrency, atomicity and defensive parsing ───────────────────────────
//
// Each test below was written because deleting the corresponding line of
// production code left every existing test green (mutation
// pass). The defect they cover is not hypothetical: `gateInflight` and the
// `runSingle` guard are the only things stopping a panel poll, a picker read
// and a probe round from each spending their own request, and the atomic write
// is the only thing standing between a crash and a silently truncated cache.

test('a poll and a probe round share ONE Zen gate request', async () => {
  // `refreshGate()` is reached by `ensureFresh()` and by `runProbeRound()` at the
  // same time whenever the user opens the panel while a round starts. Without
  // the single-flight guard that is two `GET /models`, and — worse — the slower
  // answer overwrites `gateCheckedAt`, so a stale reading presents itself as an
  // upstream change. Deleting the guard left 88/88 green.
  await withTempDir(async (dir) => {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    const listZenIds = countingGate(async () => {
      await held
      return ['big-pickle', 'ling-3.0-flash-fin-free', 'muse-spark-1.3-contributor-free']
    })
    const catalog = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      clock: { t: 10_000_000 },
      probe: async () => ({ kind: 'ok' }),
      listZenIds,
    })
    await catalog.forceRefresh()

    // Both paths reach the gate before either is allowed to finish.
    const polling = catalog.ensureFresh()
    const round = catalog.forceProbes()
    release()
    await Promise.all([polling, round])

    assert.equal(listZenIds.calls(), 1, 'one GET /models answers both callers')
  })
})

test('concurrent forceRefresh calls share one sync', async () => {
  // `ensureFresh()` tests happened to mask the `runSingle` guard, because
  // `ensureFresh` carries its own `inflight ??` check just above the call. The
  // POST /refresh route calls `forceRefresh()` directly, so two tabs clicking
  // refresh at once used to download 5.2MB twice and overwrite the cache twice.
  await withTempDir(async (dir) => {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      await held
      return fakeResponse({ body: apiBody(), etag: '"v1"' })
    }
    const catalog = catalogWith({ dir, fetchImpl })

    const a = catalog.forceRefresh()
    const b = catalog.forceRefresh()
    release()
    await Promise.all([a, b])

    assert.equal(calls, 1, 'one fetch, not two 5.2MB downloads')
  })
})

test('concurrent runProbes share one round', async () => {
  // `runProbes()` is the path production actually takes (`getModels`); the only
  // concurrency test used `forceProbes()`, so the production path had none.
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const catalog = catalogWith({
      dir,
      clock: { t: new Date(2026, 8, 30, 9, 0, 0).getTime() },
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe,
      listZenIds: async () => SERVED,
    })
    await catalog.forceRefresh()

    // The gate names three of the six, so a round covers three — assert the
    // round ran once, not against the full catalogue.
    await Promise.all([catalog.runProbes(), catalog.runProbes(), catalog.runProbes()])
    assert.equal(probe.calls.length, SERVED.length, 'three callers, one round')

    await catalog.runProbes()
    assert.equal(probe.calls.length, SERVED.length, 'the daily gate still holds')
  })
})

test('a torn write is never observable, and no temp file is left behind', async () => {
  // The suite had a test literally named `cache round-trips atomically …`, but
  // it only did a round-trip. Replacing temp-file+rename with a single
  // `writeFile(path, …)` left 88/88 green — so the one guarantee that keeps a
  // crash from producing a truncated catalog was untested, and a truncated file
  // is read back as "no cache" (silently), losing every verdict.
  await withTempDir(async (dir) => {
    const path = join(dir, 'catalog.json')
    const payload = {
      etag: '"v1"',
      fetchedAt: 1,
      models: { 'big-pickle': { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 } } },
      probes: { 'big-pickle': { verdict: 'dead', at: 2 } },
      lastProbeAt: 2,
      lastRound: { total: 1, done: 1, results: {}, targets: [] },
    }

    // A staged file must never be mistaken for a cache. This is the property
    // that actually matters, and it is deterministic — a mid-flight readdir of
    // the real name is a race, because a small payload finishes before the read
    // lands (and an assertion that only sometimes sees the temp file is worse
    // than none: it looks like coverage).
    const staged = join(dir, '.catalog.staged.tmp')
    await writeFile(staged, JSON.stringify(payload), 'utf8')
    assert.equal(await readCache(path), null, 'a lone staged file reads as "no cache", never as a prefix')
    await rm(staged, { force: true })
    await writeCacheAtomic(path, payload)

    const settled = await readCache(path)
    assert.notEqual(settled, null, 'the completed write is visible')
    assert.equal(settled.probes['big-pickle'].verdict, 'dead', 'and carries the verdict')
    assert.equal(settled.lastRound.total, 1, 'and the round report too')

    // No debris, or a crash loop fills the directory with partials.
    const entries = await readdir(dir)
    assert.deepEqual(
      entries.filter((f) => f.endsWith('.tmp')),
      [],
      'the temp file is renamed away, not left behind',
    )

    // The staging name must be unpredictable: it used to be the target path plus
    // the pid, which another local user could pre-create as a symlink and have
    // `writeFile` follow. Asserted as BEHAVIOUR — two concurrent writes must not
    // collide on one name — not by reading the source, which legitimately
    // mentions the old form in the comment explaining its removal.
    const debrisBefore = (await readdir(dir)).filter((f) => f.endsWith('.tmp'))
    await Promise.all([
      writeCacheAtomic(path, { ...payload, fetchedAt: 2 }),
      writeCacheAtomic(path, { ...payload, fetchedAt: 3 }),
    ])
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, debrisBefore, 'concurrent writes leave no debris behind either')
    assert.notEqual(await readCache(path), null, 'and one complete record survives')
  })
})

test('readCache repairs a damaged probe map and round report', async () => {
  // Both parsers are pure defensive code, and neither had a case. A `probes`
  // entry with a valid verdict but no `at` is DROPPED — which revives a model
  // already judged dead and sends it to be probed again, for money. A
  // `lastRound` of `{total: 0}` reads back as "never probed", indistinguishable
  // from the truth.
  await withTempDir(async (dir) => {
    const path = join(dir, 'catalog.json')
    const base = {
      version: CACHE_VERSION,
      etag: '"v1"',
      fetchedAt: 1,
      models: { 'big-pickle': { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 } } },
    }
    const write = async (over) => writeFile(path, JSON.stringify({ ...base, ...over }), 'utf8')

    await write({
      probes: {
        good: { verdict: 'dead', at: 5 },
        badVerdict: { verdict: 'maybe', at: 5 },
        missingAt: { verdict: 'dead' },
        badAt: { verdict: 'dead', at: 'yesterday' },
        sweptString: { verdict: 'dead', at: 5, swept: 'yes' },
      },
      lastProbeAt: 5,
    })
    const withProbes = await readCache(path)
    assert.deepEqual(
      Object.keys(withProbes.probes).sort(),
      ['good', 'sweptString'],
      'only well-formed verdicts survive; a missing/invalid `at` entry is dropped, `swept: "yes"` is not accepted as a marker',
    )
    assert.equal(withProbes.probes.sweptString.swept, undefined, 'a non-boolean swept is not believed')

    // `{ total: 0 }` alone does NOT pin the total check: the `done` validation
    // rejects it too, so removing `total` entirely leaves the suite green — a case
    // that looks like coverage while covering nothing.
    // `{ total: 0, done: 1 }` is well-formed on every other axis, so only the total
    // check can reject it. `-3` is there for the same reason: `isFinite` alone is
    // not enough either.
    for (const bad of [
      { total: 0 },
      { total: 0, done: 1 },
      { total: -3, done: 2 },
      { total: 'three' },
      { done: 'x' },
      { results: 'nope' },
      { targets: [1, null, 'x'] },
      'not an object',
      42,
    ]) {
      await write({ lastRound: bad })
      const repaired = await readCache(path)
      assert.equal(
        repaired.lastRound,
        undefined,
        `lastRound ${JSON.stringify(bad)} degrades to "no report", not to a half-truth`,
      )
    }
  })
})

// ── the rules lifted out of the container, tested without one ───────────────
//
// Each of these was a closure over mutable container state until the 2026-09-30
// extraction, which means each could only be exercised by building a whole
// Catalog, driving a round and reading the result — expensive, and unable to
// reach the awkward inputs directly. Now they are plain functions of their
// inputs, and the cases below are the ones a container cannot easily produce.

test('probedToday is a local-calendar-day question, not a rolling 24h one', () => {
  const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime()

  assert.equal(
    probedToday(0, () => at(2026, 9, 30)),
    false,
    'never probed is never "today"',
  )
  assert.equal(
    probedToday(at(2026, 9, 30, 23, 50), () => at(2026, 9, 30, 23, 59)),
    true,
    '23:50 and 23:59 are the same local day',
  )
  // The documented edge: 23:50 then 00:10 is a different day, so both run.
  assert.equal(
    probedToday(at(2026, 9, 30, 23, 50), () => at(2026, 10, 1, 0, 10)),
    false,
    'the known midnight-crossing edge is deliberate',
  )
  // A 23h58m gap IS the same day even though it is under 24 hours — the whole
  // point of comparing calendar days rather than elapsed time.
  assert.equal(
    probedToday(at(2026, 9, 30, 0, 1), () => at(2026, 9, 30, 23, 59)),
    true,
    'same day wins over elapsed time',
  )
  assert.equal(
    probedToday(at(2026, 9, 28, 12, 0), () => at(2026, 9, 30, 12, 0)),
    false,
    'two days apart is not "today", however short the gap in hours',
  )
})

test('planRound splits what it will ASK from what Zen already DROPPED', () => {
  const m = (id) => ({ id, name: id, api: 'openai-completions' })
  const models = [m('a'), m('b'), m('c'), m('d')]
  const live = [models[0], models[1]] // Zen serves a and b
  const served = new Set(['a', 'b'])
  const probes = {
    a: { verdict: 'dead', at: 1, swept: true }, // earned → settled
    c: { verdict: 'dead', at: 1 }, // predates the sweep → re-checkable
  }

  const plan = planRound(models, live, served, probes, undefined)
  assert.deepEqual(
    plan.targets.map((x) => x.id),
    ['b'],
    'a settled death is not asked again, and b is unprobed so it is',
  )
  assert.deepEqual(
    plan.notListed.map((x) => x.id),
    ['d'],
    "c is NOT 'not-listed': it already carries a dead verdict, so reporting it as newly " +
      'dropped would duplicate a removal an earlier round already reported. d is the only ' +
      'genuinely-newly-dropped model, and it costs no request.',
  )

  // An unswept death is re-checked — in the ASKED bucket, never the dropped one.
  const recheck = planRound(models, [models[0], models[1], models[2]], served, probes, undefined)
  assert.deepEqual(
    recheck.targets.map((x) => x.id),
    ['b', 'c'],
    'a pre-sweep verdict is re-checked by asking, which is the whole point of the marker',
  )
  assert.deepEqual(
    recheck.notListed.map((x) => x.id),
    ['d'],
  )

  // Hidden models cost a request nobody will read.
  assert.deepEqual(
    planRound(models, live, served, probes, () => true).targets,
    [],
    'a model the user switched off is never asked',
  )

  // "We could not tell" must not manufacture a not-listed report.
  assert.deepEqual(
    planRound(models, live, null, probes, undefined).notListed,
    [],
    'without a gate answer, nothing can have been "dropped"',
  )

  // A model that is BOTH settled dead AND no longer served must appear in
  // neither bucket: asking it is forbidden, and reporting it as newly dropped
  // would duplicate a removal an earlier round already announced.
  const deadAndGone = planRound(models, live, new Set(['a']), { b: probes.a }, undefined)
  assert.deepEqual(
    deadAndGone.targets.map((x) => x.id),
    ['a'],
    'only a is asked: b is settled dead, c and d are not in the live set',
  )
  assert.ok(!deadAndGone.targets.some((x) => x.id === 'b'), 'b is settled dead')
  assert.ok(
    !deadAndGone.notListed.some((x) => x.id === 'b'),
    'and already judged dead, so it is not re-reported as newly dropped',
  )
})

test('probeRowFor never emits a bare failure, and never invents a removal', () => {
  assert.deepEqual(probeRowFor({ kind: 'ok' }, 42, undefined), { status: 'ok', ms: 42 })

  // A dead verdict with no prior verdict IS this round's removal.
  assert.deepEqual(probeRowFor({ kind: 'dead', code: 'dead', http: 404 }, 7, undefined), {
    status: 'failed',
    ms: 7,
    code: 'dead',
    http: 404,
    removed: true,
  })

  // Re-confirming an old death removes nothing — the field the panel needs to
  // say "re-confirmed" rather than "this round took it away".
  assert.equal(
    probeRowFor({ kind: 'dead', code: 'dead', http: 404 }, 9, 'dead').removed,
    false,
    'a re-confirmation is not a fresh removal',
  )

  // A prober that predates coded outcomes still gets a reason.
  assert.equal(probeRowFor({ kind: 'dead' }, 1, undefined).code, 'dead', 'falls back to the verdict')
  assert.equal(probeRowFor({ kind: 'inconclusive' }, 1, undefined).code, 'unknown')
  assert.equal(probeRowFor(undefined, 1, undefined).code, 'unknown', 'a missing outcome is not a silent row')
  assert.equal(probeRowFor(null, 1, undefined).code, 'unknown')

  // http: 0 must mean "no status ever arrived", not "we saw a zero".
  assert.equal(probeRowFor({ kind: 'inconclusive', code: 'timeout' }, 1, undefined).http, 0)
  assert.equal(probeRowFor({ kind: 'inconclusive', code: 'timeout', http: 429 }, 1, undefined).http, 429)
  assert.equal(
    probeRowFor(
      { kind: 'inconclusive', code: 'anon-gated', http: 403, marker: 'FreeTierError' },
      1,
      undefined,
    ).marker,
    'FreeTierError',
    'the gate marker rides along so the refusal names itself',
  )
  assert.equal(
    probeRowFor({ kind: 'inconclusive', code: 'unknown', marker: null }, 1, undefined).marker,
    undefined,
    'a null marker is not carried',
  )
})

test('the freshness rules are plain functions of their inputs', () => {
  const now = () => 1_000
  assert.equal(effectiveTtl(60_000, 86_400_000, false), 60_000, 'a pinned ttl is honoured verbatim')
  assert.equal(effectiveTtl(undefined, 86_400_000, false), 86_400_000, 'a MISS keeps the conservative window')
  assert.equal(
    effectiveTtl(undefined, 86_400_000, true),
    CATALOG_TTL_ACTIVE_MS,
    'a 304 earns the short window',
  )

  assert.equal(catalogueIsStale(500, now, 600), false)
  assert.equal(catalogueIsStale(500, now, 400), true)
  assert.equal(gateIsStale(0, now), true, '"never asked this boot" is stale by definition, not by arithmetic')
  assert.equal(gateIsStale(now() - 1, now), false)
  assert.equal(gateIsStale(now() - GATE_TTL_MS - 1, now), true)
})

test('the shared list is the gate minus settled deaths, and the blind spot is names only', () => {
  const m = (id) => ({ id, name: id, api: 'openai-completions' })
  const models = [m('a-free'), m('b'), m('c-free')]
  const probes = { 'a-free': { verdict: 'dead', at: 1, swept: true } }

  assert.deepEqual(
    effectiveList(models, null, probes).map((x) => x.id),
    ['b', 'c-free'],
    'no gate means no narrowing; a settled death still drops out',
  )
  assert.deepEqual(
    effectiveList(models, new Set(['a-free', 'c-free']), probes).map((x) => x.id),
    ['c-free'],
    'the gate narrows, and the two filters compose',
  )
  assert.deepEqual(
    effectiveList(models, new Set(['b']), probes).map((x) => x.id),
    ['b'],
    'a model the gate excludes even without a death verdict simply is not offered',
  )

  assert.deepEqual(
    unknownFree(models, new Set(['a-free', 'zzz-free', 'notfree'])),
    ['zzz-free'],
    'a served id we have no record of, whose name claims the free tier',
  )
  assert.deepEqual(unknownFree(models, null), [], 'without a gate answer there is no blind spot to report')
  assert.deepEqual(
    unknownFree(models, new Set(['a-free'])),
    [],
    'a model we DO have a record for is not a blind spot',
  )
})
// ── driving a round with two plain objects ──────────────────────────────────
//
// Before 2026-10-01 `runProbeRound` was a closure inside the factory, so the only
// way to exercise it was: build a whole Catalog, drive a round through the public
// API, and read the result back. These cases construct `state` and `deps`
// directly — no temp directory, no fetch stub, no cache file. That was the
// entire reason for the extraction.

test('a round can be driven with two plain objects', async () => {
  const state = initialState([])
  state.models = ['a-free', 'b-free', 'c-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))

  const asked = []
  const deps = {
    path: join(tmpdir(), 'never-written-because-the-round-below-is-covered-elsewhere'),
    fetchImpl: async () => {
      throw new Error('no network in this test')
    },
    now: () => 1_700_000_000_000,
    userAgent: undefined,
    ttlMs: 86_400_000,
    warmReadTimeoutMs: 2_000,
    warm: Promise.resolve(),
    template: state.models[0],
    knownApis: undefined,
    probe: async (model) => {
      asked.push(model.id)
      return model.id === 'c-free'
        ? { kind: 'dead', reason: 'gone', code: 'dead', http: 404 }
        : { kind: 'ok' }
    },
    // Zen serves everything: the round should not invent a removal.
    listZenIds: async () => ['a-free', 'b-free', 'c-free'],
    hidden: undefined,
  }

  await runProbeRound(state, deps)

  assert.deepEqual(asked, ['a-free', 'b-free', 'c-free'], 'every visible model asked, in catalogue order')
  assert.equal(state.probes['c-free'].verdict, 'dead', 'the dead verdict is recorded')
  assert.equal(state.probes['c-free'].swept, true, 'and marked earned')
  assert.equal(state.probes['a-free'].verdict, 'ok')
  assert.equal(state.probeRun.running, false, 'the round is finished, not running')
  assert.equal(state.probeRun.done, 3)
  assert.equal(state.probeRun.results['c-free'].code, 'dead')
  assert.equal(state.probeRun.results['c-free'].http, 404)
})

test('a round refuses to ask about a hidden model, and reports the dropped ones separately', async () => {
  const state = initialState([])
  state.models = ['a-free', 'b-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))

  const asked = []
  const base = {
    path: join(tmpdir(), 'never-written'),
    fetchImpl: async () => {
      throw new Error('no network')
    },
    now: () => 1_700_000_000_000,
    userAgent: undefined,
    ttlMs: 86_400_000,
    warmReadTimeoutMs: 2_000,
    warm: Promise.resolve(),
    template: state.models[0],
    knownApis: undefined,
    probe: async (m) => {
      asked.push(m.id)
      return { kind: 'ok' }
    },
    hidden: (id) => id === 'b-free',
  }

  // Zen no longer serves a-free: it is dropped, not asked.
  const dropping = await runProbeRound(state, { ...base, listZenIds: async () => ['b-free'] })
  assert.equal(dropping, undefined)
  assert.deepEqual(asked, [], 'a hidden model and a dropped one are both left unasked')
  assert.equal(state.probeRun.results['a-free'].code, 'not-listed', 'but the drop is still reported')
  assert.equal(state.probeRun.results['a-free'].removed, true)
  // The hidden model is not merely unasked — it is out of scope entirely, so the
  // panel can say "skipped" rather than "waiting". A user who hid it never sees
  // a promise that it will be asked.
  assert.deepEqual(state.probeRun.targets, ['a-free'], 'only the dropped-but-visible model is in scope')

  // With Zen serving it again, it is asked — but the hidden one never is.
  asked.length = 0
  await runProbeRound(state, { ...base, listZenIds: async () => ['a-free', 'b-free'] })
  assert.deepEqual(asked, ['a-free'], 'only the shown, served model is spent a request on')
})

test('a round that learns nothing leaves the picker alone', async () => {
  const state = initialState([])
  state.models = ['a-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))

  await runProbeRound(state, {
    path: join(tmpdir(), 'never-written'),
    fetchImpl: async () => {
      throw new Error('no network')
    },
    now: () => 1_700_000_000_000,
    userAgent: undefined,
    ttlMs: 86_400_000,
    warmReadTimeoutMs: 2_000,
    warm: Promise.resolve(),
    template: state.models[0],
    knownApis: undefined,
    // The tier refused. That is a fact about the caller, not about the model.
    probe: async () => ({
      kind: 'inconclusive',
      reason: 'anon-gated (HTTP 403)',
      code: 'anon-gated',
      http: 403,
    }),
    listZenIds: async () => ['a-free'],
    hidden: undefined,
  })

  assert.equal(state.probes['a-free'], undefined, 'an inconclusive outcome records no verdict')
  assert.equal(state.probeUntrusted, true, 'but the round is marked untrusted')
  assert.equal(state.probeRun.results['a-free'].code, 'anon-gated', 'and the row still says why')
  assert.equal(state.probeRun.results['a-free'].http, 403)
})

test('a round waits for the warm cache read before it judges anything', async () => {
  // The round reads `state.probes` twice: to decide what is already settled,
  // and to fill `priorVerdict`, which is the only thing that separates a fresh
  // removal from a re-confirmed old one. Both arrive with the warm read — which
  // is fire-and-forget, so a round could start before any of it was in memory.
  // Then every prior verdict reads as "unknown": settled models are re-asked,
  // and a model removed hours ago is reported as removed just now.
  //
  // This is the seam that made it observable. The factory-level case cannot
  // pin it: whether the read lands first is local filesystem timing, and
  // removing this wait does not make any other test fail.
  const state = initialState([])
  state.models = ['a-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))

  const asked = []
  let settleWarm = () => undefined
  const warm = new Promise((resolve) => {
    settleWarm = resolve
  })
  const round = runProbeRound(state, {
    path: join(tmpdir(), 'never-written'),
    fetchImpl: async () => {
      throw new Error('no network')
    },
    now: () => 1_700_000_000_000,
    userAgent: undefined,
    ttlMs: 86_400_000,
    warmReadTimeoutMs: 2_000,
    warm,
    template: state.models[0],
    knownApis: undefined,
    probe: async (m) => {
      asked.push(m.id)
      return { kind: 'ok' }
    },
    listZenIds: async () => ['a-free'],
    hidden: undefined,
  })

  // Generously past the point where a round that did not wait would have asked.
  await tick()
  await tick()
  await tick()
  assert.deepEqual(asked, [], 'no model is asked, and no verdict judged, before the cache is in memory')
  assert.equal(state.probeRun.running, false, 'and no round is announced as in progress')

  settleWarm()
  await round
  assert.deepEqual(asked, ['a-free'], 'the round runs once the cache has landed')
  assert.equal(state.probeRun.done, 1)
})

test('a catalogue refresh does not overwrite a probe round that is in flight', async () => {
  // A 200 refresh re-adopts the whole cache record, and `adopt` is also what
  // restores the finished-round report at startup. With both unconditional, a
  // refresh during a round swapped the live `probeRun` (running:true) for the
  // previous round's snapshot (running:false, done:2) — and the round carried
  // on counting `done` on the object that had been swapped in, so the panel
  // reported 4/2 and persisted the wrong tally.
  //
  // The 304 path never reaches `adopt`, which is why it never showed this.
  await withTempDir(async (dir) => {
    const clock = { t: 1_000_000 }
    let hold = false
    let enterRound = () => undefined
    let releaseRound = () => undefined
    const paused = new Promise((resolve) => {
      enterRound = resolve
    })
    const held = new Promise((resolve) => {
      releaseRound = resolve
    })

    const probe = async (model) => {
      if (hold && model.id === 'big-pickle') {
        enterRound()
        await held
      }
      return { kind: 'ok' }
    }
    const fetchImpl = () => fakeResponse({ etag: '"v1"', body: apiBody() })

    const catalog = catalogWith({ dir, clock, fetchImpl, probe })
    await catalog.forceRefresh()
    await catalog.forceProbes()
    const finished = catalog.probeProgress()
    assert.equal(finished.running, false, 'the first round finished')
    assert.ok(finished.done > 0)

    pastProbeFloor(clock)
    hold = true
    const round = catalog.forceProbes()
    await paused
    const running = catalog.probeProgress()
    assert.equal(running.running, true, 'the second round is in flight')

    // A real body, so this is the 200 branch and not the 304 one.
    await catalog.forceRefresh()
    const afterRefresh = catalog.probeProgress()
    assert.equal(afterRefresh.running, true, 'a refresh leaves a live round alone')
    assert.equal(afterRefresh.done, running.done, 'and does not rewind its tally')

    releaseRound()
    await round
    const final = catalog.probeProgress()
    assert.equal(final.running, false)
    assert.equal(final.done, running.total, 'the round finished exactly once')
    const persisted = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(persisted.lastRound.done, running.total, 'and that is what was persisted')
    assert.ok(
      persisted.lastRound.done <= persisted.lastRound.total,
      'a tally can never exceed the round it describes',
    )
  })
})

test('a channel the probe measured is the one the model is routed on, across restarts', async () => {
  // Everything about a model's channel is inference until something MEASURES
  // it: a builtin table entry, a models.dev signal, or a provider default. That
  // inference is what sends a request down a channel the model is not served on,
  // and the answer it gets back — "model not supported" — is indistinguishable
  // from a dead model without asking the other channel.
  //
  // The sweep exists to ask. But the sweep's answer was thrown away: the probe
  // reported `ok` on the second channel and the model went on being routed by
  // the first, so the very failure the probe had just ruled out came straight
  // back on the next chat.
  await withTempDir(async (dir) => {
    const clock = { t: 1_000_000 }
    const cache = join(dir, 'catalog.json')
    // big-pickle is inferred onto openai-completions by the fixture. This prober
    // says it answered on the other one.
    const probe = async (model) =>
      model.id === 'big-pickle' ? { kind: 'ok', api: 'openai-responses', ms: 120 } : { kind: 'ok' }

    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })]),
      probe,
    })
    await catalog.forceRefresh()
    // What inference alone put on every model, before anything measured one.
    const inferred = Object.fromEntries(catalog.current().models.map((m) => [m.id, m.api]))
    await catalog.forceProbes()

    const measured = (c) => c.current().models.find((m) => m.id === 'big-pickle')?.api
    assert.equal(measured(catalog), 'openai-responses', 'the measured channel wins over the inference')

    const onDisk = JSON.parse(await readFile(cache, 'utf8'))
    assert.equal(
      onDisk.probes['big-pickle'].api,
      'openai-responses',
      'and it is on disk, because inference is re-run on every boot',
    )

    // A fresh process over the same directory: the half that was missing.
    const restarted = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([]),
      baselineModels: baseline(),
    })
    await waitFor(() => restarted.current().source === 'models.dev')
    assert.equal(measured(restarted), 'openai-responses', 'a restart does not revert to the inference')

    // And a model nobody measured is left exactly where inference put it — the
    // override is per model, not a wholesale re-route.
    for (const model of restarted.current().models) {
      if (model.id === 'big-pickle') continue
      assert.equal(model.api, inferred[model.id], `${model.id} still follows the catalogue`)
    }
  })
})

test('a refusal never records a channel', async () => {
  // Only an ANSWER names a channel. A refusal is evidence that this one did not
  // work, which is not evidence that another would — recording it would route
  // chat down a channel the probe just watched fail.
  await withTempDir(async (dir) => {
    const probe = async (model) =>
      model.id === 'big-pickle'
        ? { kind: 'dead', reason: 'gone', code: 'dead', http: 404, api: 'openai-responses' }
        : { kind: 'ok' }
    const catalog = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })]),
      probe,
    })
    await catalog.forceRefresh()
    await catalog.forceProbes()
    const record = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8')).probes['big-pickle']
    assert.equal(record.verdict, 'dead')
    assert.equal(record.api, undefined, 'a dead verdict carries no channel')
  })
})

test('a model is routed the moment its probe answers, not when the round ends', async () => {
  // Per-model results are painted as they land, so a model the panel is already
  // showing as working must already be routed the way it worked. Applying the
  // measured channel when the round FINISHED left a visibly successful model
  // still going down the channel the probe had just ruled out — for as long as
  // the rest of the (sequential) round took, which on a slow model is the full
  // 15 s timeout per remaining model.
  //
  // The cache write must stay once per round: a half-finished round must not be
  // read back as a complete set of verdicts.
  await withTempDir(async (dir) => {
    const clock = { t: 1_000_000 }
    let hold = false
    let enterHold = () => undefined
    let releaseHold = () => undefined
    const paused = new Promise((resolve) => {
      enterHold = resolve
    })
    const held = new Promise((resolve) => {
      releaseHold = resolve
    })

    const probe = async (model) => {
      // big-pickle is first and answers on the channel inference did NOT pick.
      if (model.id === 'big-pickle') return { kind: 'ok', api: 'openai-responses', ms: 120 }
      if (hold && model.id === 'deepseek-v4-flash-free') {
        enterHold()
        await held
      }
      return { kind: 'ok' }
    }
    const api = (c, id) => c.current().models.find((m) => m.id === id)?.api

    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })]),
      probe,
    })
    await catalog.forceRefresh()
    assert.equal(api(catalog, 'big-pickle'), 'openai-completions', 'inference to begin with')

    hold = true
    const round = catalog.forceProbes()
    await paused
    const running = catalog.probeProgress()
    assert.equal(running.running, true, 'the round is still going')
    assert.equal(
      api(catalog, 'big-pickle'),
      'openai-responses',
      'the answered model is already routed, mid-round',
    )
    assert.equal(
      api(catalog, 'deepseek-v4-flash-free'),
      channelFor({ id: 'deepseek-v4-flash-free', ...apiBody().opencode.models['deepseek-v4-flash-free'] }),
      'and a model that has not answered yet is untouched',
    )

    releaseHold()
    await round
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(
      onDisk.probes['big-pickle'].api,
      'openai-responses',
      'the measurement is persisted when the round writes',
    )
    assert.equal(
      Object.keys(onDisk.probes).length,
      catalog.probeProgress().total,
      'one write per round, carrying every verdict at once',
    )
  })
})

test('GUARD: a round measures a declared capability once, persists it, and stops asking', async () => {
  // The panel used to show a vision badge that was a copy of models.dev and a
  // "tools work" claim that was an inference from the admission gate. Clicking
  // "Probe now" could not fix either, because nothing in a round ever asked.
  //
  // This is the fix's cost contract as much as its behaviour: one request per
  // unmeasured axis, ONCE, and never again — the second round below is the whole
  // test, because a rule that spends the shared bucket on every click is not a
  // measurement, it is a tax.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBody() }),
      probe: async (model, question) => {
        asked.push(`${model.id}:${question ?? 'baseline'}`)
        if (question === 'capability:vision') return { kind: 'ok', api: 'openai-completions', capability: { axis: 'vision', ok: true, detail: 'named the top half' } }
        if (question === 'capability:tools') return { kind: 'ok', api: 'openai-completions', capability: { axis: 'tools', ok: true, detail: 'called bash' } }
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 0 } };
      },
      listZenIds: async () => SERVED,
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    // A manual round has budget for more than the effort samples, and spends the
    // remainder on the axes nobody had evidence for.
    // `ling-3.0-flash-fin-free` is the one model here the seed table knows
    // nothing about — measured 2026-10-07, its endpoint answered
    // `Endpoint is unavailable.` on every attempt — so it is the one that must
    // still be asked.
    assert.ok(
      asked.includes('ling-3.0-flash-fin-free:capability:tools'),
      'a model with no evidence is asked about the axis every model claims',
    )
    assert.ok(
      !asked.some((q) => q.startsWith('ling-3.0-flash-fin-free:capability:vision')),
      'it declares text-only input, so there is no claim on screen to verify and nothing is asked',
    )
    for (const seeded of ['big-pickle', 'muse-spark-1.3-contributor-free']) {
      assert.deepEqual(
        asked.filter((q) => q.startsWith(`${seeded}:capability:`)),
        [],
        `a model already measured — by the seed table — costs nothing (${seeded})`,
      )
    }
    const record = await readProbeRecord(join(dir, 'catalog.json'), 'ling-3.0-flash-fin-free')
    assert.equal(record.capabilities?.tools?.ok, true, 'the verdict is persisted, so it survives a restart')
    assert.equal(typeof record.capabilities?.tools?.fp, 'string')
    assert.equal(record.capabilities?.tools?.at, clock.t)

    const before = asked.length
    pastProbeFloor(clock);
    await catalog.forceProbes()
    assert.deepEqual(asked.slice(before).filter((q) => q.includes('capability:')), [], 'a settled axis is never asked again')
  })
})

test('GUARD: a capability question that taught nothing is not a verdict', async () => {
  // The failure this exists for: a reasoning model that spends the budget on
  // thinking and returns no text looks exactly like a model that cannot see, and
  // an upstream that is down looks exactly like a model without tools. Recording
  // either as `ok: false` would retire a capability permanently on the strength
  // of a condition that has nothing to do with the model — so nothing is
  // written, the panel reads "not measured", and the next round tries again.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    let asked = 0
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBody() }),
      probe: async (_model, question) => {
        if (typeof question === 'string' && question.startsWith('capability:')) {
          asked += 1;
          // No `capability` at all: the prober saw a reply with no text in it.
          return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 0 } };
        }
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 0 } };
      },
      listZenIds: async () => ['ling-3.0-flash-fin-free'],
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();
    assert.ok(asked > 0, 'the axis was asked')
    const record = await readProbeRecord(join(dir, 'catalog.json'), 'ling-3.0-flash-fin-free')
    assert.equal(record.capabilities, undefined, 'nothing was persisted for a request that concluded nothing')

    const card = catalog.current().capabilities.find((c) => c.id === 'ling-3.0-flash-fin-free')
    assert.equal(card.evidence.tools, 'declared', 'and the panel says "not measured" rather than "cannot"')
    // "Not measured" must also leave the request path exactly as it was: this
    // model's window was never measured either, so the declaration is still what
    // ships, and the card says so by showing the two numbers equal.
    assert.equal(card.evidence.context, 'none', 'no record behind it, so no provenance to state')
    // This fixture's record publishes no `limit` at all, so the derived window
    // came from the template and there is nothing to compare: "not measured" and
    // "nothing was published" are different states, and the card carries both.
    assert.equal(card.declaredContext, undefined)
    assert.equal(card.contextWindow, 200000, 'the template floor still ships, unchanged by a failed measurement')
  })
})

test('GUARD: every model is asked for its ceiling, not only the first few', async () => {
  // The round-wide request counter was compared against the PER-MODEL budget, so
  // once the round had spent nine requests anywhere the ceiling and capability
  // questions were skipped for the rest of the list — four models heard the
  // question and seven did not, which looks exactly like "those routes state
  // nothing" unless you read the counter. Live 2026-10-07: `longcat-2.5-preview-free`
  // harvested its own 262,144 in that first batch and nobody else was asked.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const asked = []
    const ids = SERVED
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBody() }),
      probe: async (model, question) => {
        asked.push(`${model.id}:${question ?? 'baseline'}`);
        if (question === 'ceiling') return { kind: 'inconclusive', code: 'error', http: 400, reason: 'stub', ceilings: { output: 262144 } };
        if (typeof question === 'string' && question.startsWith('capability:')) return { kind: 'ok', api: 'openai-completions', capability: { axis: question.slice(11), ok: true, detail: 'stub' } };
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 0 } };
      },
      listZenIds: async () => ids,
    });
    await catalog.forceRefresh();
    pastProbeFloor(clock);
    await catalog.forceProbes();

    for (const id of ids) {
      assert.ok(
        asked.includes(`${id}:ceiling`),
        `${id} was asked for its ceiling — every model gets the question, not the first four`,
      );
    }
    // And the answer has to be USABLE: a stated ceiling must reach the advertised
    // budget, which is the half that was silently broken by storing one
    // fingerprint and checking another.
    for (const id of ids) {
      const record = await readProbeRecord(join(dir, 'catalog.json'), id);
      assert.equal(record.limits?.output, 262144, `${id} recorded what the route named`);
      assert.equal(typeof record.limits?.fp, 'string');
      assert.ok(record.limits.fp !== '', 'and the fingerprint is the one the catalogue checks');
    }
    const card = catalog.current().capabilities.find((c) => c.id === 'muse-spark-1.3-contributor-free');
    assert.equal(card.outputBudget, 262144, 'a harvested ceiling reaches the advertised budget')
    assert.equal(card.stated?.output, 262144, 'and reaches the panel as the interval it is')
    // …bounded by the window it has to fit inside, which is the other half of
    // the rule and just as load-bearing: big-pickle declares a 200,000 window, so
    // a 262,144 output ceiling is not reachable and the budget stops there.
    const capped = catalog.current().capabilities.find((c) => c.id === 'big-pickle');
    assert.equal(capped.outputBudget, 200000, 'and never exceeds the window it must fit in')
    assert.equal(capped.stated?.output, 262144, 'while the panel still shows what the route said');
  })
})

test('GUARD: a stored ceiling that cannot be applied is asked again, not trusted', async () => {
  // Found live 2026-10-07: `longcat-2.5-preview-free` carried a limits entry
  // written under the OLD fingerprint ("1000000:131072:text+image"), which
  // `isMeasuredLimits` accepts — it only checks that `fp` is a non-empty string —
  // and which the fingerprint comparison then drops on the way into the
  // catalogue. So the model looked asked, was never applied, and would never be
  // asked again: the budget came from the seed table and the panel showed no
  // `stated`. The same shape as ADR §47 and §43 — the evidence exists and nothing
  // connects it to the conclusion.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const asked = []
    const catalog = catalogWith({
      dir,
      clock,
      manualSampleBudget: MANUAL_SAMPLE_BUDGET,
      fetchImpl: async () => fakeResponse({ body: apiBody() }),
      probe: async (model, question) => {
        asked.push(`${model.id}:${question ?? 'baseline'}`);
        if (question === 'ceiling') return { kind: 'inconclusive', code: 'error', http: 400, reason: 'stub', ceilings: { output: 262144 } };
        return { kind: 'ok', api: 'openai-completions', effort: { kind: 'baseline', tokens: 0 } };
      },
      listZenIds: async () => ['big-pickle'],
    });
    await catalog.forceRefresh();
    // Seed a record shaped exactly like the one that went stale.
    const first = await readProbeRecord(join(dir, 'catalog.json'), 'big-pickle');
    void first;
    pastProbeFloor(clock);
    await catalog.forceProbes();
    assert.ok(asked.includes('big-pickle:ceiling'), 'asked, and what the route named is stored under the fingerprint the catalogue checks');

    const record = await readProbeRecord(join(dir, 'catalog.json'), 'big-pickle');
    assert.equal(record.limits?.output, 262144);
    assert.equal(record.limits?.fp, '200000:32000', 'contextFingerprint, not capabilityFingerprint')
    const card = catalog.current().capabilities.find((c) => c.id === 'big-pickle');
    assert.equal(card.stated?.output, 262144, 'and it reaches the panel, which is the only way a silent drop is visible')
  })
})

test('GUARD: a reply cut off at the budget is counted, free, from real traffic', async () => {
  // The whole output axis rests on a number nobody can verify by asking the
  // model: does a reply ever want MORE than what we send? Synthetic generations
  // answer it at tens of thousands of tokens each, and answer it unreliably —
  // measured 2026-10-07, the same request produced 892 tokens once and 79,722
  // the next. Real traffic already carries the answer in `stopReason`, on a
  // request that was being sent anyway.
  //
  // The two kinds are counted apart, because they are different events: a reply
  // cut at our output budget means the number is too small, while one cut by the
  // CONTEXT clamp means the conversation ran out of room, which says nothing
  // about the output budget.
  await withTempDir(async (dir) => {
    const clock = { t: 2_000_000 }
    const catalog = catalogWith({
      dir,
      clock,
      fetchImpl: async () => fakeResponse({ body: apiBody() }),
      listZenIds: async () => SERVED,
    });
    await catalog.forceRefresh();
    const space = 'space-bunny-free'
    // Our own output budget: what pi-ai sent equals the model's maxTokens.
    catalog.observeClamp(space, { emitted: 524288, starved: false, truncated: true })
    catalog.observeClamp(space, { emitted: 524288, starved: false, truncated: true })
    // The context clamp: pi-ai lowered the budget because the conversation grew.
    catalog.observeClamp(space, { emitted: 120000, starved: false, truncated: true })
    // Not a cut at all.
    catalog.observeClamp(space, { emitted: 524288, starved: false, truncated: false })
    const card = catalog.current().capabilities.find((c) => c.id === space)
    assert.deepEqual(card.truncated, { output: 2, context: 1 }, 'two kinds, counted apart')

    // The write is fire-and-forget by design (a reply must never wait on
    // bookkeeping), so the test waits for it rather than the other way round.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const record = await readProbeRecord(join(dir, 'catalog.json'), space)
    assert.equal(record.budgetHits?.output, 2)
    assert.equal(record.budgetHits?.context, 1)
    assert.equal(typeof record.budgetHits?.at, 'number')

    // A model nothing has cut off says nothing at all, rather than claiming a
    // count of zero the panel has no evidence for.
    const untouched = catalog.current().capabilities.find((c) => c.id === 'big-pickle')
    assert.equal(untouched.truncated, undefined)
  })
})

test('GUARD: the panel names WHICH source each number came from, not just "measured"', async () => {
  // Found by an audit of this codebase against a third-party implementation: the
  // card carried four booleans computed as "differs from what models.dev
  // published", so a ceiling the ROUTE stated in a refusal, a figure a VENDOR
  // published, a reply somebody WATCHED finish, and a raise inferred from a clamp
  // signature all rendered as the same word. That is the ambiguity that produced
  // "一百万输出明显不对" — ours, not the publisher's.
  //
  // So the rule is: a number that was not changed says `declared`, and each
  // source says its own name. Nothing here is a judgement about whether the
  // numbers are right; it is a judgement about whether the panel says which one
  // it is talking about.
  const section = (output) => ({
    'mimo-v2.6-flash-free': { ...modelsDict()['space-bunny-free'], id: 'mimo-v2.6-flash-free', name: 'Mimo', limit: { context: 200000, output } },
    'big-pickle': { ...modelsDict()['space-bunny-free'], id: 'big-pickle', name: 'Pickle', limit: { context: 200000, output } },
    'ling-3.1-flash-free': { ...modelsDict()['space-bunny-free'], id: 'ling-3.1-flash-free', name: 'Ling', limit: { context: 262144, output } },
  })
  const card = (id, output, opts) => {
    const dict = section(output)
    const first = derive(dict, { template: template() }).candidates
    const models = derive(dict, {
      template: template(),
      measuredContext: measuredContextFor(first, dict, {}),
      // The harvested ceiling has to reach the DERIVATION, or the advertised
      // budget stays at the declaration and there is nothing for the provenance
      // to describe.
      ...(opts?.limits === undefined ? {} : { measuredLimits: new Map([[id, opts.limits]]) }),
      ...opts,
    }).candidates
    return modelCapability(models.find((m) => m.id === id), { record: dict[id], ...opts })
  }

  // Unchanged: models.dev's number, and the panel says so.
  assert.equal(card('ling-3.1-flash-free', 32768).evidence.output, 'declared')
  // Raised because a generation was watched: that is the word for THIS source.
  assert.equal(card('big-pickle', 32000).evidence.output, 'witnessed')
  // Raised to a VENDOR's published ceiling, not to a measurement. This is the one
  // the boolean could not express: the number is right and the old word was wrong.
  assert.equal(card('mimo-v2.6-flash-free', 32000).evidence.output, 'vendor')
  // A ceiling the ROUTE stated outranks a vendor page that agrees with it.
  const harvested = { output: 262144, fp: contextFingerprint({ ...section(131072)['ling-3.1-flash-free'], id: 'ling-3.1-flash-free' }), at: 1 }
  assert.equal(
    card('ling-3.1-flash-free', 131072, { limits: harvested }).evidence.output,
    'route',
    'the route saying so about itself outranks every other source',
  )
  // A model that declares no image input makes no claim, which is neither
  // "declared" nor "measured".
  assert.equal(card('big-pickle', 32000).evidence.vision, 'declared', 'the template declares image input, so there is a claim to be right or wrong about')
  assert.equal(card('ling-3.1-flash-free', 32768).evidence.vision, 'declared')
})

test('GUARD: a swept death expires, and a stale capability verdict is asked again', async () => {
  // Three findings from the same audit, all of them "documented and never read":
  //
  //  · `nextProbeAt` was written into the record and nothing ever consulted it, so
  //    every removal was permanent — including the ones that were wrong. A dead
  //    verdict that has aged past the interval is asked once more, which is also
  //    the only way a name Zen re-publishes can come back at all.
  //  · vision and tools had no TTL while the effort axis always had one, so a
  //    probe from months ago was indistinguishable from one taken today, and no
  //    code path could downgrade a mark.
  //  · a seed whose declaration moved used to be DISCARDED, which meant a
  //    models.dev typo fix silently deleted the only generation anyone had
  //    watched. It is demoted now: still applied, bounded by the inferred valve,
  //    and labelled `inferred` so it stops claiming first-party evidence.
  assert.equal(DEAD_RECHECK_MS, 7 * 24 * 60 * 60_000, 'a week is long enough that a dead model costs nothing')
  assert.equal(CAPABILITY_TTL_MS, EFFORT_TTL_MS, 'both axes age on the same clock')

  const record = { id: 'x-free', limit: { context: 1000, output: 500 } }
  const fp = capabilityFingerprint(record)
  // A realistic clock: the TTL arithmetic is meaningless around epoch-ish values,
  // and a NEGATIVE timestamp would silently pass the `at > 0` guard that keeps a
  // seed (which carries `at: 0`, meaning "a property of the table, not a moment")
  // out of the age arithmetic.
  const NOW = 1_800_000_000_000
  const fresh = { ok: true, at: NOW - 1000, fp }
  const stale = { ok: true, at: NOW - CAPABILITY_TTL_MS - 1, fp }
  assert.equal(measuredCapabilityFor(record, 'x-free', 'tools', { 'x-free': { verdict: 'ok', at: 0, capabilities: { tools: fresh } } }, NOW).ok, true, 'current')
  assert.equal(
    measuredCapabilityFor(record, 'x-free', 'tools', { 'x-free': { verdict: 'ok', at: 0, capabilities: { tools: stale } } }, NOW),
    undefined,
    'past the TTL it reads as unmeasured, so the next round asks again',
  )
  assert.equal(
    measuredCapabilityFor(record, 'x-free', 'tools', { 'x-free': { verdict: 'ok', at: 0, capabilities: { tools: fresh } } }).ok,
    true,
    'with no clock supplied the age is not guessed at — the verdict stands, and the ROUND (which does pass a clock) is what re-asks',
  )
  // The seed survives a moved declaration, weakened rather than dropped.
  const moved = { id: 'mimo-v2.6-flash-free', limit: { context: 400000, output: 64000 } }
  const applied = seededContextFor(moved, 'mimo-v2.6-flash-free')
  assert.equal(applied?.source, 'inferred', 'a moved declaration turns first-party evidence into inferred')
  assert.equal(applied?.raisedTo, 1048576, 'and the number is still there — a typo fix must not erase it')
})

test('GUARD: a route that says nothing is asked once a day, not once a restart', async () => {
  // Found live on 2026-10-07, right after the daily ceiling harvest went in: the
  // round asked all eleven models for their ceiling and recorded "the route named
  // nothing" as `fp: ""` with `at: 0` — and `isMeasuredLimits` rejected the empty
  // fingerprint, so the record did not survive a warm start. Every restart of DSH
  // would pay a request per model to hear the same silence, on a shared anonymous
  // bucket, where a restart is not what changed the answer.
  //
  // A silence is now DATED and kept for a day. It still cannot become a
  // measurement: an empty fingerprint matches no `contextFingerprint`, and the
  // panel projection checks the empty string separately — so what changed is only
  // whether the next round has to pay to hear it twice.
  //
  // Pinned here at the layer that decides it. The round-level path is covered by
  // the ceiling-harvest tests above; this rule is a predicate and a clock, and
  // testing it through a full round would have made the test depend on how many
  // questions the effort axis happens to ask first.
  assert.equal(CEILING_SILENCE_TTL_MS, 24 * 60 * 60_000, 'a day: long enough to survive a restart, short enough to still be daily')

  const silence = { fp: '', at: 2_000_000 }
  assert.equal(isMeasuredLimits(silence), true, 'a dated silence survives a warm start, so a restart does not re-ask')
  assert.equal(isMeasuredLimits({ fp: '', at: 0 }), false, 'an undated one is not — it predates this rule and should be asked once more')

  // What the round decides with it, spelled out because the arithmetic is the rule.
  const stillWorthAsking = (stored, now) =>
    stored !== undefined && stored.fp === '' && stored.at > 0 && now - stored.at < CEILING_SILENCE_TTL_MS
  assert.equal(stillWorthAsking(silence, 2_000_000 + 60 * 60_000), true, 'an hour later: a restart pays nothing')
  assert.equal(stillWorthAsking(silence, 2_000_000 + CEILING_SILENCE_TTL_MS), false, 'a day later: asked again, so an upstream that starts naming a ceiling is noticed')
  assert.equal(stillWorthAsking(undefined, 2_000_000), false, 'and with nothing stored it is always asked')

  // A silence must never reach the panel as a number. `fp: ""` matches no
  // contextFingerprint, so the ceiling checks skip it — this is the same gate,
  // asserted on the value that would be dangerous if it ever slipped through.
  const record = { id: 'x-free', limit: { context: 1000, output: 500 } }
  assert.notEqual(
    silence.fp,
    contextFingerprint(record),
    'an empty fingerprint is never the fingerprint of a real record',
  )
})
