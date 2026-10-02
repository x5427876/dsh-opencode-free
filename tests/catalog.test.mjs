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
    reasoning_options: [{ type: 'toggle' }],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  // active, responses via effort
  'muse-spark-1.3-contributor-free': {
    id: 'muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Free',
    reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 1048576, output: 32768 },
  },
  // free but retired upstream
  'muse-spark-1.2-contributor-free': {
    id: 'muse-spark-1.2-contributor-free',
    name: 'Muse Spark 1.2 Free',
    status: 'deprecated',
    reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  'deepseek-v4-flash-free': {
    id: 'deepseek-v4-flash-free',
    name: 'DeepSeek V4 Flash Free',
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
  // space-bunny-free, real record 2026-09-29. `off` stays absent (offered):
  // the placeholder effort that would otherwise reach the wire is stripped by
  // the plugin's onPayload guard instead (see the GUARD test in
  // compatibility.test.mjs).
  assert.deepEqual(
    thinkingLevelMapFor({
      reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    }),
    {
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  )
  // muse-spark, real record: no `max`, so it must not be offered.
  assert.deepEqual(
    thinkingLevelMapFor({
      reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    }),
    {
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    },
  )
  // Off is never claimed either way: it means "send no reasoning parameter".
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['low'] }] }),
      'off',
    ),
    false,
  )
})

test('thinkingLevelMapFor claims nothing when models.dev publishes no levels', () => {
  // A `toggle` model is reasoning on/off and pi-ai has no name for bare "on";
  // guessing would offer levels upstream rejects, which the host reports as
  // UNSUPPORTED_REASONING_EFFORT rather than clamping.
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'toggle' }] }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: [] }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: undefined }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: 'nonsense' }), undefined)
  // An effort option with no usable level names is not a level list.
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort' }] }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: [] }] }), undefined)
  assert.equal(
    thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['turbo', 7, null] }] }),
    undefined,
  )
  // Levels pi-ai does not know cannot be expressed, so a list of only those
  // makes no claim rather than producing an empty map.
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['turbo'] }] }), undefined)
})

test('the levels a host offers follow models.dev, per model', () => {
  // The map the record produces, read back through pi-ai's own filter.
  // `off` is absent from every produced map, which is what keeps it offered —
  // the wire shape it would otherwise produce is guarded in zen-provider.ts.
  const of = (id) =>
    getSupportedThinkingLevels({
      id,
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapFor(modelsDict()[id]),
    })
  assert.deepEqual(of('space-bunny-free'), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(of('muse-spark-1.3-contributor-free'), [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  // No published list: pi-ai's default set, unchanged from before this work.
  assert.deepEqual(of('big-pickle'), ['off', 'minimal', 'low', 'medium', 'high'])
  assert.deepEqual(of('ling-3.0-flash-fin-free'), ['off', 'minimal', 'low', 'medium', 'high'])
  // The derived records themselves carry the same maps.
  const derived = derive(modelsDict(), { template: template(), knownApis: new Map() })
  const spark = derived.candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.deepEqual(getSupportedThinkingLevels(spark), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
})

test('GUARD: "off" is offered but never reaches the wire', () => {
  // pi-ai's responses transport renders an unoffered default as
  // `reasoning: { effort: "none" }` and an explicit "off" as `effort: "off"` —
  // two values neither pi-ai's own builtin records nor OpenCode ever send.
  // Keeping "off" offered is only safe because the plugin's onPayload guard
  // strips exactly those placeholders (see compatibility.test.mjs); this pins
  // the precondition that makes the guard necessary.
  const spark = derive(modelsDict(), { template: template(), knownApis: new Map() }).candidates.find(
    (m) => m.id === 'muse-spark-1.3-contributor-free',
  )
  assert.equal(getSupportedThinkingLevels(spark).includes('off'), true, 'off is offered')
  assert.equal(Object.prototype.hasOwnProperty.call(spark.thinkingLevelMap ?? {}, 'off'), false)
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
  // A level the model does not publish clamps DOWN rather than being offered.
  assert.equal(getSupportedThinkingLevels(bunny).includes('minimal'), false)
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
  assert.equal(pickle.maxTokens, 32000)
  // A record that publishes nothing falls back to the template per field.
  const bare = derive(
    { 'bare-free': { id: 'bare-free', cost: { input: 0, output: 0 } } },
    { template: template() },
  ).candidates[0]
  assert.equal(bare.contextWindow, template().contextWindow)
  assert.equal(bare.maxTokens, template().maxTokens)
  assert.deepEqual(bare.input, template().input)
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
  assert.deepEqual(card('space-bunny-free'), { id: 'space-bunny-free', image: true, thinking: 'max' })
  assert.deepEqual(card('muse-spark-1.3-contributor-free'), {
    id: 'muse-spark-1.3-contributor-free',
    image: true,
    thinking: 'xhigh',
  })
  // Toggle-only and level-less records get no thinking badge. `ling` publishes
  // neither image input nor levels, so it inherits the template's text+image
  // input — the fallback pinned by the modalities test above. A badge rendered
  // from that record is faithful to the record; the record itself is a guess
  // for undeclared fields, which is what the template is for.
  assert.deepEqual(card('ling-3.0-flash-fin-free'), {
    id: 'ling-3.0-flash-fin-free',
    image: true,
    thinking: null,
  })
  assert.deepEqual(card('big-pickle'), { id: 'big-pickle', image: false, thinking: null })
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
    assert.equal(bunny.thinking, 'max')
    // Cards carry names and booleans only — never the full records.
    for (const card of state.capabilities) {
      assert.deepEqual(Object.keys(card).sort(), ['id', 'image', 'thinking'])
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

test('derive keeps only text/image modalities and falls back when none survive', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.deepEqual(bunny.input, ['text', 'image'], 'audio/video are not pi-ai input kinds')
  const ling = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  assert.deepEqual(ling.input, ['text', 'image'], 'no modalities -> template input')
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
  let inFlight = 0
  let overlapped = false
  const probe = async (model) => {
    calls.push(model.id)
    inFlight += 1
    if (inFlight > 1) overlapped = true
    await tick()
    inFlight -= 1
    return verdicts[model.id] ?? { kind: 'ok' }
  }
  probe.calls = calls
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

const SERVED = ['big-pickle', 'ling-3.0-flash-fin-free', 'muse-spark-1.3-contributor-free']

const DERIVED = [
  'big-pickle',
  'deepseek-v4-flash-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'space-bunny-free',
]

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
        total: 0,
        done: 0,
        current: null,
        results: {},
        targets: [],
        startedAt: 0,
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
    assert.equal(seen.length, DERIVED.length, 'one reading was taken per model, mid-round')
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
