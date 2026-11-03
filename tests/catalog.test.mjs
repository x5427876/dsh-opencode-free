import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  CACHE_VERSION,
  CATALOG_TTL_MS,
  cachePath,
  catalogueIsStale,
  channelFor,
  costClassOf,
  createCatalog,
  derive,
  effectiveList,
  fetchOfficialList,
  initialState,
  isFree,
  modelCapability,
  parseOfficialList,
  planRound,
  probeRowFor,
  probedToday,
  readCache,
  runProbeRound,
  thinkingLevelMapFor,
  topThinkingLevel,
  writeCacheAtomic,
} from '../src/catalog.ts'
import { BASE_URL, OPENCODE_USER_AGENT } from '../src/zen-provider.ts'

/**
 * Fixtures reproduce the shape of Zen's official model list
 * (`GET /inference/v1/models`, read 2026-10-30): `{ data: [...] }` whose entries
 * carry `type`, `cost.text.{input,output}.price`, `limit`, `modalities`,
 * `capabilities.reasoning` and an `api` object keyed by the endpoint the model
 * is served on. The real list has 78 entries, 8 of them free chat models; the
 * set below keeps one of every case the plugin has to tell apart.
 */
const price = (input = 0, output = 0) => ({ text: { input: { price: input }, output: { price: output } } })

const chat = (id, over = {}) => ({ id, name: id, type: 'chat', cost: price(), ...over })

const officialEntries = () => [
  // free, completions, reasoning_content passback, text only
  chat('big-pickle', {
    name: 'Big Pickle',
    limit: { context: 200000, output: 32000 },
    modalities: { input: ['text'], output: ['text'] },
    capabilities: { reasoning: { supported: true } },
    api: { 'chat-completions': { compatibility: { reasoning_field: 'reasoning_content' } } },
  }),
  // free, completions, publishes nothing else
  chat('ling-3.0-flash-fin-free', { name: 'Ling 3.0 Flash Fin Free', api: { 'chat-completions': {} } }),
  // free, responses, effort levels including the `none` pi-ai has no name for
  chat('muse-spark-1.3-contributor-free', {
    name: 'Muse Spark 1.3 Free',
    limit: { context: 1048576, output: 32768 },
    capabilities: {
      reasoning: { supported: true, effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    },
    api: { responses: {} },
  }),
  chat('muse-spark-1.2-contributor-free', {
    name: 'Muse Spark 1.2 Free',
    capabilities: { reasoning: { supported: true, effort: ['minimal', 'low', 'medium', 'high', 'xhigh'] } },
    api: { responses: {} },
  }),
  chat('deepseek-v4-flash-free', {
    name: 'DeepSeek V4 Flash Free',
    limit: { context: 200000, output: 128000 },
    api: { 'chat-completions': {} },
  }),
  // free, image MIME and a video type pi-ai cannot carry, top level `max`
  chat('space-bunny-free', {
    name: 'Space Bunny Free',
    limit: { context: 1048576, input: 524288, output: 524288 },
    modalities: { input: ['text', 'image/png', 'video/mp4'], output: ['text'] },
    capabilities: { reasoning: { supported: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    api: { 'chat-completions': { compatibility: { reasoning_field: 'reasoning_content' } } },
  }),
  // never offered: paid, not conversational, cost unreadable
  chat('gpt-6-astra', { name: 'GPT 6 Astra', cost: price(1.25, 10) }),
  { id: 'embed-free', name: 'Embed Free', type: 'embedding', cost: price() },
  { id: 'unpriced-chat', name: 'Unpriced Chat', type: 'chat' },
]

const FREE_IDS = [
  'big-pickle',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free',
  'deepseek-v4-flash-free',
  'space-bunny-free',
]

const DERIVED = FREE_IDS.slice().sort()

const entryFor = (id) => officialEntries().find((entry) => entry.id === id)

const listBody = (entries = officialEntries()) => ({ object: 'list', data: entries })

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

function fakeResponse({ status = 200, body = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** One scripted answer per call, in order; a call past the script throws. */
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

/**
 * Answers every call with the list `source()` returns right now, so a test can
 * change what Zen publishes between two reads without scripting each one.
 */
function listFetch(source = officialEntries) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return fakeResponse({ body: listBody(source()) })
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

// ── the free rule and the list parser ───────────────────────────────────────

test('isFree accepts only a conversational entry whose every declared price is zero', () => {
  assert.equal(isFree(chat('a')), true)
  assert.equal(isFree(chat('a', { cost: price(0, 1) })), false)
  assert.equal(isFree(chat('a', { cost: price(1, 0) })), false)
  assert.equal(isFree({ id: 'a', type: 'embedding', cost: price() }), false, 'only conversational entries')
  assert.equal(isFree({ id: 'a', type: 'chat' }), false, 'no cost proves nothing')
  assert.equal(isFree(chat('a', { cost: {} })), false)
  assert.equal(isFree(chat('a', { cost: null })), false)
})

test('costClassOf reads every declared dimension and never guesses an unreadable one', () => {
  const withCache = (inputCache, outputCache) => ({
    cost: {
      text: {
        input: { price: 0, ...(inputCache === undefined ? {} : { cache: inputCache }) },
        output: { price: 0, ...(outputCache === undefined ? {} : { cache: outputCache }) },
      },
    },
  })
  assert.equal(costClassOf(chat('a')), 'free')
  assert.equal(costClassOf(chat('a', { cost: price(0, 0.5) })), 'paid')
  // A declared cache price counts: free means EVERY declared dimension is zero.
  assert.equal(costClassOf(withCache({ read: 0, write: 0 })), 'free', 'declared and zero is still free')
  assert.equal(costClassOf(withCache({ read: 0.1, write: 0 })), 'paid', 'a paid cache read is a price')
  assert.equal(costClassOf(withCache(undefined, { write: 2 })), 'paid', 'on the output side too')
  // Anything that is not a readable non-negative number is unreadable, not zero.
  for (const bad of [
    {},
    { text: {} },
    { text: { input: { price: 0 } } },
    { text: { input: { price: 0 }, output: { price: '0' } } },
    { text: { input: { price: -1 }, output: { price: 0 } } },
    { text: { input: { price: Number.NaN }, output: { price: 0 } } },
    { text: { input: 0, output: 0 } },
  ]) {
    assert.equal(costClassOf({ cost: bad }), 'unparseable', JSON.stringify(bad))
  }
  assert.equal(costClassOf(withCache('free')), 'unparseable', 'a cache that is not an object')
  assert.equal(costClassOf(withCache({ read: 'free' })), 'unparseable', 'a cache price that is not a number')
  assert.equal(costClassOf({}), 'unparseable')
})

test('parseOfficialList keeps the free chat entries in published order and counts what it cannot read', () => {
  const list = parseOfficialList(listBody())
  assert.deepEqual(ids(list.free), FREE_IDS, 'published order, free chat entries only')
  assert.equal(list.unclassified, 1, 'one chat entry has no readable cost; it is counted, not offered')
  assert.ok(!ids(list.free).includes('unpriced-chat'), 'an unreadable cost is never guessed free')
  assert.ok(!ids(list.free).includes('gpt-6-astra'), 'a paid model is not offered')
  assert.ok(!ids(list.free).includes('embed-free'), 'a free embedding model is not a chat model')
})

test('parseOfficialList says "could not tell" for anything that is not a usable list', () => {
  for (const body of [null, undefined, 'text', 42, [], {}, { data: 'nope' }, { data: {} }, { models: [] }]) {
    assert.equal(parseOfficialList(body), null, JSON.stringify(body))
  }
  assert.equal(parseOfficialList({ data: [] }), null, 'an empty list is not an answer')
  assert.equal(parseOfficialList({ data: [null, 1, 'x', [], {}] }), null, 'nothing with an id is not a list')
  // A renamed price field makes every entry unreadable. That is a changed
  // shape, not a withdrawal of every model, so it must not empty the picker.
  assert.equal(
    parseOfficialList({
      data: [
        { id: 'a', type: 'chat', cost: { text: { input: { amount: 0 }, output: { amount: 0 } } } },
        { id: 'b', type: 'chat', cost: { text: { input: { amount: 0 }, output: { amount: 0 } } } },
      ],
    }),
    null,
    'not one entry has a readable cost',
  )
})

test('parseOfficialList accepts a well-formed list that names no free model', () => {
  const list = parseOfficialList({ data: [chat('paid-a', { cost: price(1, 2) }), chat('paid-b', { cost: price(3, 4) })] })
  assert.deepEqual(list, { free: [], unclassified: 0 }, 'zero free models is the answer, not a failure')
})

test('parseOfficialList skips malformed and duplicate entries instead of throwing', () => {
  const list = parseOfficialList({
    data: [null, 7, 'x', [], { type: 'chat', cost: price() }, { id: '', type: 'chat', cost: price() }, chat('a'), chat('a'), chat('b')],
  })
  assert.deepEqual(ids(list.free), ['a', 'b'], 'entries without an id are skipped and a repeated id counts once')
  assert.equal(list.unclassified, 0)
})

// ── fetch ───────────────────────────────────────────────────────────────────

test('fetchOfficialList returns the parsed list and sends the free tier request', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ body: listBody() })])
  const result = await fetchOfficialList({ fetchImpl })
  assert.equal(result.kind, 'ok')
  assert.deepEqual(ids(result.list.free), FREE_IDS)
  assert.equal(result.list.unclassified, 1)
  const [call] = fetchImpl.calls
  assert.equal(call.url, `${BASE_URL}/models`)
  assert.equal(call.headers.Authorization, 'Bearer public', 'the anonymous key the free tier requires')
  assert.equal(call.headers['User-Agent'], OPENCODE_USER_AGENT)
  assert.equal(call.headers['x-opencode-client'], 'cli')
})

test('fetchOfficialList uses the request it is given', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ body: listBody() })])
  await fetchOfficialList({
    fetchImpl,
    request: { url: 'https://example.test/models', headers: { Authorization: 'Bearer k' } },
  })
  assert.equal(fetchImpl.calls[0].url, 'https://example.test/models')
  assert.deepEqual(fetchImpl.calls[0].headers, { Authorization: 'Bearer k' })
})

test('fetchOfficialList reports http, malformed, unrecognised and oversize as failed', async () => {
  const cases = [
    [fakeResponse({ status: 500 }), 'http 500'],
    [fakeResponse({ status: 429 }), 'http 429'],
    [fakeResponse({ body: 'not json at all' }), 'malformed response body'],
    [fakeResponse({ body: '[]' }), 'unrecognised model list'],
    [fakeResponse({ body: { data: [] } }), 'unrecognised model list'],
    [fakeResponse({ body: { anthropic: {} } }), 'unrecognised model list'],
  ]
  for (const [response, reason] of cases) {
    const result = await fetchOfficialList({ fetchImpl: scriptedFetch([response]) })
    assert.equal(result.kind, 'failed', reason)
    assert.equal(result.reason, reason)
  }
  const oversize = await fetchOfficialList({
    fetchImpl: scriptedFetch([fakeResponse({ body: listBody() })]),
    maxBytes: 10,
  })
  assert.deepEqual(oversize, { kind: 'failed', reason: 'response too large' })
})

test('fetchOfficialList classifies a timeout and never throws', async () => {
  const aborted = () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  assert.deepEqual(await fetchOfficialList({ fetchImpl: scriptedFetch([aborted]) }), {
    kind: 'failed',
    reason: 'timeout',
  })
  const offline = await fetchOfficialList({
    fetchImpl: scriptedFetch([
      () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    ]),
  })
  assert.deepEqual(offline, { kind: 'failed', reason: 'getaddrinfo ENOTFOUND' })
})

// ── T1 derivation ───────────────────────────────────────────────────────────

test('derive offers the free chat entries, in id order, and nothing else', () => {
  const { candidates } = derive(officialEntries(), { template: template() })
  assert.deepEqual(ids(candidates), DERIVED, 'sorted here, at the one place the list is born')
  for (const id of ['gpt-6-astra', 'embed-free', 'unpriced-chat']) {
    assert.ok(!ids(candidates).includes(id), `${id} must not be offered`)
  }
})

test('derive skips malformed entries and repeated ids instead of throwing', () => {
  const { candidates } = derive([null, 7, 'x', [], { type: 'chat', cost: price() }, chat('a'), chat('a'), chat('b')], {
    template: template(),
  })
  assert.deepEqual(ids(candidates), ['a', 'b'])
  assert.equal(candidates[0].name, 'a', 'name falls back to the id')
})

test('GUARD: the list body itself never derives into a catalogue', () => {
  // `derive` takes ENTRIES. Handing it the answer — `{ data: [...] }` — must
  // produce nothing rather than a model named after a wrapper key.
  assert.deepEqual(derive([listBody()], { template: template() }).candidates, [])
  assert.equal(derive(parseOfficialList(listBody()).free, { template: template() }).candidates.length, FREE_IDS.length)
})

test('GUARD: fetchOfficialList output feeds derive directly from a real-shaped answer', async () => {
  const result = await fetchOfficialList({ fetchImpl: scriptedFetch([fakeResponse({ body: listBody() })]) })
  assert.equal(result.kind, 'ok')
  const { candidates } = derive(result.list.free, { template: template() })
  assert.deepEqual(ids(candidates), DERIVED)
})

test('channelFor reads the channel the entry itself declares', () => {
  assert.equal(channelFor({ id: 'x', api: { 'chat-completions': {} } }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', api: { responses: {} } }), 'openai-responses')
})

test('channelFor prefers the entry, then the pi-ai builtin table, then completions', () => {
  const known = new Map([['big-pickle', 'openai-responses']])
  assert.equal(
    channelFor({ id: 'big-pickle', api: { 'chat-completions': {} } }, known),
    'openai-completions',
    "the upstream's own statement outranks the table",
  )
  assert.equal(channelFor({ id: 'big-pickle' }, known), 'openai-responses', 'no declaration: the table')
  assert.equal(channelFor({ id: 'unknown' }, known), 'openai-completions', 'nothing known: opencode is openai-compatible')
  assert.equal(channelFor({ id: 'x' }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', api: [] }), 'openai-completions', 'an array is not an api object')
  assert.equal(channelFor({ id: 'x', api: 'nonsense' }), 'openai-completions')
})

test('channelFor agrees with the opencode models pi-ai actually lists', () => {
  // Ground truth is the pi-ai builtin table read from node_modules, so every id
  // is asserted present in it first: an id the table no longer has falls through
  // to the provider default, which could yield the same channel and keep this
  // passing while proving nothing.
  const table = new Map(getBuiltinModels('opencode').map((m) => [m.id, m.api]))
  const truth = {
    'big-pickle': 'openai-completions',
    'beam-free': 'openai-completions',
    'mimo-v2.6-flash-free': 'openai-completions',
    'nemotron-3-ultra-free': 'openai-completions',
    'nemotron-3.5-lightning-free': 'openai-completions',
    'muse-spark-1.3': 'openai-responses',
  }
  for (const [id, expected] of Object.entries(truth)) {
    assert.equal(table.get(id), expected, `${id} is still in pi-ai's table with that channel`)
    assert.equal(channelFor({ id }, table), expected, `${id} through the table`)
  }
  // And the entries that DO declare it say the same thing the table does.
  const declared = {
    'big-pickle': 'openai-completions',
    'ling-3.0-flash-fin-free': 'openai-completions',
    'muse-spark-1.3-contributor-free': 'openai-responses',
  }
  for (const [id, expected] of Object.entries(declared)) {
    assert.equal(channelFor(entryFor(id)), expected, `${id} through its own declaration`)
  }
})

// ── capability alignment (the official list is the source for all four) ─────

/**
 * pi-ai's own reader, used as the oracle: these tests assert the LEVELS A HOST
 * WILL OFFER, not just the shape of the map we hand it. The two differ —
 * `xhigh`/`max` are opt-in (absent ⇒ not offered) while the lower levels are
 * offered unless explicitly nulled — and getting that backwards is exactly the
 * bug this alignment fixes.
 */
const { getSupportedThinkingLevels, clampThinkingLevel } = await import('@earendil-works/pi-ai')

const effort = (...values) => ({ capabilities: { reasoning: { effort: values } } })

test('thinkingLevelMapFor maps the published effort levels and nulls the rest', () => {
  // space-bunny-free. `off` stays absent (offered): the placeholder effort that
  // would otherwise reach the wire is stripped by the plugin's onPayload guard
  // instead (see the GUARD test in compatibility.test.mjs).
  assert.deepEqual(thinkingLevelMapFor(effort('low', 'medium', 'high', 'xhigh', 'max')), {
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  })
  // muse-spark: no `max`, so it must not be offered.
  assert.deepEqual(thinkingLevelMapFor(effort('minimal', 'low', 'medium', 'high', 'xhigh')), {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(thinkingLevelMapFor(effort('low')), 'off'), false)
})

test('thinkingLevelMapFor ignores a published `none`, which pi-ai has no level for', () => {
  const map = thinkingLevelMapFor(effort('none', 'low', 'high'))
  assert.deepEqual(map, { minimal: null, low: 'low', medium: null, high: 'high' })
  assert.equal(Object.prototype.hasOwnProperty.call(map, 'none'), false)
  assert.equal(thinkingLevelMapFor(effort('none')), undefined, '`none` alone is not a level list')
})

test('thinkingLevelMapFor claims nothing when the list publishes no levels', () => {
  // Guessing would offer levels upstream rejects, which the host reports as
  // UNSUPPORTED_REASONING_EFFORT rather than clamping.
  assert.equal(thinkingLevelMapFor({}), undefined)
  assert.equal(thinkingLevelMapFor({ capabilities: {} }), undefined)
  assert.equal(thinkingLevelMapFor({ capabilities: { reasoning: {} } }), undefined)
  assert.equal(thinkingLevelMapFor({ capabilities: { reasoning: { supported: true } } }), undefined)
  assert.equal(thinkingLevelMapFor(effort()), undefined)
  assert.equal(thinkingLevelMapFor({ capabilities: { reasoning: { effort: 'high' } } }), undefined)
  assert.equal(thinkingLevelMapFor(effort('turbo', 7, null)), undefined)
  // Levels pi-ai does not know cannot be expressed, so a list of only those
  // makes no claim rather than producing an empty map.
  assert.equal(thinkingLevelMapFor(effort('turbo')), undefined)
})

test('the levels a host offers follow the list, per model', () => {
  // The map each entry produces, read back through pi-ai's own filter.
  const of = (id) =>
    getSupportedThinkingLevels({
      id,
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapFor(entryFor(id)),
    })
  assert.deepEqual(of('space-bunny-free'), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(of('muse-spark-1.3-contributor-free'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  // No published list: pi-ai's default set.
  assert.deepEqual(of('big-pickle'), ['off', 'minimal', 'low', 'medium', 'high'])
  assert.deepEqual(of('ling-3.0-flash-fin-free'), ['off', 'minimal', 'low', 'medium', 'high'])
  // The derived records themselves carry the same maps.
  const derived = derive(officialEntries(), { template: template(), knownApis: new Map() })
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
  const spark = derive(officialEntries(), { template: template(), knownApis: new Map() }).candidates.find(
    (m) => m.id === 'muse-spark-1.3-contributor-free',
  )
  assert.equal(getSupportedThinkingLevels(spark).includes('off'), true, 'off is offered')
  assert.equal(Object.prototype.hasOwnProperty.call(spark.thinkingLevelMap ?? {}, 'off'), false)
})

test('GUARD: the muse-spark xhigh default is not silently clamped away', () => {
  // The plugin asks for `xhigh` on muse-spark (zen-provider streamSimple). With
  // no thinkingLevelMap, pi-ai's supported set tops out at `high` and the
  // request was quietly downgraded — the model never got the effort it was
  // asked for. Aligning the map from the list is what fixes it.
  const { candidates } = derive(officialEntries(), { template: template(), knownApis: new Map() })
  const spark = candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.equal(clampThinkingLevel(spark, 'xhigh'), 'xhigh', 'the requested level survives')
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.equal(clampThinkingLevel(bunny, 'max'), 'max', 'a published opt-in level is reachable')
  // A level the model does not publish clamps DOWN rather than being offered.
  assert.equal(getSupportedThinkingLevels(bunny).includes('minimal'), false)
})

test('a derived record carries all four capabilities from the list', () => {
  const { candidates } = derive(officialEntries(), { template: template(), knownApis: new Map() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  // modalities.input: pi-ai knows text/image only. `image/png` counts as image;
  // video is dropped rather than passed through as a capability the transport
  // cannot honour.
  assert.deepEqual(bunny.input, ['text', 'image'])
  assert.equal(bunny.contextWindow, 1048576, 'limit.context')
  assert.equal(bunny.maxTokens, 524288, 'limit.output')
  assert.equal(bunny.reasoning, true, 'capabilities.reasoning.supported')
  // A model with no image support must not inherit the template's.
  const pickle = candidates.find((m) => m.id === 'big-pickle')
  assert.deepEqual(pickle.input, ['text'], 'text-only stays text-only')
  assert.equal(pickle.contextWindow, 200000)
  assert.equal(pickle.maxTokens, 32000)
  // An entry that publishes nothing falls back to the template per field.
  const bare = derive([chat('bare-free')], { template: template() }).candidates[0]
  assert.equal(bare.contextWindow, template().contextWindow)
  assert.equal(bare.maxTokens, template().maxTokens)
  assert.deepEqual(bare.input, template().input)
  assert.equal(bare.reasoning, template().reasoning)
  // The template's level map is never inherited: it belongs to another model.
  assert.equal(bare.thinkingLevelMap, undefined)
})

test('derive reads reasoning support as declared, in both directions', () => {
  const entry = (supported) => chat('r', { capabilities: { reasoning: { supported } } })
  assert.equal(derive([entry(false)], { template: template() }).candidates[0].reasoning, false)
  assert.equal(derive([entry(true)], { template: template() }).candidates[0].reasoning, true)
  assert.equal(
    derive([entry('yes')], { template: template() }).candidates[0].reasoning,
    template().reasoning,
    'a non-boolean is not a declaration',
  )
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
  const { candidates } = derive(officialEntries(), { template: template(), knownApis: new Map() })
  const card = (id) => modelCapability(candidates.find((m) => m.id === id))
  assert.deepEqual(card('space-bunny-free'), { id: 'space-bunny-free', image: true, thinking: 'max' })
  assert.deepEqual(card('muse-spark-1.3-contributor-free'), {
    id: 'muse-spark-1.3-contributor-free',
    image: true,
    thinking: 'xhigh',
  })
  // `ling` publishes neither modalities nor levels, so it inherits the
  // template's text+image input. A badge rendered from that record is faithful
  // to the record; the record itself is a guess for undeclared fields, which is
  // what the template is for.
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

test('derive maps published limits and falls back per missing field', () => {
  const { candidates } = derive(officialEntries(), { template: template() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.equal(bunny.contextWindow, 1048576)
  assert.equal(bunny.maxTokens, 524288)
  // ling publishes no limit at all -> template values
  const ling = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  assert.equal(ling.contextWindow, 200000)
  assert.equal(ling.maxTokens, 32000)
  assert.equal(ling.name, 'Ling 3.0 Flash Fin Free')
  // A non-positive or non-numeric limit is not a limit.
  const odd = derive([chat('odd', { limit: { context: 0, output: 'big' } })], { template: template() }).candidates[0]
  assert.equal(odd.contextWindow, template().contextWindow)
  assert.equal(odd.maxTokens, template().maxTokens)
})

test('derive keeps only text/image modalities and falls back when none survive', () => {
  const { candidates } = derive(officialEntries(), { template: template() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.deepEqual(bunny.input, ['text', 'image'], 'audio/video are not pi-ai input kinds')
  const ling = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  assert.deepEqual(ling.input, ['text', 'image'], 'no modalities -> template input')
  const onlyVideo = derive([chat('v', { modalities: { input: ['video/mp4'] } })], { template: template() })
  assert.deepEqual(onlyVideo.candidates[0].input, ['text', 'image'], 'nothing usable -> template input')
})

test('derive inherits identity and zeroes cost on every candidate', () => {
  const { candidates } = derive(officialEntries(), { template: template() })
  for (const model of candidates) {
    assert.equal(model.provider, 'opencode-zen-free')
    assert.equal(model.baseUrl, 'https://opencode.ai/zen/v1')
    assert.equal(model.headers['x-opencode-client'], 'cli')
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
})

test('derive drops transport-specific compat when the channel changes', () => {
  const { candidates } = derive(officialEntries(), { template: template() })
  const completions = candidates.find((m) => m.id === 'big-pickle')
  assert.ok(completions.compat, 'same channel keeps the known-good overrides')
  const responses = candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.equal(responses.api, 'openai-responses')
  assert.equal(responses.compat, undefined, "the template's completions compat must not leak onto responses")
})

test('derive sets reasoning_content passback when the entry declares that field', () => {
  const { candidates } = derive(officialEntries(), { template: template() })
  for (const id of ['big-pickle', 'space-bunny-free']) {
    const model = candidates.find((m) => m.id === id)
    assert.equal(model.compat?.requiresReasoningContentOnAssistantMessages, true, `${id} requires passback`)
    assert.equal(model.compat.supportsStore, false, 'and keeps the known-good overrides')
  }
})

test('derive omits reasoning_content passback when the entry declares no such field', () => {
  const { candidates } = derive(officialEntries(), { template: template() })
  const plain = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  assert.deepEqual(plain.compat, template().compat, 'without the field the template compat is inherited unchanged')
})

test('derive ignores reasoning fields that are not reasoning_content', () => {
  const free = (id, api) => chat(id, { api })
  const entries = [
    // A different wire field: the reasoning_content passback would be the wrong instruction.
    free('foreign-field-free', { 'chat-completions': { compatibility: { reasoning_field: 'reasoning_details' } } }),
    // No field named at all.
    free('no-field-free', { 'chat-completions': { compatibility: {} } }),
    // Not an object where an object is expected.
    free('bare-flag-free', { 'chat-completions': true }),
    free('array-api-free', []),
  ]
  for (const model of derive(entries, { template: template() }).candidates) {
    assert.equal(model.api, 'openai-completions', `${model.id} stays on completions`)
    assert.equal(model.compat.requiresReasoningContentOnAssistantMessages, undefined, `${model.id} takes no passback`)
  }
})

// ── T2 cache ────────────────────────────────────────────────────────────────

test('cachePath honours DSH_HOME and falls back to ~/.dsh', () => {
  const expected = join(homedir(), '.dsh', 'dsh-opencode-free', 'catalog.json')
  assert.equal(cachePath({ DSH_HOME: '/custom/home' }), join('/custom/home', 'dsh-opencode-free', 'catalog.json'))
  assert.equal(cachePath({}), expected)
  assert.equal(cachePath({ DSH_HOME: '' }), expected, 'an empty DSH_HOME is not a home')
})

test('cache round-trips atomically and stores the free entries only', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'catalog.json')
    const free = parseOfficialList(listBody()).free
    assert.equal(await writeCacheAtomic(path, { fetchedAt: 123, models: free }), true)
    const restored = await readCache(path)
    assert.equal(restored.version, CACHE_VERSION)
    assert.equal(restored.fetchedAt, 123)
    assert.deepEqual(ids(restored.models), FREE_IDS)
    assert.deepEqual(restored.probes, {})
    assert.equal(restored.lastProbeAt, 0)
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(Object.keys(onDisk).sort(), ['fetchedAt', 'models', 'version'])
    assert.equal(onDisk.version, 2)
  })
})

test('readCache treats missing, corrupt and foreign-version files as no cache', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readCache(join(dir, 'absent.json')), null)
    const write = async (name, content) => {
      const path = join(dir, name)
      await writeFile(path, content, 'utf8')
      return path
    }
    assert.equal(await readCache(await write('corrupt.json', '{ truncated')), null)
    assert.equal(await readCache(await write('array.json', '[]')), null)
    assert.equal(await readCache(await write('future.json', JSON.stringify({ version: 99, models: [] }))), null)
    assert.equal(await readCache(await write('v0.json', JSON.stringify({ version: 0, models: [] }))), null)
    assert.equal(
      await readCache(await write('v2-shape.json', JSON.stringify({ version: 2, fetchedAt: 1, models: {} }))),
      null,
      'a version 2 file whose models are not an array',
    )
    assert.equal(
      await readCache(await write('v1-shape.json', JSON.stringify({ version: 1, models: 'nope' }))),
      null,
      'a version 1 file whose models are not a dictionary',
    )
  })
})

test('readCache gives a version 1 file its verdicts and nothing else', async () => {
  await withTempDir(async (dir) => {
    // Written before the list became the source: a models.dev dictionary and its
    // ETag belong to a source that no longer exists, but the verdicts and the
    // last round's report are the user's history and survive the upgrade.
    const path = join(dir, 'v1.json')
    const lastRound = { total: 2, done: 2, results: { 'big-pickle': { status: 'ok', ms: 5 } }, targets: ['big-pickle'] }
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        etag: '"v1"',
        fetchedAt: 900_000,
        models: { 'big-pickle': { id: 'big-pickle', cost: { input: 0, output: 0 } } },
        probes: { 'deepseek-v4-flash-free': { verdict: 'dead', at: 5, swept: true } },
        lastProbeAt: 7,
        lastRound,
      }),
      'utf8',
    )
    const restored = await readCache(path)
    assert.equal(restored.version, CACHE_VERSION, 'it reads as the current version')
    assert.equal(restored.fetchedAt, 0, 'no list was ever fetched from the official source')
    assert.deepEqual(restored.models, [], 'the old dictionary is not carried over')
    assert.equal(restored.probes['deepseek-v4-flash-free'].verdict, 'dead')
    assert.equal(restored.lastProbeAt, 7)
    assert.equal(restored.lastRound.total, 2)
  })
})

// ── T3 state container ──────────────────────────────────────────────────────

function catalogWith({ dir, fetchImpl, clock = { t: 1_000_000 }, ttlMs, probe, hidden } = {}) {
  return createCatalog({
    template: template(),
    knownApis: new Map(),
    cachePath: join(dir, 'catalog.json'),
    fetchImpl,
    now: () => clock.t,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(probe === undefined ? {} : { probe }),
    ...(hidden === undefined ? {} : { hidden }),
  })
}

test('a cold container is empty: there is no offline floor to show instead', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([]) })
    const state = catalog.current()
    assert.equal(state.source, 'none')
    assert.deepEqual(state.models, [])
    assert.deepEqual(state.visible, [])
    assert.deepEqual(state.capabilities, [])
    assert.equal(state.updatedAt, 0)
    assert.equal(state.unclassified, 0)
    assert.equal(state.refreshing, false)
    assert.deepEqual(catalog.effectiveModels(), [])
  })
})

test('forceRefresh adopts the free entries and reports where they came from', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = listFetch()
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock })
    await catalog.forceRefresh()
    const state = catalog.current()
    assert.equal(state.source, 'official')
    assert.deepEqual(state.visible, DERIVED)
    assert.deepEqual(ids(state.models), DERIVED)
    assert.equal(state.updatedAt, clock.t)
    assert.equal(state.unclassified, 1, 'the chat entry with no readable cost is counted')
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/models`)
  })
})

test('the default freshness window is thirty minutes, and one axis', async () => {
  assert.equal(CATALOG_TTL_MS, 30 * 60_000)
  await withTempDir(async (dir) => {
    const fetchImpl = listFetch()
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock })
    await catalog.forceRefresh()
    clock.t += CATALOG_TTL_MS - 1_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 1, 'inside the window: no request')
    clock.t += 2_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 2, 'past the window: exactly one request')
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 2, 'and the window starts over')
  })
})

test('ensureFresh honours an explicit ttl', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = listFetch()
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 60_000 })
    await catalog.forceRefresh()
    clock.t += 30_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 1, 'still fresh')
    clock.t += 60_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 2)
  })
})

test('a cold container is stale by definition, however small the clock', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = listFetch()
    const catalog = catalogWith({ dir, fetchImpl, clock: { t: 5 } })
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 1, 'never fetched is not "fresh because now is small"')
    assert.equal(catalog.current().source, 'official')
  })
})

test('concurrent ensureFresh and forceRefresh calls share a single in-flight request', async () => {
  await withTempDir(async (dir) => {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      await held
      return fakeResponse({ body: listBody() })
    }
    const catalog = catalogWith({ dir, fetchImpl })
    const all = Promise.all([
      catalog.ensureFresh(),
      catalog.ensureFresh(),
      catalog.forceRefresh(),
      catalog.forceRefresh(),
    ])
    await tick()
    assert.equal(catalog.current().refreshing, true, 'the snapshot says a refresh is running')
    release()
    await all
    assert.equal(calls, 1, 'one request, not four')
    assert.equal(catalog.current().refreshing, false)
  })
})

test('a failed refresh keeps the held list and does not pretend to be fresh', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ body: listBody() }), fakeResponse({ status: 503 })])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    const before = catalog.current()
    clock.t += 100
    await catalog.ensureFresh()
    const after = catalog.current()
    assert.deepEqual(after.visible, before.visible)
    assert.equal(after.source, 'official')
    assert.equal(after.updatedAt, before.updatedAt, 'a failure does not advance freshness')
    assert.equal(after.unclassified, before.unclassified)
  })
})

test('an answer that is not a usable list is a failure, and leaves list and cache alone', async () => {
  await withTempDir(async (dir) => {
    const unreadable = chat('x', { cost: { text: { input: { amount: 0 }, output: { amount: 0 } } } })
    const answers = [
      fakeResponse({ body: 'not json' }),
      fakeResponse({ body: {} }),
      fakeResponse({ body: { data: [] } }),
      fakeResponse({ body: { data: [unreadable, { ...unreadable, id: 'y' }] } }),
      () => {
        throw new Error('offline')
      },
    ]
    const fetchImpl = scriptedFetch([fakeResponse({ body: listBody() }), ...answers])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock })
    await catalog.forceRefresh()
    const path = join(dir, 'catalog.json')
    const written = await readFile(path, 'utf8')
    for (let i = 0; i < answers.length; i += 1) {
      clock.t += 1_000
      await catalog.forceRefresh()
      assert.deepEqual(catalog.current().visible, DERIVED, `answer ${i} narrows nothing`)
      assert.equal(catalog.current().updatedAt, 1_000_000, `answer ${i} is not a refresh`)
    }
    assert.equal(await readFile(path, 'utf8'), written, 'and nothing is rewritten to disk')
  })
})

test('a failed first refresh leaves the catalogue empty rather than guessed', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      () => {
        throw new Error('offline')
      },
    ])
    const catalog = catalogWith({ dir, fetchImpl })
    await catalog.ensureFresh()
    const state = catalog.current()
    assert.equal(state.source, 'none', 'no list was ever adopted')
    assert.deepEqual(state.models, [])
    assert.deepEqual(state.visible, [])
    assert.equal(state.updatedAt, 0)
  })
})

test('a well-formed answer that names no free model is the answer: the picker empties', async () => {
  await withTempDir(async (dir) => {
    const paidOnly = [chat('paid-a', { cost: price(1, 2) }), chat('paid-b', { cost: price(3, 4) })]
    const fetchImpl = scriptedFetch([
      fakeResponse({ body: listBody() }),
      fakeResponse({ body: { data: paidOnly } }),
    ])
    const catalog = catalogWith({ dir, fetchImpl })
    await catalog.forceRefresh()
    assert.equal(catalog.current().visible.length, FREE_IDS.length)
    await catalog.forceRefresh()
    const state = catalog.current()
    assert.equal(state.source, 'official')
    assert.deepEqual(state.visible, [], 'Zen withdrew every free model; the list says so')
    assert.equal(state.unclassified, 0)
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.deepEqual(onDisk.models, [], 'and that is what is cached')
  })
})

test('unclassified follows the last adopted answer', async () => {
  await withTempDir(async (dir) => {
    const withoutUnpriced = officialEntries().filter((entry) => entry.id !== 'unpriced-chat')
    const fetchImpl = scriptedFetch([
      fakeResponse({ body: listBody() }),
      fakeResponse({ body: listBody(withoutUnpriced) }),
    ])
    const catalog = catalogWith({ dir, fetchImpl })
    await catalog.forceRefresh()
    assert.equal(catalog.current().unclassified, 1)
    await catalog.forceRefresh()
    assert.equal(catalog.current().unclassified, 0, 'a shape that reads again clears the count')
  })
})

test('a sync writes only the free entries, stamped with its own time', async () => {
  await withTempDir(async (dir) => {
    const clock = { t: 1_234_567 }
    const catalog = catalogWith({ dir, fetchImpl: listFetch(), clock })
    await catalog.forceRefresh()
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.deepEqual(Object.keys(onDisk).sort(), ['fetchedAt', 'models', 'version'], 'no verdicts yet, no etag')
    assert.equal(onDisk.version, CACHE_VERSION)
    assert.equal(onDisk.fetchedAt, clock.t)
    assert.deepEqual(ids(onDisk.models), FREE_IDS, 'as published, in published order')
    assert.ok(!JSON.stringify(onDisk).includes('gpt-6-astra'), 'no paid entry is stored')
  })
})

test('a warm cache is adopted on start without touching the network', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'catalog.json')
    await writeCacheAtomic(path, { fetchedAt: 900_000, models: parseOfficialList(listBody()).free })
    const fetchImpl = scriptedFetch([])
    const catalog = catalogWith({ dir, fetchImpl, clock: { t: 1_000_000 }, ttlMs: 600_000 })
    assert.equal(await waitFor(() => catalog.current().source === 'official'), true, 'the warm cache was adopted')
    const state = catalog.current()
    assert.equal(state.updatedAt, 900_000, 'it keeps the time the list was actually fetched')
    assert.deepEqual(state.visible, DERIVED)
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 0, 'a cache inside the window answers without a request')
  })
})

test('a stale warm cache is served at once and revalidated by the first read', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'catalog.json')
    await writeCacheAtomic(path, { fetchedAt: 1, models: parseOfficialList(listBody()).free })
    const withdrawn = officialEntries().filter((entry) => entry.id !== 'space-bunny-free')
    const fetchImpl = scriptedFetch([fakeResponse({ body: listBody(withdrawn) })])
    const catalog = catalogWith({ dir, fetchImpl, clock: { t: 10 * CATALOG_TTL_MS } })
    assert.equal(await waitFor(() => catalog.current().source === 'official'), true)
    assert.ok(catalog.current().visible.includes('space-bunny-free'), 'stale, but better than an empty picker')
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 1)
    assert.ok(!catalog.current().visible.includes('space-bunny-free'), 'and then the list wins')
  })
})

test('a cache that holds no fetched list is not a catalogue, but keeps its verdicts', async () => {
  await withTempDir(async (dir) => {
    // Two ways to arrive here: a version 1 file, and a version 2 file written
    // by a round whose very first list request failed (fetchedAt 0, models []).
    // Adopting either would empty the picker for the sake of the verdicts.
    const path = join(dir, 'catalog.json')
    const v1 = {
      version: 1,
      etag: '"v1"',
      fetchedAt: 900_000,
      models: { 'big-pickle': { id: 'big-pickle', cost: { input: 0, output: 0 } } },
      probes: { 'big-pickle': { verdict: 'dead', at: 5, swept: true } },
      lastProbeAt: 5,
    }
    const v2 = {
      version: 2,
      fetchedAt: 0,
      models: [],
      probes: { 'big-pickle': { verdict: 'dead', at: 5, swept: true } },
      lastProbeAt: 5,
    }
    for (const [name, record] of [['version 1', v1], ['verdicts only', v2]]) {
      await writeFile(path, JSON.stringify(record), 'utf8')
      const fetchImpl = scriptedFetch([fakeResponse({ body: listBody() })])
      const catalog = catalogWith({ dir, fetchImpl })
      assert.equal(await waitFor(() => catalog.current().probedAt === 5), true, `${name}: the verdicts were read`)
      assert.equal(catalog.current().source, 'none', `${name}: no list yet`)
      assert.deepEqual(catalog.current().visible, [], `${name}: the old dictionary is not offered`)
      await catalog.forceRefresh()
      assert.equal(catalog.current().source, 'official', `${name}: the first refresh fetches`)
      assert.ok(!catalog.current().visible.includes('big-pickle'), `${name}: and the dead verdict still applies`)
      assert.equal(catalog.current().visible.length, FREE_IDS.length - 1)
    }
  })
})

test('a model the list withdraws leaves the picker and returns with its verdict when listed again', async () => {
  await withTempDir(async (dir) => {
    let published = officialEntries()
    const clock = { t: 1_000_000 }
    const probe = recordingProber({ 'deepseek-v4-flash-free': DEAD(404) })
    const catalog = catalogWith({ dir, fetchImpl: listFetch(() => published), clock, probe })
    await catalog.forceRefresh()
    await catalog.forceProbes()
    assert.ok(!catalog.current().visible.includes('deepseek-v4-flash-free'), 'judged dead')
    assert.ok(catalog.current().visible.includes('big-pickle'), 'judged ok')

    // Zen withdraws both from the list.
    published = published.filter((e) => e.id !== 'deepseek-v4-flash-free' && e.id !== 'big-pickle')
    clock.t += 10
    await catalog.forceRefresh()
    const withdrawn = catalog.current()
    assert.ok(!withdrawn.visible.includes('big-pickle'), 'a model the list no longer names is not offered')
    assert.ok(!withdrawn.models.some((m) => m.id === 'big-pickle'), 'nor kept as a candidate')
    const kept = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8')).probes
    assert.equal(kept['deepseek-v4-flash-free'].verdict, 'dead', 'a verdict for a withdrawn model is kept')
    assert.equal(kept['big-pickle'].verdict, 'ok')

    // And back again: no cache deletion, no manual recovery, no new probe.
    published = officialEntries()
    clock.t += 10
    await catalog.forceRefresh()
    const relisted = catalog.current()
    assert.ok(relisted.visible.includes('big-pickle'), 'it reappears')
    assert.ok(!relisted.visible.includes('deepseek-v4-flash-free'), 'and the dead one is still dead')
    assert.equal(probe.calls.filter((id) => id === 'big-pickle').length, 1, 'without being asked again')
  })
})

test('effectiveModels and visible stay the same set after a re-sync', async () => {
  await withTempDir(async (dir) => {
    let published = officialEntries()
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl: listFetch(() => published), clock, ttlMs: 10 })
    await catalog.forceRefresh()
    published = published.filter((e) => e.id === 'big-pickle' || !FREE_IDS.includes(e.id))
    clock.t += 100
    await catalog.ensureFresh()
    const state = catalog.current()
    assert.deepEqual(state.visible, ['big-pickle'])
    assert.deepEqual(ids(catalog.effectiveModels()), state.visible, 'picker and panel read one set')
    assert.ok(!state.models.some((m) => m.id === 'space-bunny-free'), 'a withdrawn model is simply gone')
  })
})

test('the snapshot is a copy, so callers cannot mutate catalogue state', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: listFetch() })
    await catalog.forceRefresh()
    const state = catalog.current()
    state.models.push({ ...template(), id: 'injected' })
    state.visible.push('injected')
    assert.ok(!catalog.current().visible.includes('injected'))
    assert.ok(!catalog.current().models.some((m) => m.id === 'injected'))
  })
})

test('the snapshot names exactly the facts the panel renders', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: listFetch() })
    await catalog.forceRefresh()
    assert.deepEqual(Object.keys(catalog.current()).sort(), [
      'capabilities',
      'models',
      'probeInconclusive',
      'probedAt',
      'refreshing',
      'source',
      'unclassified',
      'updatedAt',
      'visible',
    ])
  })
})

test('GUARD: a warm start landing after a sync cannot resurrect the older list', async () => {
  await withTempDir(async (dir) => {
    // The container must answer synchronously, so the warm start reads the
    // cache in the background while the first refresh downloads. If the warm
    // start then adopts, the OLDER list replaces the fresher one and the picker
    // keeps offering a model upstream has withdrawn. The download below yields,
    // which is exactly the window: the warm start lands second.
    const path = join(dir, 'catalog.json')
    await writeCacheAtomic(path, { fetchedAt: 1, models: parseOfficialList(listBody()).free })
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const fetchImpl = scriptedFetch([
      async () => {
        await gate
        return fakeResponse({ body: listBody(officialEntries().filter((e) => e.id === 'big-pickle')) })
      },
    ])
    const catalog = catalogWith({ dir, fetchImpl })
    const syncing = catalog.forceRefresh()
    await tick()
    release()
    await syncing
    assert.deepEqual(catalog.current().visible, ['big-pickle'], 'the sync won, not the warm start')
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(ids(onDisk.models), ['big-pickle'], 'and the file holds the newer list')
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
    fetchImpl: listFetch(),
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



test('a round covers the whole catalogue, in order, one at a time', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    assert.deepEqual(
      probe.calls,
      catalog.current().models.map((m) => m.id),
      'every listed model, in catalogue order',
    )
    assert.deepEqual(probe.calls.slice().sort(), DERIVED, 'and that is the whole list')
    assert.equal(probe.overlapped(), false, 'requests must not overlap')
  })
})

test('a round reads the list again first, so a withdrawn model costs no inference request', async () => {
  await withTempDir(async (dir) => {
    // One GET of the list spends no inference quota; a completion does. A model
    // the list has withdrawn since the last sync therefore leaves the catalogue
    // BEFORE the round asks anyone, and is never asked.
    let published = officialEntries()
    const probe = recordingProber()
    const fetchImpl = listFetch(() => published)
    const catalog = catalogWith({ dir, fetchImpl, probe })
    await catalog.forceRefresh()
    assert.equal(fetchImpl.calls.length, 1)

    published = published.filter((entry) => entry.id !== 'muse-spark-1.3-contributor-free')
    await catalog.forceProbes()
    assert.equal(fetchImpl.calls.length, 2, 'the round asked the list before it asked a model')
    assert.ok(!probe.calls.includes('muse-spark-1.3-contributor-free'), 'a withdrawn model is never asked')
    assert.ok(probe.calls.includes('big-pickle'), 'a listed model still is')
    assert.ok(!catalog.current().visible.includes('muse-spark-1.3-contributor-free'), 'and it leaves the picker')

    // It is not in the round at all: no row claims to have measured it, and the
    // tally covers exactly the models that were asked.
    const progress = catalog.probeProgress()
    assert.equal(progress.total, FREE_IDS.length - 1)
    assert.equal(progress.done, progress.total, 'done reaches total')
    assert.ok(!progress.targets.includes('muse-spark-1.3-contributor-free'))
    assert.equal(progress.results['muse-spark-1.3-contributor-free'], undefined)
    // A withdrawal is a fact about the list, not a verdict about the model.
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.probes['muse-spark-1.3-contributor-free'], undefined)
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
      fetchImpl: listFetch(),
      probe,
    })
    await waitFor(() => resynced.current().source === 'official')
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


test('a model the list puts back reappears: withdrawal is never a permanent verdict', async () => {
  await withTempDir(async (dir) => {
    // The failure mode this separation exists to prevent. A `dead` verdict is
    // permanent by decision, so a withdrawal must not be recorded as one —
    // otherwise a model that comes back stays suppressed for the life of the
    // cache file.
    const probe = recordingProber()
    let published = officialEntries().filter((entry) => entry.id !== 'muse-spark-1.3-contributor-free')
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, clock, fetchImpl: listFetch(() => published), probe })
    await catalog.forceRefresh()
    await catalog.forceProbes()
    assert.ok(!catalog.current().visible.includes('muse-spark-1.3-contributor-free'), 'absent while withdrawn')

    published = officialEntries()
    probe.calls.length = 0
    pastProbeFloor(clock)
    await catalog.forceProbes()
    assert.ok(catalog.current().visible.includes('muse-spark-1.3-contributor-free'), 'back on the next round')
    assert.ok(probe.calls.includes('muse-spark-1.3-contributor-free'), 'because it is asked, not remembered')
  })
})

test('a failed list request during a round narrows nothing and costs no verdict', async () => {
  await withTempDir(async (dir) => {
    // "Could not tell" is never "empty": one flaky GET must not be able to
    // empty the picker or to manufacture a removal. The round simply probes
    // the list it already holds.
    const failures = {
      'a rejected request': async () => {
        throw new Error('network down')
      },
      'an http error': async () => fakeResponse({ status: 503 }),
      'an unusable body': async () => fakeResponse({ body: { data: [] } }),
    }
    for (const [name, failure] of Object.entries(failures)) {
      await withTempDir(async (inner) => {
        let failing = false
        const fetchImpl = async (url, init) => (failing ? failure() : fakeResponse({ body: listBody() }))
        const probe = recordingProber()
        const catalog = catalogWith({ dir: inner, fetchImpl, probe })
        await catalog.forceRefresh()
        failing = true
        await catalog.forceProbes()
        assert.deepEqual(catalog.current().visible, DERIVED, `${name}: the list is untouched`)
        assert.equal(probe.calls.length, FREE_IDS.length, `${name}: every held model was asked`)
        assert.equal(catalog.current().source, 'official')
      })
    }
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
      hidden: (id) => id === off,
    })
    await waitFor(() => scoped.current().source === 'official')
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
    })
    // The warm start is fire-and-forget; probing before it lands reads an empty
    // verdict history, which is not what this test is about.
    await waitFor(() => reopened.current().source === 'official')
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
    })
    // The warm start is fire-and-forget: probing before it lands reads an
    // empty verdict history, and probing while it lands mutates the map
    // mid-round. Either way the assertion below is about a different thing.
    await waitFor(() => reopened.probeProgress().total > 0 || reopened.current().source === 'official')
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
    const reopened = catalogWith({ dir, fetchImpl: scriptedFetch([]), probe })
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
      fetchImpl: listFetch(),
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
      fetchImpl: listFetch(),
      probe,
    })
    await sameDay.forceRefresh()
    await sameDay.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'same local day: no second round')
    const nextDay = catalogWith({
      dir,
      clock: { t: new Date(2026, 8, 30, 0, 10, 0).getTime() },
      fetchImpl: listFetch(),
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
      probe: async () => {
        throw new Error('must not probe on a warm start')
      },
    })
    assert.equal(await waitFor(() => restarted.current().source === 'official'), true)
    assert.ok(!restarted.current().visible.includes('muse-spark-1.2-contributor-free'))
  })
})

test('a cache with no probes field is "never probed", not an error', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({ version: CACHE_VERSION, fetchedAt: 1_000_000, models: parseOfficialList(listBody()).free }),
      'utf8',
    )
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([]) })
    assert.equal(await waitFor(() => catalog.current().source === 'official'), true)
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

test('a verdict for a withdrawn model is kept, so the cache does not forget what a round paid for', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'space-bunny-free': DEAD(404) })
    let published = officialEntries()
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, clock, fetchImpl: listFetch(() => published), probe })
    await catalog.forceRefresh()
    await catalog.forceProbes()
    assert.ok(!catalog.current().visible.includes('space-bunny-free'))

    // Zen withdraws all but one. Every verdict is still on disk: membership is
    // recomputed from the list on every sync, but what a round learned about a
    // model is not the list's to take back.
    published = published.filter((entry) => entry.id === 'big-pickle' || !FREE_IDS.includes(entry.id))
    clock.t += 10
    await catalog.forceRefresh()
    assert.deepEqual(catalog.current().visible, ['big-pickle'])
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.deepEqual(Object.keys(onDisk.probes).sort(), DERIVED, 'the verdict for every withdrawn model is kept')
    assert.equal(onDisk.probes['space-bunny-free'].verdict, 'dead')
  })
})

test('a successful sync keeps the last round report and the verdicts on disk', async () => {
  // A sync is not a round and has nothing new to report — but its write replaces
  // the whole record, so omitting a field DELETES it. The assertion that the
  // sync really ran comes first: a guard test that never reaches the guarded
  // line is a vacuous assertion wearing the name of a guard.
  await withTempDir(async (dir) => {
    const clock = { t: 10_000_000 }
    const fetchImpl = listFetch()
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 60_000, probe: async () => ({ kind: 'ok' }) })
    await catalog.forceRefresh()
    await catalog.forceProbes()
    const total = catalog.probeProgress().total
    assert.ok(total > 0, 'the round ran')
    const before = fetchImpl.calls.length

    clock.t += 120_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, before + 1, 'a revalidation really ran')

    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.fetchedAt, clock.t, 'and it rewrote the file')
    assert.ok(onDisk.lastRound !== undefined, 'a sync must not erase the report')
    assert.equal(onDisk.lastRound.total, total, 'the report is the one the round wrote')
    assert.equal(Object.keys(onDisk.probes).length, total, 'nor the verdicts')
  })
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
// pass). The defect they cover is not hypothetical: the
// `runSingle` guard are the only things stopping a panel poll, a picker read
// and a probe round from each spending their own request, and the atomic write
// is the only thing standing between a crash and a silently truncated cache.

test('a poll and a probe round share ONE list request', async () => {
  // `ensureFresh()` and `runProbeRound()` reach the list at the same time
  // whenever the user opens the panel while a round starts. Without the
  // single-flight guard that is two `GET /models`, and the slower answer
  // overwrites the fresher one.
  await withTempDir(async (dir) => {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      await held
      return fakeResponse({ body: listBody() })
    }
    const probe = recordingProber()
    const catalog = catalogWith({ dir, fetchImpl, clock: { t: 10_000_000 }, probe })

    // Both paths reach the list before either is allowed to finish.
    const polling = catalog.ensureFresh()
    const round = catalog.forceProbes()
    await waitFor(() => calls >= 1)
    await tick()
    await tick()
    release()
    await Promise.all([polling, round])

    assert.equal(calls, 1, 'one GET /models answers both callers')
    assert.equal(probe.calls.length, FREE_IDS.length, 'and the round probed what that answer named')
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
      fetchImpl: listFetch(),
      probe,
    })
    await catalog.forceRefresh()

    await Promise.all([catalog.runProbes(), catalog.runProbes(), catalog.runProbes()])
    assert.equal(probe.calls.length, DERIVED.length, 'three callers, one round')

    await catalog.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'the daily gate still holds')
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
      fetchedAt: 1,
      models: [chat('big-pickle', { name: 'Big Pickle' })],
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
      fetchedAt: 1,
      models: [chat('big-pickle', { name: 'Big Pickle' })],
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

test('planRound asks about what is shown and unsettled, and nothing else', () => {
  const m = (id) => ({ id, name: id, api: 'openai-completions' })
  const models = [m('a'), m('b'), m('c'), m('d')]
  const probes = {
    a: { verdict: 'dead', at: 1, swept: true }, // earned → settled
    c: { verdict: 'dead', at: 1 }, // predates the sweep → re-checkable
    d: { verdict: 'ok', at: 1 }, // an answer is re-asked every round
  }
  const plan = (hidden) => planRound(models, probes, hidden).map((x) => x.id)

  assert.deepEqual(plan(undefined), ['b', 'c', 'd'], 'a settled death is not asked again; everything else is')
  assert.deepEqual(
    plan((id) => id === 'b' || id === 'c'),
    ['d'],
    'a model the user switched off costs a request nobody will read',
  )
  assert.deepEqual(plan(() => true), [], 'everything hidden asks nothing')
  assert.deepEqual(planRound([], probes, undefined), [])
  // The plan is a plain list of the catalogue's own records, in its own order.
  assert.equal(planRound(models, {}, undefined)[0], models[0])
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

test('the freshness rule is a plain function of its inputs', () => {
  const now = () => 1_000
  assert.equal(catalogueIsStale(500, now, 600), false)
  assert.equal(catalogueIsStale(500, now, 400), true)
  assert.equal(catalogueIsStale(1_000, now, 0), false, 'an answer from this instant is not older than itself')
  assert.equal(catalogueIsStale(0, now, 10_000_000), true, '"never fetched" is stale by definition, not by arithmetic')
  assert.equal(catalogueIsStale(now() - CATALOG_TTL_MS - 1, () => now(), CATALOG_TTL_MS), true)
})

test('the shared list is the catalogue minus settled deaths', () => {
  const m = (id) => ({ id, name: id, api: 'openai-completions' })
  const models = [m('a-free'), m('b'), m('c-free')]
  const list = (probes) => effectiveList(models, probes).map((x) => x.id)

  assert.deepEqual(list({}), ['a-free', 'b', 'c-free'], 'no verdicts, no narrowing')
  assert.deepEqual(list({ 'a-free': { verdict: 'dead', at: 1, swept: true } }), ['b', 'c-free'])
  assert.deepEqual(
    list({ b: { verdict: 'dead', at: 1 } }),
    ['a-free', 'c-free'],
    'a death drops out whether or not it has been swept; the sweep only decides whether it is asked again',
  )
  assert.deepEqual(list({ b: { verdict: 'ok', at: 1 } }), ['a-free', 'b', 'c-free'], 'an answer changes nothing')
  assert.deepEqual(list({ elsewhere: { verdict: 'dead', at: 1 } }), ['a-free', 'b', 'c-free'])
  assert.equal(models.length, 3, 'the catalogue itself is not narrowed')
})

test('a round can be driven with two plain objects', async () => {
  const state = initialState()
  state.models = ['a-free', 'b-free', 'c-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))

  const asked = []
  const deps = {
    path: join(tmpdir(), 'never-written-because-the-round-below-is-covered-elsewhere'),
    fetchImpl: async () => {
      throw new Error('no network in this test')
    },
    now: () => 1_700_000_000_000,
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

test('a round refuses to ask about a hidden model and leaves it out of scope', async () => {
  const state = initialState()
  state.models = ['a-free', 'b-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))

  const asked = []
  const base = {
    path: join(tmpdir(), 'never-written'),
    fetchImpl: async () => {
      throw new Error('no network')
    },
    now: () => 1_700_000_000_000,
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

  await runProbeRound(state, base)
  assert.deepEqual(asked, ['a-free'], 'only the shown model is spent a request on')
  // The hidden model is not merely unasked — it is out of scope entirely, so the
  // panel can say "skipped" rather than "waiting". A user who hid it never sees
  // a promise that it will be asked.
  assert.deepEqual(state.probeRun.targets, ['a-free'])
  assert.equal(state.probeRun.results['b-free'], undefined)

  asked.length = 0
  await runProbeRound(state, { ...base, hidden: undefined })
  assert.deepEqual(asked, ['a-free', 'b-free'], 'switched back on, it is asked')
})

test('a round that holds no list reads it first and probes what it names', async () => {
  await withTempDir(async (dir) => {
    const state = initialState()
    const asked = []
    const fetchImpl = listFetch()
    await runProbeRound(state, {
      path: join(dir, 'catalog.json'),
      fetchImpl,
      request: undefined,
      now: () => 1_700_000_000_000,
      ttlMs: 86_400_000,
      warmReadTimeoutMs: 2_000,
      warm: Promise.resolve(),
      template: template(),
      knownApis: undefined,
      probe: async (m) => {
        asked.push(m.id)
        return { kind: 'ok' }
      },
      hidden: undefined,
    })
    assert.equal(fetchImpl.calls.length, 1, 'one list request, before any model')
    assert.equal(state.source, 'official')
    assert.deepEqual(asked, DERIVED, 'every free model the list named, in id order')
    assert.equal(state.probeRun.done, DERIVED.length)
  })
})

test('a round that learns nothing leaves the picker alone', async () => {
  const state = initialState()
  state.models = ['a-free'].map((id) => ({ id, name: id, api: 'openai-completions' }))

  await runProbeRound(state, {
    path: join(tmpdir(), 'never-written'),
    fetchImpl: async () => {
      throw new Error('no network')
    },
    now: () => 1_700_000_000_000,
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
  const state = initialState()
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
    ttlMs: 86_400_000,
    warmReadTimeoutMs: 2_000,
    warm,
    template: state.models[0],
    knownApis: undefined,
    probe: async (m) => {
      asked.push(m.id)
      return { kind: 'ok' }
    },
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
    const fetchImpl = listFetch()

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
  // it: a builtin table entry, the list's own declaration, or a provider default. That
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
      fetchImpl: listFetch(),
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
    })
    await waitFor(() => restarted.current().source === 'official')
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
      fetchImpl: listFetch(),
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
      fetchImpl: listFetch(),
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
      channelFor(entryFor('deepseek-v4-flash-free')),
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
